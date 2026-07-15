#!/usr/bin/env tsx

import childProcess from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { fileURLToPath } from 'node:url';

import { scoreHermesWorkflow, type HermesWorkflowEvidence } from './command-eve-bonsai-hermes-eval-core';
import { COMMAND_EVE_BONSAI_MODEL_ID } from '../packages/desktop/src/process/commandEve/localInference/bonsaiManifest';
import {
  ensureBonsaiPilotServer,
  readBonsaiMemorySnapshot,
  stopBonsaiPilotServer,
} from '../packages/desktop/src/process/commandEve/localInference/bonsaiServer';

type Target = Readonly<{
  id: 'gemma-e4b' | 'gemma-12b' | 'bonsai-27b';
  model: string;
  baseUrl: string;
  apiKey?: string;
  context: number;
}>;

type Args = Readonly<{
  targets: Target['id'][];
  profile: 'focused' | 'command-eve';
  timeoutMs: number;
  output: string;
  userDataPath: string;
  autoDownload: boolean;
}>;

type ProcessResult = Readonly<{
  exitCode: number | null;
  timedOut: boolean;
  durationMs: number;
  stdout: string;
  stderr: string;
}>;

const HERMES_BINARY = path.join(
  os.homedir(),
  'Library',
  'Application Support',
  'Command EVE',
  'command-eve',
  'command-eve-runtime',
  'hermes',
  'venv',
  'bin',
  'hermes'
);
const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const MCP_SERVER_PATH = path.join(SCRIPT_DIR, 'fixtures', 'bonsai-eval-mcp-server.mjs');
const MAX_CAPTURE_BYTES = 2 * 1024 * 1024;

function readArg(name: string): string | undefined {
  const flag = `--${name}`;
  const index = process.argv.indexOf(flag);
  if (index >= 0) return process.argv[index + 1];
  const inline = process.argv.find((value) => value.startsWith(`${flag}=`));
  return inline?.slice(flag.length + 1);
}

function hasFlag(name: string): boolean {
  return process.argv.includes(`--${name}`);
}

function parseArgs(): Args {
  const requestedTargets = (readArg('targets') || 'gemma-e4b,gemma-12b,bonsai-27b')
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean);
  const allowedTargets = new Set<Target['id']>(['gemma-e4b', 'gemma-12b', 'bonsai-27b']);
  if (requestedTargets.some((target) => !allowedTargets.has(target as Target['id']))) {
    throw new Error('Unknown --targets value. Use gemma-e4b, gemma-12b, or bonsai-27b.');
  }
  const profile = readArg('profile') || 'focused';
  if (profile !== 'focused' && profile !== 'command-eve') {
    throw new Error('Unknown --profile value. Use focused or command-eve.');
  }
  const timeoutMs = Number(readArg('timeout-ms') || 900_000);
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 30_000) throw new Error('--timeout-ms must be at least 30000.');
  return {
    targets: requestedTargets as Target['id'][],
    profile,
    timeoutMs,
    output: path.resolve(
      readArg('output') ||
        path.join(process.cwd(), 'scripts', 'benchmark-results', 'command-eve-bonsai-hermes-latest.json')
    ),
    userDataPath: path.resolve(
      readArg('user-data') || path.join(os.homedir(), 'Library', 'Application Support', 'Command EVE', 'command-eve')
    ),
    autoDownload: !hasFlag('no-download'),
  };
}

function yamlString(value: string): string {
  return JSON.stringify(value);
}

function writePrivate(filePath: string, contents: string): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true, mode: 0o700 });
  fs.writeFileSync(filePath, contents, { encoding: 'utf8', mode: 0o600 });
  fs.chmodSync(filePath, 0o600);
}

function appendBounded(current: string, chunk: Buffer): string {
  if (current.length >= MAX_CAPTURE_BYTES) return current;
  return (current + chunk.toString('utf8')).slice(0, MAX_CAPTURE_BYTES);
}

function killProcessGroup(pid: number | undefined, signal: NodeJS.Signals): void {
  if (!pid) return;
  try {
    process.kill(-pid, signal);
  } catch {
    try {
      process.kill(pid, signal);
    } catch {
      // Process already exited.
    }
  }
}

async function runProcess(
  command: string,
  args: string[],
  options: {
    cwd: string;
    env: NodeJS.ProcessEnv;
    timeoutMs: number;
  }
): Promise<ProcessResult> {
  const started = performance.now();
  const child = childProcess.spawn(command, args, {
    cwd: options.cwd,
    env: options.env,
    detached: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stdout = '';
  let stderr = '';
  let timedOut = false;
  child.stdout.on('data', (chunk: Buffer) => {
    stdout = appendBounded(stdout, chunk);
  });
  child.stderr.on('data', (chunk: Buffer) => {
    stderr = appendBounded(stderr, chunk);
  });
  const exitCode = await new Promise<number | null>((resolve, reject) => {
    const timer = setTimeout(() => {
      timedOut = true;
      killProcessGroup(child.pid, 'SIGTERM');
      setTimeout(() => killProcessGroup(child.pid, 'SIGKILL'), 5_000).unref();
    }, options.timeoutMs);
    child.once('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once('exit', (code) => {
      clearTimeout(timer);
      resolve(code);
    });
  });
  return {
    exitCode,
    timedOut,
    durationMs: Math.round(performance.now() - started),
    stdout,
    stderr,
  };
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

function toolsets(profile: Args['profile']): string[] {
  return profile === 'command-eve' ? ['hermes-cli', 'eve-eval'] : ['terminal', 'file', 'eve-eval'];
}

function writeHermesConfig(args: {
  home: string;
  workspace: string;
  target: Target;
  fixturePath: string;
  auditPath: string;
  profile: Args['profile'];
}): void {
  const apiKeyLine = args.target.apiKey ? '  api_key: "${BONSAI_EVAL_API_KEY}"\n' : '';
  const lines = [
    'model:',
    '  provider: custom',
    `  default: ${yamlString(args.target.model)}`,
    `  base_url: ${yamlString(args.target.baseUrl)}`,
    apiKeyLine.trimEnd(),
    `  context_length: ${args.target.context}`,
    '  max_tokens: 2048',
    'agent:',
    '  reasoning_effort: low',
    '  max_turns: 12',
    'memory:',
    '  memory_enabled: false',
    '  user_profile_enabled: false',
    'skills:',
    '  creation_nudge_interval: 0',
    '  external_dirs: []',
    'platform_toolsets:',
    '  cli:',
    ...toolsets(args.profile).map((name) => `    - ${name}`),
    'mcp_servers:',
    '  eve-eval:',
    `    command: ${yamlString(process.execPath)}`,
    '    args:',
    `      - ${yamlString(MCP_SERVER_PATH)}`,
    `      - ${yamlString(args.fixturePath)}`,
    `      - ${yamlString(args.auditPath)}`,
    '    connect_timeout: 30',
    '    timeout: 60',
    'terminal:',
    `  cwd: ${yamlString(args.workspace)}`,
    '  timeout: 45',
    '',
  ].filter((line) => line !== '');
  writePrivate(path.join(args.home, 'config.yaml'), `${lines.join('\n')}\n`);
}

function readTrimmed(filePath: string): string | undefined {
  try {
    return fs.readFileSync(filePath, 'utf8').trim();
  } catch {
    return undefined;
  }
}

function readJson(filePath: string): Record<string, unknown> | undefined {
  try {
    const value = JSON.parse(fs.readFileSync(filePath, 'utf8')) as unknown;
    return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
  } catch {
    return undefined;
  }
}

function readAudit(filePath: string): Array<{ case_id?: string }> {
  try {
    return fs
      .readFileSync(filePath, 'utf8')
      .split(/\r?\n/)
      .filter(Boolean)
      .map((line) => JSON.parse(line) as { case_id?: string });
  } catch {
    return [];
  }
}

function safeChildEnv(extra: Record<string, string | undefined>): NodeJS.ProcessEnv {
  const allowed = ['HOME', 'USER', 'LOGNAME', 'PATH', 'SHELL', 'TMPDIR', 'LANG', 'LC_ALL', 'TERM'];
  return Object.fromEntries([
    ...allowed.flatMap((key) => (process.env[key] ? [[key, process.env[key]]] : [])),
    ...Object.entries(extra).filter(([, value]) => value !== undefined),
  ]);
}

async function evaluateHermesTarget(target: Target, args: Args): Promise<Record<string, unknown>> {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `command-eve-hermes-${target.id}-`));
  fs.chmodSync(root, 0o700);
  const home = path.join(root, 'home');
  const workspace = path.join(root, 'workspace');
  fs.mkdirSync(home, { recursive: true, mode: 0o700 });
  fs.mkdirSync(workspace, { recursive: true, mode: 0o700 });
  const caseId = `EVE-${crypto.randomBytes(4).toString('hex').toUpperCase()}`;
  const terminalNonce = crypto.randomBytes(18).toString('hex');
  const mcpToken = crypto.randomBytes(18).toString('hex');
  const inputPath = path.join(workspace, 'input.txt');
  const digestPath = path.join(workspace, 'digest.txt');
  const terminalProofPath = path.join(workspace, 'terminal-proof.txt');
  const resultPath = path.join(workspace, 'result.json');
  const fixturePath = path.join(root, 'case.json');
  const auditPath = path.join(root, 'mcp-audit.jsonl');
  const input = crypto.randomBytes(256);
  fs.writeFileSync(inputPath, input, { mode: 0o600 });
  const expectedDigest = crypto.createHash('sha256').update(input).digest('hex');
  const fixture = {
    case_id: caseId,
    mcp_token: mcpToken,
    priority: 'hoch',
    amount_eur: 1250,
    issue: 'Das Vertragsangebot endet heute.',
    recommended_action: 'Angebot pruefen und bis 16 Uhr antworten.',
  };
  writePrivate(fixturePath, `${JSON.stringify(fixture)}\n`);
  writeHermesConfig({ home, workspace, target, fixturePath, auditPath, profile: args.profile });
  const terminalCommand = `/usr/bin/printenv EVE_BONSAI_TERMINAL_NONCE > ${shellQuote(
    terminalProofPath
  )} && /usr/bin/shasum -a 256 ${shellQuote(inputPath)} > ${shellQuote(digestPath)}`;
  const prompt = `Fuehre diese gepruefte Command-EVE-Aufgabe vollstaendig aus.\n\n1. Rufe das MCP-Werkzeug lookup_case des Servers eve-eval exakt einmal mit case_id ${caseId} auf.\n2. Fuehre mit dem Terminal-Werkzeug exakt diesen Befehl aus:\n${terminalCommand}\n3. Lies ${digestPath} und ${terminalProofPath}. Schreibe danach mit einem Datei-Werkzeug valides JSON nach ${resultPath}. Pflichtfelder: case_id, mcp_token, sha256, terminal_nonce, priority, amount_eur, recommended_action. Nutze ausschliesslich die echten MCP- und Terminal-Ergebnisse.\n4. Antworte danach exakt in fuenf nicht-leeren Zeilen:\nEVE_HERMES_OK\nFall: ${caseId}\nPrioritaet: <priority aus MCP>\nBetrag: <amount_eur aus MCP> EUR\nEmpfehlung: <recommended_action aus MCP>\nKeine weitere Erklaerung.`;
  const startedMemory = readBonsaiMemorySnapshot();
  let processResult: ProcessResult;
  try {
    processResult = await runProcess(
      HERMES_BINARY,
      ['-z', prompt, '--provider', 'custom', '-m', target.model, '--ignore-rules'],
      {
        cwd: workspace,
        timeoutMs: args.timeoutMs,
        env: safeChildEnv({
          HERMES_HOME: home,
          HERMES_ACCEPT_HOOKS: '1',
          HERMES_YOLO_MODE: '1',
          BONSAI_EVAL_API_KEY: target.apiKey,
          EVE_BONSAI_TERMINAL_NONCE: terminalNonce,
        }),
      }
    );
    const audit = readAudit(auditPath);
    const digest = readTrimmed(digestPath)?.split(/\s+/)[0];
    const evidence: HermesWorkflowEvidence = {
      processExitCode: processResult.exitCode,
      timedOut: processResult.timedOut,
      mcpCallCount: audit.length,
      mcpCaseId: audit[0]?.case_id,
      expectedCaseId: caseId,
      terminalProof: readTrimmed(terminalProofPath),
      expectedTerminalProof: terminalNonce,
      digest,
      expectedDigest,
      artifact: readJson(resultPath),
      finalResponse: processResult.stdout.trim(),
      expected: {
        mcpToken,
        priority: fixture.priority,
        amountEur: fixture.amount_eur,
        recommendedAction: fixture.recommended_action,
      },
    };
    const score = scoreHermesWorkflow(evidence);
    return {
      target: { id: target.id, model: target.model, base_url: target.baseUrl, context: target.context },
      profile: args.profile,
      duration_ms: processResult.durationMs,
      exit_code: processResult.exitCode,
      timed_out: processResult.timedOut,
      score,
      final_response: processResult.stdout.trim(),
      stderr_tail: processResult.stderr.slice(-4_000),
      memory_before: startedMemory,
      memory_after: readBonsaiMemorySnapshot(),
    };
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

async function unloadOllamaModels(): Promise<void> {
  try {
    const response = await fetch('http://127.0.0.1:11434/api/ps', { signal: AbortSignal.timeout(3_000) });
    if (!response.ok) return;
    const value = (await response.json()) as { models?: Array<{ name?: string }> };
    for (const model of value.models || []) {
      if (!model.name) continue;
      await fetch('http://127.0.0.1:11434/api/generate', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ model: model.name, keep_alive: 0 }),
        signal: AbortSignal.timeout(10_000),
      }).catch(() => undefined);
    }
  } catch {
    // Ollama is optional when only Bonsai is selected.
  }
}

function baselineTarget(id: 'gemma-e4b' | 'gemma-12b'): Target {
  return {
    id,
    model: id === 'gemma-e4b' ? 'command-eve-gemma4-e4b-64k:latest' : 'command-eve-gemma4-12b-64k:latest',
    baseUrl: 'http://127.0.0.1:11434/v1',
    context: 65_536,
  };
}

function writeReceipt(filePath: string, value: unknown): void {
  const serialized = `${JSON.stringify(value, null, 2)}\n`;
  if (/api[_-]?key|authorization|BONSAI_EVAL_API_KEY/i.test(serialized)) {
    throw new Error('Refusing to write a Hermes eval receipt containing authentication material.');
  }
  writePrivate(filePath, serialized);
}

async function main(): Promise<void> {
  const args = parseArgs();
  if (!fs.existsSync(HERMES_BINARY)) throw new Error(`Hermes binary not found at ${HERMES_BINARY}`);
  const results: Record<string, unknown>[] = [];
  try {
    for (const id of args.targets) {
      await unloadOllamaModels();
      let target: Target;
      if (id === 'bonsai-27b') {
        const server = await ensureBonsaiPilotServer({
          userDataPath: args.userDataPath,
          autoProvision: args.autoDownload,
          contextSize: 65_536,
        });
        target = {
          id,
          model: COMMAND_EVE_BONSAI_MODEL_ID,
          baseUrl: server.baseUrl,
          apiKey: server.apiKey,
          context: 65_536,
        };
      } else {
        target = baselineTarget(id);
      }
      console.log(`[hermes-eval] ${id} (${args.profile})`);
      results.push(await evaluateHermesTarget(target, args));
      if (id === 'bonsai-27b') await stopBonsaiPilotServer();
    }
  } finally {
    await stopBonsaiPilotServer();
    await unloadOllamaModels();
  }
  const receipt = {
    version: 'command-eve-bonsai-hermes-eval/v0',
    observed_at: new Date().toISOString(),
    machine: {
      model: childProcess.spawnSync('/usr/sbin/sysctl', ['-n', 'hw.model'], { encoding: 'utf8' }).stdout.trim(),
      memory_bytes: os.totalmem(),
      architecture: process.arch,
    },
    profile: args.profile,
    results,
  };
  writeReceipt(args.output, receipt);
  console.log(`[hermes-eval] receipt ${args.output}`);
  for (const result of results) {
    const score = result.score as { score?: number; maxScore?: number; hardPass?: boolean };
    console.log(
      `[hermes-eval] ${(result.target as { id?: string }).id}: ${score.score}/${score.maxScore} hardPass=${score.hardPass}`
    );
  }
}

main().catch(async (error) => {
  await stopBonsaiPilotServer().catch(() => undefined);
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});

#!/usr/bin/env tsx

import childProcess from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { performance } from 'node:perf_hooks';

import {
  evaluateBonsaiPromotion,
  scoreConstraintList,
  scoreContextRecall,
  scoreLongForm,
  scoreToolRoundtrip,
  summarizeModelScores,
  type EvalTaskScore,
} from './command-eve-bonsai-eval-core';
import {
  BONSAI_MODEL_ARTIFACT,
  BONSAI_RUNTIME_ARTIFACT,
  BONSAI_RUNTIME_RELEASE,
  COMMAND_EVE_BONSAI_MODEL_ID,
} from '../packages/desktop/src/process/commandEve/localInference/bonsaiManifest';
import { ensureBonsaiPilotArtifacts } from '../packages/desktop/src/process/commandEve/localInference/bonsaiProvisioner';
import {
  ensureBonsaiPilotServer,
  readBonsaiMemorySnapshot,
  stopBonsaiPilotServer,
  type BonsaiMemorySnapshot,
  type BonsaiPilotServer,
} from '../packages/desktop/src/process/commandEve/localInference/bonsaiServer';

type Provider = 'ollama' | 'openai';

type Target = Readonly<{
  id: string;
  provider: Provider;
  baseUrl: string;
  model: string;
  context: number;
  apiKey?: string;
  digest?: string;
  pid?: number;
}>;

type ReceiptTarget = Omit<Target, 'apiKey'>;

type ToolCall = Readonly<{ id: string; name: string; arguments: string }>;

type ChatResult = Readonly<{
  ok: boolean;
  content: string;
  finishReason?: string;
  toolCalls: ToolCall[];
  totalMs: number;
  error?: string;
  rawAssistant?: Record<string, unknown>;
}>;

type LatencyResult = Readonly<{
  ok: boolean;
  firstEventMs?: number;
  firstContentMs?: number;
  totalMs: number;
  outputChars: number;
  error?: string;
}>;

type TaskReceipt = Readonly<{
  sample: number;
  task: EvalTaskScore['task'];
  score: EvalTaskScore;
  requests: ChatResult[];
}>;

type TargetReceipt = Readonly<{
  target: ReceiptTarget;
  latency: LatencyResult;
  tasks: TaskReceipt[];
  summary: ReturnType<typeof summarizeModelScores>;
  memory_before: BonsaiMemorySnapshot;
  memory_after: BonsaiMemorySnapshot;
  pageout_bytes: number;
  active_model_bytes?: number;
  process_tree_rss_bytes?: number;
}>;

type Args = Readonly<{
  userDataPath: string;
  output: string;
  samples: number;
  timeoutMs: number;
  context: number;
  autoDownload: boolean;
  provisionOnly: boolean;
  resumePartial: boolean;
  baselineModels: string[];
}>;

const TERMINAL_MARKER = '<EVE_DONE_42>';
const REQUIRED_HEADINGS = ['# Ausgangslage', '# Empfehlung', '# Risiken', '# Nächste Schritte'];
const CONTEXT_CANARY = 'EVE-CANARY-7Q4-MARMOR';
const MAX_PAGEOUT_BYTES = 1024 ** 3;
const MAX_CHAT_RESPONSE_BYTES = 16 * 1024 * 1024;

function readArg(name: string): string | undefined {
  const flag = `--${name}`;
  const index = process.argv.indexOf(flag);
  if (index >= 0) return process.argv[index + 1];
  const inline = process.argv.find((arg) => arg.startsWith(`${flag}=`));
  return inline?.slice(flag.length + 1);
}

function hasFlag(name: string): boolean {
  return process.argv.includes(`--${name}`);
}

function positiveInt(name: string, fallback: number): number {
  const value = Number(readArg(name));
  return Number.isSafeInteger(value) && value > 0 ? value : fallback;
}

function defaultUserDataPath(): string {
  return path.join(os.homedir(), 'Library', 'Application Support', 'Command EVE', 'command-eve');
}

function parseArgs(): Args {
  if (hasFlag('help') || hasFlag('h')) {
    console.log(`Usage: bun run command-eve:pilot:bonsai -- [options]

  --provision-only       Verify/download pinned artifacts and stop.
  --user-data PATH       Command EVE user-data root.
  --samples N            Samples per model (default: 2).
  --context N            Context size (default: 16384).
  --timeout-ms N         Per request timeout (default: 600000).
  --baselines a,b        Ollama models to compare.
  --no-download          Refuse network provisioning.
  --resume-partial       Reuse structurally valid completed model results from OUTPUT.partial.
  --output PATH          JSON evidence receipt.
`);
    process.exit(0);
  }
  return {
    userDataPath: path.resolve(readArg('user-data') || defaultUserDataPath()),
    output:
      readArg('output') ||
      path.join(process.cwd(), 'scripts', 'benchmark-results', 'command-eve-bonsai-pilot-latest.json'),
    samples: positiveInt('samples', 2),
    timeoutMs: positiveInt('timeout-ms', 600_000),
    context: Math.min(32_768, Math.max(4_096, positiveInt('context', 16_384))),
    autoDownload: !hasFlag('no-download'),
    provisionOnly: hasFlag('provision-only'),
    resumePartial: hasFlag('resume-partial'),
    baselineModels: (readArg('baselines') || 'command-eve-gemma4-e4b-64k:latest,command-eve-gemma4-12b-64k:latest')
      .split(',')
      .map((item) => item.trim())
      .filter(Boolean),
  };
}

function authHeaders(target: Target): Record<string, string> {
  return target.apiKey
    ? { 'content-type': 'application/json', authorization: `Bearer ${target.apiKey}` }
    : { 'content-type': 'application/json' };
}

function toReceiptTarget(target: Target): ReceiptTarget {
  return {
    id: target.id,
    provider: target.provider,
    baseUrl: target.baseUrl,
    model: target.model,
    context: target.context,
    digest: target.digest,
    pid: target.pid,
  };
}

async function postLoopbackJson(args: {
  endpoint: string;
  headers: Record<string, string>;
  body: string;
  timeoutMs: number;
}): Promise<{ statusCode: number; body: string }> {
  const endpoint = new URL(args.endpoint);
  if (endpoint.protocol !== 'http:' || endpoint.hostname !== '127.0.0.1') {
    throw new Error('PILOT_HTTP_ENDPOINT_NOT_LOOPBACK');
  }
  return await new Promise((resolve, reject) => {
    const request = http.request(
      endpoint,
      {
        method: 'POST',
        headers: {
          ...args.headers,
          'content-length': String(Buffer.byteLength(args.body)),
        },
        signal: AbortSignal.timeout(args.timeoutMs),
      },
      (response) => {
        const chunks: Buffer[] = [];
        let receivedBytes = 0;
        response.on('data', (chunk: Buffer) => {
          receivedBytes += chunk.length;
          if (receivedBytes > MAX_CHAT_RESPONSE_BYTES) {
            response.destroy(new Error('PILOT_HTTP_RESPONSE_TOO_LARGE'));
            return;
          }
          chunks.push(chunk);
        });
        response.once('error', reject);
        response.once('end', () => {
          resolve({
            statusCode: response.statusCode || 0,
            body: Buffer.concat(chunks).toString('utf8'),
          });
        });
      }
    );
    request.once('error', reject);
    request.end(args.body);
  });
}

function normalizedToolCalls(message: Record<string, unknown> | undefined): ToolCall[] {
  const calls = Array.isArray(message?.tool_calls) ? message.tool_calls : [];
  return calls.flatMap((value, index) => {
    if (!value || typeof value !== 'object') return [];
    const call = value as { id?: unknown; function?: { name?: unknown; arguments?: unknown } };
    const name = typeof call.function?.name === 'string' ? call.function.name : '';
    if (!name) return [];
    const rawArgs = call.function?.arguments;
    return [
      {
        id: typeof call.id === 'string' && call.id ? call.id : `call_${index}`,
        name,
        arguments: typeof rawArgs === 'string' ? rawArgs : JSON.stringify(rawArgs || {}),
      },
    ];
  });
}

async function requestChat(args: {
  target: Target;
  messages: Array<Record<string, unknown>>;
  maxTokens: number;
  timeoutMs: number;
  tools?: Array<Record<string, unknown>>;
}): Promise<ChatResult> {
  const started = performance.now();
  try {
    const endpoint =
      args.target.provider === 'ollama' ? `${args.target.baseUrl}/api/chat` : `${args.target.baseUrl}/chat/completions`;
    const payload =
      args.target.provider === 'ollama'
        ? {
            model: args.target.model,
            messages: args.messages,
            stream: false,
            think: false,
            keep_alive: '10m',
            tools: args.tools,
            options: {
              num_ctx: args.target.context,
              num_predict: args.maxTokens,
              temperature: 0,
              seed: 42,
            },
          }
        : {
            model: args.target.model,
            messages: args.messages,
            stream: false,
            max_tokens: args.maxTokens,
            temperature: 0,
            seed: 42,
            reasoning_format: 'auto',
            thinking_budget_tokens: Math.min(512, Math.max(0, Math.floor(args.maxTokens / 2))),
            reasoning_control: true,
            chat_template_kwargs: { enable_thinking: true },
            tools: args.tools,
            tool_choice: args.tools ? 'auto' : undefined,
          };
    const response = await postLoopbackJson({
      endpoint,
      headers: authHeaders(args.target),
      body: JSON.stringify(payload),
      timeoutMs: args.timeoutMs,
    });
    if (response.statusCode < 200 || response.statusCode >= 300) {
      throw new Error(`HTTP_${response.statusCode}${response.body ? `:${response.body.slice(0, 500)}` : ''}`);
    }
    const json = JSON.parse(response.body) as {
      message?: Record<string, unknown>;
      done_reason?: string;
      choices?: Array<{ finish_reason?: string; message?: Record<string, unknown> }>;
    };
    const message = (args.target.provider === 'ollama' ? json.message : json.choices?.[0]?.message) || {};
    return {
      ok: true,
      content: typeof message.content === 'string' ? message.content : '',
      finishReason: args.target.provider === 'ollama' ? json.done_reason : json.choices?.[0]?.finish_reason,
      toolCalls: normalizedToolCalls(message),
      totalMs: Math.round(performance.now() - started),
      rawAssistant: message,
    };
  } catch (error) {
    return {
      ok: false,
      content: '',
      toolCalls: [],
      totalMs: Math.round(performance.now() - started),
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

async function streamLatency(target: Target, timeoutMs: number): Promise<LatencyResult> {
  const started = performance.now();
  let firstEventMs: number | undefined;
  let firstContentMs: number | undefined;
  let outputChars = 0;
  try {
    const endpoint = target.provider === 'ollama' ? `${target.baseUrl}/api/chat` : `${target.baseUrl}/chat/completions`;
    const body =
      target.provider === 'ollama'
        ? {
            model: target.model,
            messages: [{ role: 'user', content: 'Antworte exakt: EVE bereit.' }],
            stream: true,
            think: false,
            keep_alive: '10m',
            options: { num_ctx: target.context, num_predict: 64, temperature: 0, seed: 42 },
          }
        : {
            model: target.model,
            messages: [{ role: 'user', content: 'Antworte exakt: EVE bereit.' }],
            stream: true,
            max_tokens: 64,
            temperature: 0,
            seed: 42,
            reasoning_format: 'none',
            thinking_budget_tokens: 0,
            reasoning_control: true,
            chat_template_kwargs: { enable_thinking: false },
          };
    const response = await fetch(endpoint, {
      method: 'POST',
      headers: authHeaders(target),
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!response.ok || !response.body) throw new Error(`HTTP_${response.status}`);
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      firstEventMs ??= Math.round(performance.now() - started);
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split(/\r?\n/);
      buffer = lines.pop() || '';
      for (const line of lines) {
        const raw = target.provider === 'openai' ? line.replace(/^data:\s*/, '') : line;
        if (!raw || raw === '[DONE]') continue;
        const parsed = JSON.parse(raw) as {
          message?: { content?: string; thinking?: string };
          choices?: Array<{ delta?: { content?: string; reasoning_content?: string } }>;
        };
        const eventText =
          target.provider === 'ollama'
            ? parsed.message?.content || parsed.message?.thinking || ''
            : parsed.choices?.[0]?.delta?.content || parsed.choices?.[0]?.delta?.reasoning_content || '';
        if (eventText) {
          firstContentMs ??= Math.round(performance.now() - started);
          outputChars += eventText.length;
        }
      }
    }
    return {
      ok: outputChars > 0,
      firstEventMs,
      firstContentMs,
      totalMs: Math.round(performance.now() - started),
      outputChars,
      error: outputChars > 0 ? undefined : 'EMPTY_STREAM',
    };
  } catch (error) {
    return {
      ok: false,
      firstEventMs,
      firstContentMs,
      totalMs: Math.round(performance.now() - started),
      outputChars,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

function contextDocument(): string {
  const filler = Array.from(
    { length: 240 },
    (_, index) => `Abschnitt ${index + 1}: Der operative Status ist stabil; Referenz ${String(index).padStart(3, '0')}.`
  ).join('\n');
  return `Interne Referenz am Anfang: ${CONTEXT_CANARY}\n${filler}\nEnde des Dokuments.`;
}

async function runTasks(target: Target, sample: number, timeoutMs: number): Promise<TaskReceipt[]> {
  const tasks: TaskReceipt[] = [];
  const longPrompt = `Schreibe eine belastbare deutsche Entscheidungsvorlage für die Einführung eines KI-Assistenten in einem kleinen Betrieb. Nutze exakt diese Überschriften: ${REQUIRED_HEADINGS.join(', ')}. Erkläre konkret, keine Tabellen. Der Text muss mindestens 1.500 Zeichen lang sein. Beende nach dem letzten Satz exakt mit ${TERMINAL_MARKER}.`;
  const longResult = await requestChat({
    target,
    messages: [{ role: 'user', content: longPrompt }],
    maxTokens: 2_048,
    timeoutMs,
  });
  tasks.push({
    sample,
    task: 'long_form',
    requests: [longResult],
    score: scoreLongForm({
      content: longResult.content,
      finishReason: longResult.finishReason,
      terminalMarker: TERMINAL_MARKER,
      requiredHeadings: REQUIRED_HEADINGS,
    }),
  });

  const tool = {
    type: 'function',
    function: {
      name: 'add_numbers',
      description: 'Add two integer values.',
      parameters: {
        type: 'object',
        properties: { a: { type: 'integer' }, b: { type: 'integer' } },
        required: ['a', 'b'],
        additionalProperties: false,
      },
    },
  };
  const toolMessages: Array<Record<string, unknown>> = [
    { role: 'user', content: 'Berechne 19 plus 23. Nutze zwingend das bereitgestellte Werkzeug.' },
  ];
  const toolCall = await requestChat({ target, messages: toolMessages, maxTokens: 512, timeoutMs, tools: [tool] });
  const firstCall = toolCall.toolCalls[0];
  let toolFinal: ChatResult = {
    ok: false,
    content: '',
    toolCalls: [],
    totalMs: 0,
    error: 'TOOL_CALL_MISSING',
  };
  if (firstCall && toolCall.rawAssistant) {
    toolFinal = await requestChat({
      target,
      messages: [
        ...toolMessages,
        { role: 'assistant', ...toolCall.rawAssistant },
        { role: 'tool', tool_call_id: firstCall.id, name: firstCall.name, content: '{"result":42}' },
      ],
      maxTokens: 512,
      timeoutMs,
      tools: [tool],
    });
  }
  tasks.push({
    sample,
    task: 'tool_roundtrip',
    requests: [toolCall, toolFinal],
    score: scoreToolRoundtrip({
      finishReason: toolCall.finishReason,
      toolName: firstCall?.name,
      toolArguments: firstCall?.arguments,
      finalContent: toolFinal.content,
      finalFinishReason: toolFinal.finishReason,
    }),
  });

  const constraintResult = await requestChat({
    target,
    messages: [
      {
        role: 'user',
        content:
          'Nenne exakt sieben Risiken eines unkontrollierten KI-Rollouts. Ausgabe nur als sieben nummerierte Zeilen. Jede Zeile muss direkt nach der Nummer mit [RISIKO] beginnen. Keine Einleitung, kein Fazit.',
      },
    ],
    maxTokens: 768,
    timeoutMs,
  });
  tasks.push({
    sample,
    task: 'constraint_list',
    requests: [constraintResult],
    score: scoreConstraintList({ content: constraintResult.content, finishReason: constraintResult.finishReason }),
  });

  const contextResult = await requestChat({
    target,
    messages: [
      {
        role: 'user',
        content: `${contextDocument()}\n\nGib ausschließlich die exakte interne Referenz aus dem ersten Satz zurück. Keine Erklärung, keine Satzzeichen ergänzen.`,
      },
    ],
    maxTokens: 128,
    timeoutMs,
  });
  tasks.push({
    sample,
    task: 'context_recall',
    requests: [contextResult],
    score: scoreContextRecall({
      content: contextResult.content,
      finishReason: contextResult.finishReason,
      canary: CONTEXT_CANARY,
    }),
  });
  return tasks;
}

function pageoutDelta(before: BonsaiMemorySnapshot, after: BonsaiMemorySnapshot): number {
  return Math.max(0, after.pageouts - before.pageouts) * after.pageSizeBytes;
}

function processTreeRssBytes(rootPid: number | undefined): number | undefined {
  if (!rootPid) return undefined;
  const result = childProcess.spawnSync('/bin/ps', ['-axo', 'pid=,ppid=,rss='], { encoding: 'utf8' });
  if (result.status !== 0) return undefined;
  const rows = (result.stdout || '')
    .split(/\r?\n/)
    .map((line) => line.trim().split(/\s+/).map(Number))
    .filter((parts) => parts.length === 3 && parts.every(Number.isFinite)) as number[][];
  const pids = new Set([rootPid]);
  let changed = true;
  while (changed) {
    changed = false;
    for (const [pid, ppid] of rows) {
      if (pids.has(ppid) && !pids.has(pid)) {
        pids.add(pid);
        changed = true;
      }
    }
  }
  return rows.filter(([pid]) => pids.has(pid)).reduce((sum, [, , rssKb]) => sum + rssKb * 1024, 0);
}

async function ollamaTags(): Promise<Map<string, string>> {
  const response = await fetch('http://127.0.0.1:11434/api/tags', { signal: AbortSignal.timeout(5_000) });
  if (!response.ok) throw new Error(`OLLAMA_TAGS_HTTP_${response.status}`);
  const json = (await response.json()) as { models?: Array<{ name?: string; digest?: string }> };
  return new Map((json.models || []).flatMap((item) => (item.name ? [[item.name, item.digest || '']] : [])));
}

async function ollamaActiveModelBytes(model: string): Promise<number | undefined> {
  const response = await fetch('http://127.0.0.1:11434/api/ps', { signal: AbortSignal.timeout(5_000) }).catch(
    (): undefined => undefined
  );
  if (!response?.ok) return undefined;
  const json = (await response.json()) as { models?: Array<{ name?: string; size?: number; size_vram?: number }> };
  const active = (json.models || []).find((item) => item.name === model);
  return active ? Number(active.size_vram || active.size || 0) || undefined : undefined;
}

async function unloadOllama(): Promise<void> {
  const response = await fetch('http://127.0.0.1:11434/api/ps', { signal: AbortSignal.timeout(5_000) }).catch(
    (): undefined => undefined
  );
  if (!response?.ok) return;
  const json = (await response.json()) as { models?: Array<{ name?: string }> };
  for (const model of json.models || []) {
    if (!model.name) continue;
    await fetch('http://127.0.0.1:11434/api/generate', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: model.name, keep_alive: 0 }),
      signal: AbortSignal.timeout(10_000),
    }).catch((): undefined => undefined);
  }
}

async function evaluateTarget(target: Target, args: Args): Promise<TargetReceipt> {
  const before = readBonsaiMemorySnapshot();
  const latency = await streamLatency(target, args.timeoutMs);
  const tasks: TaskReceipt[] = [];
  for (let sample = 1; sample <= args.samples; sample += 1) {
    console.log(`[bonsai-pilot] ${target.id}: sample ${sample}/${args.samples}`);
    tasks.push(...(await runTasks(target, sample, args.timeoutMs)));
  }
  const after = readBonsaiMemorySnapshot();
  return {
    target: toReceiptTarget(target),
    latency,
    tasks,
    summary: summarizeModelScores(
      target.id,
      tasks.map((task) => task.score)
    ),
    memory_before: before,
    memory_after: after,
    pageout_bytes: pageoutDelta(before, after),
    active_model_bytes: target.provider === 'ollama' ? await ollamaActiveModelBytes(target.model) : undefined,
    process_tree_rss_bytes: processTreeRssBytes(target.pid),
  };
}

function isProcessGone(pid: number): boolean {
  const result = childProcess.spawnSync('/bin/ps', ['-p', String(pid), '-o', 'pid='], { encoding: 'utf8' });
  return result.status !== 0 || !(result.stdout || '').trim();
}

function writeReceipt(output: string, receipt: unknown): void {
  const serialized = `${JSON.stringify(receipt, null, 2)}\n`;
  if (/"(?:apiKey|authorization)"\s*:/.test(serialized)) {
    throw new Error('RECEIPT_SECRET_FIELD_FORBIDDEN');
  }
  fs.mkdirSync(path.dirname(output), { recursive: true });
  fs.writeFileSync(output, serialized, { encoding: 'utf8', mode: 0o600 });
}

function readPartialTargets(filePath: string, args: Args): TargetReceipt[] {
  if (!args.resumePartial) return [];
  try {
    const value = JSON.parse(fs.readFileSync(filePath, 'utf8')) as {
      version?: string;
      complete?: boolean;
      targets?: TargetReceipt[];
    };
    if (
      value.version !== 'command-eve-bonsai-pilot-eval-partial/v0' ||
      value.complete !== false ||
      !Array.isArray(value.targets)
    ) {
      throw new Error('invalid partial receipt header');
    }
    const allowedIds = new Set(args.baselineModels.map((model) => `ollama:${model}`));
    const targets = value.targets.filter((target) => {
      const tasks = Array.isArray(target?.tasks) ? target.tasks : [];
      return (
        allowedIds.has(target?.target?.id) &&
        target.target.context === args.context &&
        tasks.length === args.samples * 4 &&
        tasks.every((task) => task?.score && Array.isArray(task.requests))
      );
    });
    console.log(`[bonsai-pilot] resumed ${targets.length} completed baseline result(s) from ${filePath}`);
    return targets;
  } catch (error) {
    throw new Error(`PARTIAL_RECEIPT_INVALID:${error instanceof Error ? error.message : String(error)}`);
  }
}

async function main(): Promise<void> {
  const args = parseArgs();
  const partialOutput = `${args.output}.partial`;
  const provisioned = await ensureBonsaiPilotArtifacts({
    userDataPath: args.userDataPath,
    autoDownload: args.autoDownload,
    onProgress: (progress) => console.log(`[bonsai-pilot] ${progress.message}`),
  });
  if (args.provisionOnly) {
    writeReceipt(args.output, {
      version: 'command-eve-bonsai-pilot-provision/v0',
      created_at: new Date().toISOString(),
      receipt: provisioned.receipt,
    });
    console.log(`[bonsai-pilot] provision receipt: ${args.output}`);
    return;
  }

  const tags = await ollamaTags();
  for (const model of args.baselineModels) {
    if (!tags.has(model)) throw new Error(`BASELINE_MODEL_MISSING:${model}`);
  }

  const targetReceipts: TargetReceipt[] = readPartialTargets(partialOutput, args);
  for (const model of args.baselineModels) {
    if (targetReceipts.some((item) => item.target.id === `ollama:${model}`)) continue;
    await unloadOllama();
    targetReceipts.push(
      await evaluateTarget(
        {
          id: `ollama:${model}`,
          provider: 'ollama',
          baseUrl: 'http://127.0.0.1:11434',
          model,
          context: args.context,
          digest: tags.get(model),
        },
        args
      )
    );
    writeReceipt(partialOutput, {
      version: 'command-eve-bonsai-pilot-eval-partial/v0',
      created_at: new Date().toISOString(),
      complete: false,
      targets: targetReceipts,
    });
  }
  await unloadOllama();

  let server: BonsaiPilotServer | undefined;
  let cleanupPass = false;
  try {
    server = await ensureBonsaiPilotServer({
      userDataPath: args.userDataPath,
      autoProvision: false,
      contextSize: args.context,
    });
    targetReceipts.push(
      await evaluateTarget(
        {
          id: 'bonsai:27b-q2',
          provider: 'openai',
          baseUrl: server.baseUrl,
          model: server.model,
          context: args.context,
          apiKey: server.apiKey,
          digest: BONSAI_MODEL_ARTIFACT.sha256,
          pid: server.pid,
        },
        args
      )
    );
    writeReceipt(partialOutput, {
      version: 'command-eve-bonsai-pilot-eval-partial/v0',
      created_at: new Date().toISOString(),
      complete: false,
      targets: targetReceipts,
    });
  } finally {
    const pid = server?.pid;
    await stopBonsaiPilotServer();
    cleanupPass = pid ? isProcessGone(pid) : false;
  }

  const bonsai = targetReceipts.find((item) => item.target.id === 'bonsai:27b-q2');
  if (!bonsai) throw new Error('BONSAI_RESULT_MISSING');
  const baselines = targetReceipts.filter((item) => item.target.provider === 'ollama');
  const memoryPass =
    bonsai.pageout_bytes <= MAX_PAGEOUT_BYTES &&
    bonsai.memory_after.freePercent >= 7 &&
    bonsai.process_tree_rss_bytes !== undefined;
  const promotion = evaluateBonsaiPromotion({
    bonsai: bonsai.summary,
    baselines: baselines.map((item) => item.summary),
    cleanupPass,
    memoryPass,
  });
  const receipt = {
    version: 'command-eve-bonsai-pilot-eval/v0',
    created_at: new Date().toISOString(),
    host: {
      platform: process.platform,
      arch: process.arch,
      total_memory_bytes: os.totalmem(),
      cpu: os.cpus()[0]?.model,
    },
    pins: {
      runtime: BONSAI_RUNTIME_ARTIFACT,
      runtime_release: BONSAI_RUNTIME_RELEASE,
      model: BONSAI_MODEL_ARTIFACT,
      model_alias: COMMAND_EVE_BONSAI_MODEL_ID,
    },
    args: {
      samples: args.samples,
      context: args.context,
      timeout_ms: args.timeoutMs,
      baseline_models: args.baselineModels,
    },
    targets: targetReceipts,
    gates: {
      cleanup_pass: cleanupPass,
      memory_pass: memoryPass,
      visible_picker: promotion,
    },
  };
  writeReceipt(args.output, receipt);
  fs.rmSync(partialOutput, { force: true });
  console.table(
    targetReceipts.map((item) => ({
      target: item.target.id,
      score: `${item.summary.score.toFixed(1)}/${item.summary.maxScore}`,
      ratio: `${Math.round(item.summary.scoreRatio * 100)}%`,
      hardPass: item.summary.hardPass,
      firstContentMs: item.latency.firstContentMs,
      pageoutMb: Math.round(item.pageout_bytes / 1024 ** 2),
    }))
  );
  console.log(`[bonsai-pilot] visible picker gate: ${promotion.visiblePickerPass ? 'PASS' : 'BLOCKED'}`);
  console.log(`[bonsai-pilot] eval receipt: ${args.output}`);
  if (!bonsai.summary.hardPass || !cleanupPass || !memoryPass) process.exitCode = 1;
}

void main().catch(async (error) => {
  await stopBonsaiPilotServer().catch((): undefined => undefined);
  console.error('[bonsai-pilot]', error);
  process.exit(1);
});

/**
 * Windows-only execution proof for the Command EVE worker boundary. The suite
 * is collected on every host and runs automatically on the private Windows 11
 * lab: pause gate, read-only ACP filtering, credential scrubbing, and Job
 * Object process-tree cleanup.
 */

import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const IS_WINDOWS = process.platform === 'win32';
const POWERSHELL = 'powershell.exe';
const LAUNCHER = path.join(process.cwd(), 'resources', 'eve-acp-launcher', 'eve-acp-launcher.ps1');

interface RunningLauncher {
  child: ChildProcessWithoutNullStreams;
  stdout: () => string;
  stderr: () => string;
  closed: Promise<number | null>;
}

function startLauncher(
  dir: string,
  status: 'active' | 'paused' | 'off',
  adapterSource: string,
  parentEnv: Record<string, string> = {}
): RunningLauncher {
  const statusFile = path.join(dir, 'role.status');
  const tokenFile = path.join(dir, 'role.token');
  const adapterFile = path.join(dir, 'adapter.ps1');
  const proofFile = path.join(dir, 'proof.json');
  const mcpConfigFile = path.join(dir, 'mcp.json');
  fs.writeFileSync(statusFile, status);
  fs.writeFileSync(tokenFile, 'WINDOWS-LEASE-TOKEN');
  fs.writeFileSync(adapterFile, adapterSource);
  fs.writeFileSync(mcpConfigFile, '{"mcpServers":{"mutation":{"command":"unsafe.exe"}}}');

  const child = spawn(
    POWERSHELL,
    [
      '-NoLogo',
      '-NoProfile',
      '-NonInteractive',
      '-ExecutionPolicy',
      'Bypass',
      '-File',
      LAUNCHER,
      '--role',
      'growth-lead',
      '--status-file',
      statusFile,
      '--token-file',
      tokenFile,
      '--mcp-config',
      mcpConfigFile,
      '--timeout-seconds',
      '120',
      '--read-only',
      '--',
      POWERSHELL,
      '-NoLogo',
      '-NoProfile',
      '-NonInteractive',
      '-ExecutionPolicy',
      'Bypass',
      '-File',
      adapterFile,
      '-ProofFile',
      proofFile,
    ],
    {
      env: { ...process.env, ...parentEnv },
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    }
  );
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (chunk) => (stdout += chunk.toString()));
  child.stderr.on('data', (chunk) => (stderr += chunk.toString()));
  const closed = new Promise<number | null>((resolve, reject) => {
    child.once('error', reject);
    child.once('close', (code) => resolve(code));
  });
  return { child, stdout: () => stdout, stderr: () => stderr, closed };
}

async function withDeadline<T>(promise: Promise<T>, child: ChildProcessWithoutNullStreams, timeoutMs = 20_000) {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_, reject) => {
        timer = setTimeout(() => {
          child.kill();
          reject(new Error(`Windows launcher test exceeded ${timeoutMs}ms`));
        }, timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function waitForFile(filePath: string, timeoutMs = 15_000): Promise<void> {
  const found = await pollUntil(() => fs.existsSync(filePath), Date.now() + timeoutMs, 50);
  if (!found) throw new Error(`Timed out waiting for ${path.basename(filePath)}`);
}

async function pollUntil(predicate: () => boolean, deadline: number, intervalMs: number): Promise<boolean> {
  if (predicate()) return true;
  if (Date.now() >= deadline) return false;
  await new Promise((resolve) => setTimeout(resolve, intervalMs));
  return pollUntil(predicate, deadline, intervalMs);
}

function processExists(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

describe('eve-acp-launcher.ps1 - source security contract', () => {
  it('scrubs Desktop-owned delegate transport before starting the adapter', () => {
    const source = fs.readFileSync(LAUNCHER, 'utf8');
    expect(source).toContain("'HERMES_COPILOT_ACP_COMMAND'");
    expect(source).toContain("'HERMES_COPILOT_ACP_ARGS'");
    expect(source).toContain("'COMMAND_EVE_LAUNCHER_DIR'");
    expect(source).toContain('StandardOutputEncoding = $Utf8NoBom');
    expect(source).toContain('$StartInfo.EnvironmentVariables.Clear()');
    expect(source).toContain('CommandEveBoundedLineReader');
    expect(source).toContain('CommandEveBoundedLineWriter');
    expect(source).toContain('$MaxProtocolLineCharacters');
    expect(source).toContain("Set-ProtocolProperty $ClientCapabilities 'terminal' $false");
    expect(source).toContain("'terminal/create'");
    expect(source).toContain("Get-ProtocolProperty $Message 'id'");
    expect(source).toContain('read-only ACP adapter line was not valid JSON');
  });
});

describe.skipIf(!IS_WINDOWS)('eve-acp-launcher.ps1 - Windows 11 execution proof', () => {
  let dir = '';
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'eve-win-launcher-'));
  });
  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('fails closed before the adapter starts when the role is paused', async () => {
    const proofFile = path.join(dir, 'proof.json');
    const running = startLauncher(
      dir,
      'paused',
      "param([string]$ProofFile)\n[IO.File]::WriteAllText($ProofFile, 'started')\n"
    );
    running.child.stdin.end();
    expect(await withDeadline(running.closed, running.child)).toBe(3);
    expect(fs.existsSync(proofFile)).toBe(false);
    expect(running.stdout()).toBe('');
  });

  it('forces ACP read-only and scrubs application credentials while preserving the scoped lease', async () => {
    const proofFile = path.join(dir, 'proof.json');
    const adapter = `param([string]$ProofFile)
$Utf8 = [System.Text.UTF8Encoding]::new($false)
[Console]::InputEncoding = $Utf8
[Console]::OutputEncoding = $Utf8
$InitializeLine = [Console]::In.ReadLine()
$Initialize = $InitializeLine | ConvertFrom-Json
$SessionLine = [Console]::In.ReadLine()
$Session = $SessionLine | ConvertFrom-Json
$WriteRequest = @{ jsonrpc = '2.0'; id = 99; method = 'fs/write_text_file'; params = @{ path = 'blocked.txt'; content = 'blocked' } } | ConvertTo-Json -Compress
[Console]::Out.WriteLine($WriteRequest)
[Console]::Out.Flush()
$BlockedResponse = ([Console]::In.ReadLine() | ConvertFrom-Json)
$TerminalRequest = @{ jsonrpc = '2.0'; id = 100; method = 'terminal/create'; params = @{ command = 'cmd.exe'; sessionId = 'blocked' } } | ConvertTo-Json -Compress
[Console]::Out.WriteLine($TerminalRequest)
[Console]::Out.Flush()
$BlockedTerminalResponse = ([Console]::In.ReadLine() | ConvertFrom-Json)
$BlockedNotification = @{ jsonrpc = '2.0'; method = 'fs/delete'; params = @{ path = 'blocked.txt' } } | ConvertTo-Json -Compress
[Console]::Out.WriteLine($BlockedNotification)
[Console]::Out.Flush()
$Proof = @{
  agent = $env:EVE_AGENT_ID
  lease = $env:EVE_LEASE_TOKEN
  writeCapability = [bool]$Initialize.params.clientCapabilities.fs.writeTextFile
  terminalCapability = [bool]$Initialize.params.clientCapabilities.terminal
  tools = @($Session.params._meta.claudeCode.options.tools)
  disallowedTools = @($Session.params._meta.claudeCode.options.disallowedTools)
  settingSourceCount = @($Session.params._meta.claudeCode.options.settingSources).Count
  mcpServerCount = @($Session.params.mcpServers).Count
  optionMcpServerCount = @($Session.params._meta.claudeCode.options.mcpServers.PSObject.Properties).Count
  additionalDirectoryCount = @($Session.params.additionalDirectories).Count
  optionAdditionalDirectoryCount = @($Session.params._meta.claudeCode.options.additionalDirectories).Count
  metaMarker = [string]$Session.params._meta.marker
  claudeMcpConfig = [string]$env:CLAUDE_MCP_CONFIG
  hermesAcpCommand = [string]$env:HERMES_COPILOT_ACP_COMMAND
  hermesAcpArgs = [string]$env:HERMES_COPILOT_ACP_ARGS
  launcherDir = [string]$env:COMMAND_EVE_LAUNCHER_DIR
  blockedCode = [int]$BlockedResponse.error.code
  blockedTerminalCode = [int]$BlockedTerminalResponse.error.code
  unicodeMarker = [string]$Session.params._meta.unicodeMarker
  teamBearer = [string]$env:COMMAND_EVE_TEAM_MANAGE_BEARER
  kanbanBearer = [string]$env:COMMAND_EVE_KANBAN_ACP_BEARER
  appKey = [string]$env:COMMAND_EVE_ASSISTANT_KEY
  futureProviderKey = [string]$env:FUTURE_PROVIDER_API_KEY
} | ConvertTo-Json -Compress
[IO.File]::WriteAllText($ProofFile, $Proof)
[Console]::Out.WriteLine('{"jsonrpc":"2.0","id":1,"result":{"ok":true,"text":"Grüße 🚀"}}')
[Console]::Out.Flush()
`;
    const running = startLauncher(dir, 'active', adapter, {
      COMMAND_EVE_TEAM_MANAGE_BEARER: 'TEAM-SECRET',
      COMMAND_EVE_KANBAN_ACP_BEARER: 'KANBAN-SECRET',
      COMMAND_EVE_ASSISTANT_KEY: 'APP-SECRET',
      HERMES_COPILOT_ACP_COMMAND: 'HOST-TRANSPORT-COMMAND',
      HERMES_COPILOT_ACP_ARGS: 'HOST-TRANSPORT-ARGS',
      COMMAND_EVE_LAUNCHER_DIR: 'C:\\private-launcher',
      FUTURE_PROVIDER_API_KEY: 'FUTURE-SECRET',
    });
    running.child.stdin.write(
      `${JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: { clientCapabilities: { fs: { readTextFile: true, writeTextFile: true } } },
      })}\n`
    );
    running.child.stdin.write(
      `${JSON.stringify({
        jsonrpc: '2.0',
        id: 2,
        method: 'session/new',
        params: {
          cwd: 'C:\\candidate',
          mcpServers: [{ name: 'mutation', command: 'unsafe.exe', args: [] }],
          additionalDirectories: ['C:\\private'],
          _meta: {
            marker: 'preserved',
            unicodeMarker: 'Grüße 🚀',
            claudeCode: {
              options: {
                tools: { type: 'preset', preset: 'claude_code' },
                disallowedTools: [],
                settingSources: ['user', 'project', 'local'],
                mcpServers: { mutation: { command: 'unsafe.exe' } },
                additionalDirectories: ['C:\\private'],
              },
            },
          },
        },
      })}\n`
    );

    expect(await withDeadline(running.closed, running.child)).toBe(0);
    const proof = JSON.parse(fs.readFileSync(proofFile, 'utf8')) as Record<string, unknown>;
    expect(proof).toMatchObject({
      agent: 'growth-lead',
      lease: 'WINDOWS-LEASE-TOKEN',
      writeCapability: false,
      terminalCapability: false,
      tools: ['Read', 'Glob', 'Grep'],
      settingSourceCount: 0,
      mcpServerCount: 0,
      optionMcpServerCount: 0,
      additionalDirectoryCount: 0,
      optionAdditionalDirectoryCount: 0,
      metaMarker: 'preserved',
      claudeMcpConfig: '',
      hermesAcpCommand: '',
      hermesAcpArgs: '',
      launcherDir: '',
      blockedCode: -32604,
      blockedTerminalCode: -32604,
      unicodeMarker: 'Grüße 🚀',
      teamBearer: '',
      kanbanBearer: '',
      appKey: '',
      futureProviderKey: '',
    });
    expect(proof.disallowedTools).toEqual(
      expect.arrayContaining(['Write', 'Edit', 'MultiEdit', 'NotebookEdit', 'Bash', 'Task', 'Agent', 'ComputerUse'])
    );
    expect(running.stdout()).toContain('"ok":true');
    expect(running.stdout()).toContain('Grüße 🚀');
    expect(running.stdout()).not.toContain('fs/write_text_file');
    expect(running.stdout()).not.toContain('terminal/create');
    expect(running.stdout()).not.toContain('fs/delete');
  });

  it('fails closed instead of forwarding malformed client protocol lines', async () => {
    const proofFile = path.join(dir, 'proof.json');
    const adapter = `param([string]$ProofFile)
$Line = [Console]::In.ReadLine()
if ($null -ne $Line) { [IO.File]::WriteAllText($ProofFile, $Line) }
`;
    const running = startLauncher(dir, 'active', adapter);
    running.child.stdin.end('not-json\n');
    expect(await withDeadline(running.closed, running.child)).toBe(2);
    expect(fs.existsSync(proofFile)).toBe(false);
    expect(running.stdout()).toBe('');
    expect(running.stderr()).toContain('worker boundary failed closed');
  });

  it('fails closed instead of forwarding malformed adapter protocol lines', async () => {
    const adapter = `param([string]$ProofFile)
[Console]::Out.WriteLine('not-json')
[Console]::Out.Flush()
Start-Sleep -Seconds 300
`;
    const running = startLauncher(dir, 'active', adapter);
    running.child.stdin.end();
    expect(await withDeadline(running.closed, running.child)).toBe(2);
    expect(running.stdout()).toBe('');
    expect(running.stderr()).toContain('worker boundary failed closed');
  });

  it('kills the complete adapter tree when the launcher is terminated', async () => {
    const proofFile = path.join(dir, 'proof.json');
    const adapter = `param([string]$ProofFile)
$null = [Console]::In.ReadLine()
$Info = New-Object System.Diagnostics.ProcessStartInfo
$Info.FileName = 'powershell.exe'
$Info.Arguments = '-NoLogo -NoProfile -NonInteractive -Command "Start-Sleep -Seconds 300"'
$Info.UseShellExecute = $false
$Info.CreateNoWindow = $true
$Grandchild = [System.Diagnostics.Process]::Start($Info)
[IO.File]::WriteAllText($ProofFile, [string]$Grandchild.Id)
while ($true) { Start-Sleep -Seconds 1 }
`;
    const running = startLauncher(dir, 'active', adapter);
    running.child.stdin.write('{"jsonrpc":"2.0","method":"ping"}\n');
    await waitForFile(proofFile);
    const grandchildPid = Number(fs.readFileSync(proofFile, 'utf8'));
    expect(Number.isSafeInteger(grandchildPid)).toBe(true);
    expect(processExists(grandchildPid)).toBe(true);

    running.child.kill();
    await withDeadline(running.closed, running.child);
    await pollUntil(() => !processExists(grandchildPid), Date.now() + 8_000, 100);
    if (processExists(grandchildPid)) {
      spawn('taskkill.exe', ['/PID', String(grandchildPid), '/T', '/F'], { windowsHide: true });
    }
    expect(processExists(grandchildPid)).toBe(false);
  });
});

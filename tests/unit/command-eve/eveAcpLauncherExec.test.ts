/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * SG-1 A3/A8 — CI proof of the ACTUAL launcher script. The kill-switch probe lived
 * in a scratchpad; this brings the three load-bearing behaviours into the suite:
 * pause-gate (exit 3 on paused/off, adapter never spawned), env injection
 * (EVE_AGENT_ID/EVE_LEASE_TOKEN reach the child), and transparent stdio (the
 * launcher is silent on stdout; a JSON line round-trips through the exec'd adapter).
 * Invoked via `/bin/sh <launcher>` exactly as wrapClaudeDelegateWithLauncher emits.
 */

import { spawn } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const LAUNCHER = path.join(process.cwd(), 'resources', 'eve-acp-launcher', 'eve-acp-launcher.sh');
const isMac = process.platform === 'darwin' || process.platform === 'linux'; // POSIX sh + exec

interface RunResult {
  code: number | null;
  stdout: string;
  proof: { EVE_AGENT_ID?: string; EVE_LEASE_TOKEN?: string; BEARER?: string; STATUS_FILE?: string; TOKEN_FILE?: string } | null;
}

function runLauncher(
  dir: string,
  status: string,
  token: string,
  line?: string,
  parentEnv?: Record<string, string>,
  skipStatusFile = false
): Promise<RunResult> {
  const statusFile = path.join(dir, 'st');
  const tokenFile = path.join(dir, 'tok');
  const proofFile = path.join(dir, 'proof.json');
  const adapter = path.join(dir, 'adapter.sh');
  if (!skipStatusFile) fs.writeFileSync(statusFile, status);
  fs.writeFileSync(tokenFile, token, { mode: 0o600 });
  // Deterministic fake ACP adapter as a POSIX-sh script (NOT a node process — a
  // node/electron spawn per case is heavy enough to starve the rest of the suite
  // under full parallel load and time out unrelated tests). It dumps the injected
  // env to a side file, then echoes each stdin line and exits on EOF. No timers.
  fs.writeFileSync(
    adapter,
    `printf '{"EVE_AGENT_ID":"%s","EVE_LEASE_TOKEN":"%s","BEARER":"%s","STATUS_FILE":"%s","TOKEN_FILE":"%s"}' "$EVE_AGENT_ID" "$EVE_LEASE_TOKEN" "$COMMAND_EVE_TEAM_MANAGE_BEARER" "$STATUS_FILE" "$TOKEN_FILE" > "$PROOF_FILE"
while IFS= read -r l; do printf 'echo:%s\\n' "$l"; done`
  );
  const args = [LAUNCHER, '--role', 'growth-lead', '--status-file', statusFile, '--token-file', tokenFile, '--', '/bin/sh', adapter];
  return new Promise((resolve, reject) => {
    const child = spawn('/bin/sh', args, { env: { ...process.env, ...parentEnv, PROOF_FILE: proofFile }, stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '';
    child.stdout.on('data', (d) => (stdout += d.toString()));
    child.on('error', reject);
    child.on('close', (code) => {
      const proof = fs.existsSync(proofFile) ? JSON.parse(fs.readFileSync(proofFile, 'utf8')) : null;
      resolve({ code, stdout, proof });
    });
    // Write the (optional) line, then close stdin immediately — the adapter echoes
    // on EOF and exits, so no timing race regardless of system load.
    if (line) child.stdin.write(line + '\n');
    child.stdin.end();
  });
}

describe.skipIf(!isMac)('eve-acp-launcher.sh — CI exec proof (A3/A8)', () => {
  let dir = '';
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'eve-launch-exec-'));
  });
  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('the launcher script exists in the committed resources', () => {
    expect(fs.existsSync(LAUNCHER)).toBe(true);
  });

  it('A3 pause-gate: a paused status refuses exec (exit 3, adapter never spawned)', async () => {
    const r = await runLauncher(dir, 'paused', 'SECRET-TOKEN');
    expect(r.code).toBe(3);
    expect(r.proof).toBeNull(); // adapter never wrote its proof → never ran
    expect(r.stdout).toBe(''); // silent on stdout
  });

  it('A3 pause-gate: an off status refuses exec too', async () => {
    const r = await runLauncher(dir, 'off', 'SECRET-TOKEN');
    expect(r.code).toBe(3);
    expect(r.proof).toBeNull();
  });

  it('A8 env injection: an active status execs the adapter with EVE_AGENT_ID + EVE_LEASE_TOKEN', async () => {
    const r = await runLauncher(dir, 'active', 'SECRET-LEASE-abc');
    expect(r.code).toBe(0);
    expect(r.proof).not.toBeNull();
    expect(r.proof?.EVE_AGENT_ID).toBe('growth-lead');
    expect(r.proof?.EVE_LEASE_TOKEN).toBe('SECRET-LEASE-abc');
  });

  it('A8 transparent stdio: a JSON line round-trips through the exec\'d adapter', async () => {
    const r = await runLauncher(dir, 'active', 'tok', '{"jsonrpc":"2.0","id":1}');
    expect(r.code).toBe(0);
    expect(r.stdout).toContain('echo:{"jsonrpc":"2.0","id":1}');
  });

  it('token is read whitespace-stripped (tr -d), matching the registry invariant', async () => {
    const r = await runLauncher(dir, 'active', '  tok-with-space  \n');
    expect(r.proof?.EVE_LEASE_TOKEN).toBe('tok-with-space');
  });

  it('SCRUBS the bearer + control-file paths from the delegated worker env (review + EVE-audit fixes)', async () => {
    // The parent env carries the operator bearer (as EVE's runtime would); the
    // delegated adapter must NOT inherit it, nor the pause-gate control-file paths.
    const r = await runLauncher(dir, 'active', 'tok', undefined, { COMMAND_EVE_TEAM_MANAGE_BEARER: 'operator-secret-bearer' });
    expect(r.code).toBe(0);
    expect(r.proof).not.toBeNull();
    // Injected role/token still arrive…
    expect(r.proof?.EVE_AGENT_ID).toBe('growth-lead');
    // …but the operator bearer + the status/token file paths were scrubbed.
    expect(r.proof?.BEARER ?? '').toBe('');
    expect(r.proof?.STATUS_FILE ?? '').toBe('');
    expect(r.proof?.TOKEN_FILE ?? '').toBe('');
  });

  it('A3 fail-CLOSED: an EXPECTED status file that is missing refuses exec (exit 3) — a deleted control file cannot re-enable a paused role', async () => {
    // --status-file is passed but the file does not exist (deleted / cleaned up).
    const r = await runLauncher(dir, 'active', 'tok', undefined, undefined, /* skipStatusFile */ true);
    expect(r.code).toBe(3);
    expect(r.proof).toBeNull(); // adapter never spawned
  });
});

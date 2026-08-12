/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { session } from 'electron';

import {
  COMMAND_EVE_BROWSER_CONTEXT_SCHEMA,
  emptyBrowserWorkbenchState,
  normalizeBrowserWorkbenchState,
  type CommandEveBrowserWorkbenchState,
} from '@/common/config/browserWorkbenchStateCore';
import type { BrowserControlLease, CommandEveBrowserControlContext } from '@/common/config/browserWorkbenchControlCore';
import { readAccountSession } from '@process/commandEve/accountSessionAtRest';
import { readCompanyBrainSeedState } from '@process/commandEve/companyBrainSeedCore';
import { getActiveSeatId } from '@process/commandEve/seatContextCore';
import { getCdpBridgeHandle } from '@process/resources/builtinMcp/cdpBridgeRegistry';

const RUNTIME_SCHEMA = 'command-eve-browser-use-runtime/v1' as const;
const CONTEXT_ROOT = 'browser-workbench';
const CONTEXT_SALT_FILE = 'context-key';
const ACTIVE_CONTEXT_FILE = 'active-context.json';
const CONTEXT_ID_RE = /^[a-f0-9]{32}$/;
const guestContextId = `guest-${crypto.randomBytes(12).toString('hex')}`;

let userDataRoot: string | null = null;
let activeDescriptor: CommandEveBrowserControlContext | null = null;

type RuntimeContextRecord = {
  schema_version: typeof RUNTIME_SCHEMA;
  context_id: string;
  control_epoch: string;
  daemon_name: string;
  cdp_url: string;
  runtime_dir: string;
  tmp_dir: string;
};

const ensurePrivateDir = (dir: string): void => {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const stat = fs.lstatSync(dir);
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw new Error(`Refusing unsafe browser runtime directory: ${dir}`);
  }
  if (process.platform !== 'win32') {
    if (typeof process.getuid === 'function' && stat.uid !== process.getuid()) {
      throw new Error(`Refusing browser runtime directory owned by another user: ${dir}`);
    }
    fs.chmodSync(dir, 0o700);
  }
};

const writeFileAtomic600 = (file: string, contents: string | NodeJS.ArrayBufferView): void => {
  ensurePrivateDir(path.dirname(file));
  const temp = `${file}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(temp, contents, { mode: 0o600, flag: 'wx' });
  fs.renameSync(temp, file);
  if (process.platform !== 'win32') fs.chmodSync(file, 0o600);
};

const rootFor = (userDataPath: string): string =>
  path.join(path.resolve(userDataPath), 'command-eve-runtime', CONTEXT_ROOT);

const contextDir = (userDataPath: string, contextId: string): string => {
  if (!CONTEXT_ID_RE.test(contextId)) throw new Error('Persistent browser context id is invalid.');
  return path.join(rootFor(userDataPath), 'contexts', contextId);
};

const stateFile = (userDataPath: string, contextId: string): string =>
  path.join(contextDir(userDataPath, contextId), 'state.json');

const contextFile = (userDataPath: string): string => path.join(rootFor(userDataPath), ACTIVE_CONTEXT_FILE);

const readOrCreateSalt = (userDataPath: string): Buffer => {
  const file = path.join(rootFor(userDataPath), CONTEXT_SALT_FILE);
  try {
    const value = fs.readFileSync(file);
    if (value.length === 32) return value;
  } catch {
    // Create below.
  }
  const value = crypto.randomBytes(32);
  writeFileAtomic600(file, value);
  return value;
};

const readState = (userDataPath: string, contextId: string): CommandEveBrowserWorkbenchState => {
  try {
    return normalizeBrowserWorkbenchState(JSON.parse(fs.readFileSync(stateFile(userDataPath, contextId), 'utf8')));
  } catch {
    return emptyBrowserWorkbenchState();
  }
};

const resolveIdentity = (userDataPath: string): { persistent: boolean; contextId: string } => {
  const e2eAccount = process.env.AIONUI_E2E_TEST === '1' ? process.env.COMMAND_EVE_E2E_BROWSER_ACCOUNT_ID : undefined;
  const e2eSeed = process.env.AIONUI_E2E_TEST === '1' ? process.env.COMMAND_EVE_E2E_BROWSER_SEED_ID : undefined;

  const stored = readAccountSession(userDataPath);
  const accountId = e2eAccount?.trim() || (stored.ok ? stored.session?.user.id : undefined);
  if (!accountId) return { persistent: false, contextId: guestContextId };

  const seatId = getActiveSeatId();
  const seedState = readCompanyBrainSeedState({ userDataPath, seatId });
  const seedMaterial = e2eSeed?.trim()
    ? `e2e:${e2eSeed.trim()}`
    : seedState.seeded && seedState.record
      ? JSON.stringify({
          seat_id: seatId,
          seeded_at: seedState.record.seeded_at,
          kind: seedState.record.kind,
          value: seedState.record.value,
        })
      : `unseeded:${seatId}`;
  const digest = crypto
    .createHmac('sha256', readOrCreateSalt(userDataPath))
    .update(accountId)
    .update('\0')
    .update(seedMaterial)
    .digest('hex')
    .slice(0, 32);
  return { persistent: true, contextId: digest };
};

const runtimeDirs = (contextId: string): { runtimeDir: string; tmpDir: string } => {
  // Browser Harness uses AF_UNIX sockets on macOS/Linux, whose path budget is
  // much shorter than Electron's /var/folders/... userData path. Keep only a
  // non-reversible context digest in a private short directory.
  const digest = crypto.createHash('sha256').update(contextId).digest('hex').slice(0, 16);
  const uid = typeof process.getuid === 'function' ? process.getuid() : process.pid;
  const shortTmpRoot = process.platform === 'win32' ? os.tmpdir() : '/tmp';
  const base = path.join(shortTmpRoot, `cebu-${uid}-${digest}`);
  return { runtimeDir: path.join(base, 'r'), tmpDir: path.join(base, 't') };
};

const buildDescriptor = (userDataPath: string, controlEpoch: string): CommandEveBrowserControlContext => {
  const identity = resolveIdentity(userDataPath);
  const daemonName = `eve_${identity.contextId.replace(/[^A-Za-z0-9_-]/g, '').slice(0, 48)}`;
  return {
    schema_version: COMMAND_EVE_BROWSER_CONTEXT_SCHEMA,
    context_id: identity.contextId,
    control_epoch: controlEpoch,
    partition: `${identity.persistent ? 'persist:' : ''}command-eve-browser-${identity.contextId}`,
    persistent: identity.persistent,
    daemon_name: daemonName,
    state: identity.persistent ? readState(userDataPath, identity.contextId) : emptyBrowserWorkbenchState(),
  };
};

const writeRuntimeContext = (userDataPath: string, descriptor: CommandEveBrowserControlContext, cdpUrl: string) => {
  const dirs = runtimeDirs(descriptor.context_id);
  ensurePrivateDir(path.dirname(dirs.runtimeDir));
  ensurePrivateDir(dirs.runtimeDir);
  ensurePrivateDir(dirs.tmpDir);
  const record: RuntimeContextRecord = {
    schema_version: RUNTIME_SCHEMA,
    context_id: descriptor.context_id,
    control_epoch: descriptor.control_epoch,
    daemon_name: descriptor.daemon_name,
    cdp_url: cdpUrl,
    runtime_dir: dirs.runtimeDir,
    tmp_dir: dirs.tmpDir,
  };
  const file = contextFile(userDataPath);
  writeFileAtomic600(file, `${JSON.stringify(record, null, 2)}\n`);
  process.env.COMMAND_EVE_BROWSER_CONTEXT_FILE = file;
  // Backward-compatible fallback for an older Hermes wheel. The reviewed
  // adapter reads the context file per call so account/seed switches do not
  // depend on this process-start snapshot.
  process.env.BROWSER_CDP_URL = cdpUrl;
};

export function initializeBrowserWorkbenchContext(userDataPath: string): CommandEveBrowserControlContext {
  userDataRoot = path.resolve(userDataPath);
  return refreshBrowserWorkbenchContext();
}

export function refreshBrowserWorkbenchContext(): CommandEveBrowserControlContext {
  if (!userDataRoot) throw new Error('Browser workbench context is not initialized.');
  const controlEpoch = crypto.randomBytes(16).toString('hex');
  const next = buildDescriptor(userDataRoot, controlEpoch);
  const bridge = getCdpBridgeHandle();
  if (!bridge) throw new Error('Visible browser CDP bridge is not initialized.');
  const activation = bridge.activateContext(next.context_id, next.partition, next.control_epoch);
  writeRuntimeContext(userDataRoot, next, activation.cdpUrl);
  activeDescriptor = next;
  return next;
}

export function getBrowserWorkbenchContext(): CommandEveBrowserControlContext {
  if (!activeDescriptor) return refreshBrowserWorkbenchContext();
  const resolved = buildDescriptor(userDataRoot!, activeDescriptor.control_epoch);
  if (
    resolved.context_id !== activeDescriptor.context_id ||
    resolved.partition !== activeDescriptor.partition ||
    resolved.persistent !== activeDescriptor.persistent
  ) {
    return refreshBrowserWorkbenchContext();
  }
  activeDescriptor = resolved;
  return resolved;
}

export function saveBrowserWorkbenchState(contextId: string, value: unknown): CommandEveBrowserControlContext {
  const descriptor = getBrowserWorkbenchContext();
  if (!descriptor.persistent || contextId !== descriptor.context_id) {
    throw new Error('Browser state context mismatch; refusing cross-account or cross-seed write.');
  }
  const state = normalizeBrowserWorkbenchState(value);
  writeFileAtomic600(stateFile(userDataRoot!, descriptor.context_id), `${JSON.stringify(state, null, 2)}\n`);
  activeDescriptor = { ...descriptor, state };
  return activeDescriptor;
}

export async function revokeActiveBrowserWorkbenchContext(): Promise<CommandEveBrowserControlContext | null> {
  if (!activeDescriptor || !userDataRoot) return null;
  const revoked = activeDescriptor;
  getCdpBridgeHandle()?.deactivateContext(revoked.context_id, revoked.control_epoch);
  let storageError: unknown;
  try {
    const partitionSession = session.fromPartition(revoked.partition);
    await partitionSession.clearStorageData();
    await partitionSession.clearCache();
    await partitionSession.clearCodeCaches({});
  } catch (error) {
    storageError = error;
  }
  if (revoked.persistent && CONTEXT_ID_RE.test(revoked.context_id)) {
    fs.rmSync(contextDir(userDataRoot, revoked.context_id), { recursive: true, force: true });
  }
  const dirs = runtimeDirs(revoked.context_id);
  fs.rmSync(path.dirname(dirs.runtimeDir), { recursive: true, force: true });
  fs.rmSync(contextFile(userDataRoot), { force: true });
  activeDescriptor = null;
  delete process.env.BROWSER_CDP_URL;
  if (storageError) {
    const message = storageError instanceof Error ? storageError.message : String(storageError);
    throw new Error(`Browser context capability was revoked, but partition storage cleanup failed: ${message}`);
  }
  return revoked;
}

export function attachVisibleBrowserWebContents(
  webContentsId: number,
  contextId: string,
  controlEpoch: string
): { ok: true; leaseId: string } | { ok: false; reason: string } {
  const descriptor = getBrowserWorkbenchContext();
  if (contextId !== descriptor.context_id || controlEpoch !== descriptor.control_epoch) {
    return { ok: false, reason: 'Browser context or control epoch mismatch; stale webview refused.' };
  }
  const bridge = getCdpBridgeHandle();
  if (!bridge) return { ok: false, reason: 'Visible browser control is not available.' };
  return bridge.attach(webContentsId, contextId, controlEpoch);
}

export function releaseVisibleBrowserWebContents(
  lease: BrowserControlLease
): { ok: true } | { ok: false; reason: string } {
  if (
    !activeDescriptor ||
    lease.contextId !== activeDescriptor.context_id ||
    lease.controlEpoch !== activeDescriptor.control_epoch
  ) {
    return { ok: false, reason: 'Browser control lease belongs to a retired context epoch.' };
  }
  const bridge = getCdpBridgeHandle();
  if (!bridge) return { ok: false, reason: 'Visible browser control is not available.' };
  return bridge.release(lease);
}

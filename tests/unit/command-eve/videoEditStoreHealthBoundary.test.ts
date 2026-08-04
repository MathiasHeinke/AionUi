/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * MAT-1747 round 5 — A RESTART MUST NEVER REVIVE SPENDABILITY.
 *
 * The residual round 4 pinned and did not close, in its own words: when the
 * DURABLE deny write is exactly what failed, the deny exists only in a
 * module-level Set in Main. Restart the app and that Set is gone — while the
 * permit record it was compensating for is still on disk, still inside its
 * fifteen-minute window, with a turn pointer that also survived. The wallet
 * re-opens by itself, and nothing in the app notices.
 *
 * The answer is not a bigger deny. It is that LIVE SPEND AUTHORITY DOES NOT
 * SURVIVE A PROCESS BOUNDARY AT ALL:
 *
 *   - a permit record, an active-turn pointer and an in-flight edit lock are
 *     LIVE AUTHORITIES. Store reinitialization deletes every one of them;
 *   - a consumed claim, a turn's spend claim and a result receipt are COMPLETED
 *     RECEIPTS. They are kept, because they are what stops a legitimate retry
 *     turning into a second charge;
 *   - until a reinitialization has PROVEN the live authorities are gone, the
 *     paid video-edit path is denied PROCESS-WIDE — in every conversation,
 *     before the provider fetch and before the debit.
 *
 * The process-wide deny clears in exactly two ways, both of which are a proof
 * rather than an event: an explicit reinitialization that succeeded, or a fresh
 * ordinary user send, which clears it by RUNNING that reinitialization before it
 * mints. Never on a timer. Never by retrying an edit.
 *
 * Every assertion below is on the fetch spy and the debit spy DIRECTLY, never on
 * a returned status string: a refusal that had already called the provider would
 * satisfy `ok === false` and still cost the user money.
 *
 * The flag is enabled per-test through an injected dep and NEVER through
 * `process.env`: the spending flag stays default-off everywhere, test env
 * included.
 */

import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const readLicenseWireMock = vi.fn();
vi.mock('@/common/config/licenseWireAtRest', () => ({
  readLicenseWire: (...args: unknown[]) => readLicenseWireMock(...args),
}));
vi.mock('@process/utils/utils', () => ({ getDataPath: () => '/tmp/eve-data' }));

import type {
  CommandEveArtifactContextEnvelopeDeps,
  CommandEveArtifactTurnSteerDeps,
  CommandEveVideoBridgeDeps,
} from '@/process/bridge/commandEveVideoBridge';
import {
  buildConversationArtifactEnvelopeEntries,
  ensureVideoEditCapabilityHandle,
} from '@/process/commandEve/artifactCapabilityHandleStore';
import { saveVideoArtifactRecord } from '@/process/commandEve/videoArtifactStore';
import { buildVideoConversationArtifact } from '@/common/config/videoGenerationRequestCore';

const SOURCE_BYTES = Buffer.from('the founders five second aubergine clip');
const SOURCE_SHA = crypto.createHash('sha256').update(SOURCE_BYTES).digest('hex');

const editedBody = {
  ok: true,
  artifact: { mime_type: 'video/mp4', data_base64: 'QUJD', bytes: 3, sha256: 'e'.repeat(64) },
  video_edit: {
    model: 'grok-imagine-video',
    tier: 'sd',
    source_duration_seconds: 5,
    source_sha256: SOURCE_SHA,
    prompt_sha256: 'd'.repeat(64),
    estimated_credits: 1000,
  },
};

const jsonResponse = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

/** The injected storage failure. Exactly what an unwritable permit store looks like. */
const brokenPermitStorage = () => {
  throw new Error('EROFS: read-only file system, unlink permit record');
};

let dataRoot: string;
let videoRoot: string;

const spendPermitDir = () => path.join(dataRoot, 'command-eve-artifact-capabilities', 'spend-permits');
const denyDir = () => path.join(spendPermitDir(), 'deny');
const turnDir = () => path.join(spendPermitDir(), 'turns');
const inflightDir = () => path.join(spendPermitDir(), 'inflight');

function listNames(dir: string): string[] {
  try {
    return fs.readdirSync(dir).toSorted();
  } catch {
    return [];
  }
}

/**
 * The two modules a "process" is made of, here.
 *
 * `vi.resetModules()` plus a re-import is a restart as far as module-level state
 * is concerned — which is precisely the state the round-4 residual lived in.
 */
type StoreModule = typeof import('@/process/commandEve/videoEditSpendPermitStore');
type BridgeModule = typeof import('@/process/bridge/commandEveVideoBridge');

async function bootProcess(): Promise<{ store: StoreModule; bridge: BridgeModule }> {
  const store = await import('@/process/commandEve/videoEditSpendPermitStore');
  const bridge = await import('@/process/bridge/commandEveVideoBridge');
  return { store, bridge };
}

async function restartProcess(): Promise<{ store: StoreModule; bridge: BridgeModule }> {
  vi.resetModules();
  return bootProcess();
}

function seedSource(conversationId: string, id: string) {
  const clipPath = path.join(videoRoot, `${id}.mp4`);
  fs.writeFileSync(clipPath, SOURCE_BYTES);
  const artifact = buildVideoConversationArtifact({
    id,
    conversationId,
    createdAtMs: 1_754_000_000_000,
    path: clipPath,
    artifact: {
      mimeType: 'video/mp4',
      sha256: SOURCE_SHA,
      bytes: SOURCE_BYTES.byteLength,
      durationSeconds: 5,
      resolution: '480p',
      estimatedCredits: 500,
      model: 'grok-imagine-video',
      dataBase64: '',
      tierId: 'sd',
    } as never,
  });
  saveVideoArtifactRecord(dataRoot, artifact);
  return artifact;
}

function envelopeDeps(
  overrides: Partial<CommandEveArtifactContextEnvelopeDeps> = {}
): CommandEveArtifactContextEnvelopeDeps {
  return {
    getDataPath: () => dataRoot,
    buildEntries: buildConversationArtifactEnvelopeEntries,
    isVideoEditEnabled: () => true,
    ...overrides,
  };
}

function steerDeps(overrides: Partial<CommandEveArtifactTurnSteerDeps> = {}): CommandEveArtifactTurnSteerDeps {
  return { getDataPath: () => dataRoot, ...overrides };
}

function editDeps(
  fetchImpl: typeof fetch,
  overrides: Partial<CommandEveVideoBridgeDeps> = {}
): CommandEveVideoBridgeDeps {
  return {
    getDataPath: () => dataRoot,
    fetch: fetchImpl,
    newRequestId: () => 'req-fixed',
    newArtifactId: () => 'video-edited',
    getActiveSeatId: () => 'seat-1',
    areFileSelectionPathsGranted: () => true,
    readImageSource: () => ({ bytes: new Uint8Array([1, 2, 3, 4]) }),
    saveVideoFile: (input) => {
      const savedPath = path.join(videoRoot, `${input.artifactId}.mp4`);
      fs.writeFileSync(savedPath, Buffer.from(input.dataBase64, 'base64'));
      return savedPath;
    },
    saveArtifactRecord: saveVideoArtifactRecord,
    isVideoEditEnabled: () => true,
    ...overrides,
  };
}

/** Pull the permit out of the envelope exactly as a model reading it would. */
function permitFromEnvelope(envelope: string): string | undefined {
  return /evespend_[0-9a-f]{64}/.exec(envelope)?.[0];
}

/** The turn that mints, and the handle that names the clip it may act on. */
async function armedConversation(process_: { bridge: BridgeModule }, conversationId: string, turn: string) {
  const source = seedSource(conversationId, `video-${conversationId}`);
  const handle = ensureVideoEditCapabilityHandle(dataRoot, source)!;
  const { envelope } = await process_.bridge.handleCommandEveArtifactContextEnvelope(
    { conversationId, requestedEditOperation: 'video_edit', userTurnText: turn },
    envelopeDeps()
  );
  const permit = permitFromEnvelope(envelope)!;
  expect(permit).toBeTruthy();
  return { handle, permit };
}

/**
 * One edit attempt, with the two spies the requirement names.
 *
 * The DEBIT spy wraps the REAL atomic consume of the process under test rather
 * than replacing it, so a green result still went through the same one-shot
 * claim production uses — a stub would let this file prove a lane safe that
 * production is not.
 */
async function attemptEdit(
  process_: { store: StoreModule; bridge: BridgeModule },
  input: { handle: string; permit: string; instruction: string; conversationId?: string }
) {
  const fetchSpy = vi.fn(async () => jsonResponse(200, editedBody));
  const debitSpy = vi.fn((...args: Parameters<StoreModule['consumeVideoEditSpendPermit']>) =>
    process_.store.consumeVideoEditSpendPermit(...args)
  );
  const result = await process_.bridge.handleCommandEveVideoEdit(
    {
      handle: input.handle,
      permit: input.permit,
      instruction: input.instruction,
      ...(input.conversationId === undefined ? {} : { conversationId: input.conversationId }),
    },
    editDeps(fetchSpy as unknown as typeof fetch, { consumeSpendPermit: debitSpy })
  );
  return { result, fetchSpy, debitSpy };
}

/** Run `body` while every named directory is read-only, and always put the modes back. */
function withUnwritableDirectories<T>(dirs: readonly string[], body: () => T): T {
  for (const dir of dirs) fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  // Innermost first, so a parent that is still writable cannot be used to
  // rename a child out of the way.
  const ordered = dirs.toSorted((a, b) => b.length - a.length);
  for (const dir of ordered) fs.chmodSync(dir, 0o500);
  try {
    return body();
  } finally {
    for (const dir of ordered.toReversed()) fs.chmodSync(dir, 0o700);
  }
}

/** The single-directory case, which is all the deny-marker test needs. */
function withUnwritableDirectory<T>(dir: string, body: () => T): T {
  return withUnwritableDirectories([dir], body);
}

/**
 * A sweep that cannot delete ANY live authority.
 *
 * All three directories at once, deliberately. Locking only the permit directory
 * would still let the sweep delete the active-turn pointers in `turns/` — and
 * then a later refusal could come from the turn comparison rather than from the
 * process-wide deny, which would let this file pass while the gate it is meant
 * to pin was gone. Nothing may be deleted here, so the ONLY thing left standing
 * is the store-health state.
 */
function withWhollyUnsweepableStore<T>(body: () => T): T {
  return withUnwritableDirectories([spendPermitDir(), turnDir(), inflightDir()], body);
}

beforeEach(async () => {
  vi.clearAllMocks();
  readLicenseWireMock.mockReturnValue({ ok: true, wire: 'ceve-wire-token' });
  dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ceve-storehealth-'));
  videoRoot = path.join(dataRoot, 'videos');
  fs.mkdirSync(videoRoot, { recursive: true });
  // Every test starts from a genuinely fresh module registry, so nothing leaks
  // process-scoped health or deny state between them.
  await restartProcess();
});

afterEach(() => {
  fs.rmSync(dataRoot, { recursive: true, force: true });
});

describe('MAT-1747 round 5 requirement (i) — a permit that outlived a failed durable deny is dead after a restart', () => {
  it('req-i: process-scoped deny + restart + startup reinitialization => ZERO provider fetch and ZERO debit', async () => {
    // THE EXACT round-4 residual, reproduced end to end.
    const boot = await bootProcess();
    const turn = 'gib der Aubergine ein Gesicht';
    const { handle, permit } = await armedConversation(boot, 'conv-1', turn);

    // The steer's revoke fails AND the durable deny cannot be written, so the
    // ONLY record that this conversation lost its spend authority is the
    // in-memory Set.
    // The handler has no await before the store work, so the whole retirement
    // happens inside the read-only window; the promise is settled afterwards.
    await withUnwritableDirectory(denyDir(), () =>
      // Byte-identical to the minting turn on purpose: the turn-pointer defence
      // must not be able to mask the result.
      boot.bridge.handleCommandEveArtifactTurnSteer(
        { conversationId: 'conv-1', steerText: turn },
        steerDeps({ revokeOnSteer: brokenPermitStorage as never })
      )
    );

    // The residual is REAL in this run: no durable marker was written.
    expect(boot.store.readVideoEditSpendDenyState(dataRoot, 'conv-1').durable).toBe(false);

    // THE RESTART.
    const restarted = await restartProcess();
    // The in-memory deny is gone with the old process — that part has not
    // changed and is not what this round fixes.
    expect(restarted.store.isVideoEditSpendDenied(dataRoot, 'conv-1')).toBe(false);

    // THE STARTUP BOUNDARY: live authorities are invalidated and the store is
    // proven healthy.
    expect(restarted.store.reinitializeVideoEditSpendStore(dataRoot)).toBe('healthy');

    const attempt = await attemptEdit(restarted, { handle, permit, instruction: turn });
    expect(attempt.fetchSpy).not.toHaveBeenCalled();
    expect(attempt.debitSpy).not.toHaveBeenCalled();
    expect(attempt.result.ok).toBe(false);
  });

  it('req-i: before ANY reinitialization a restarted process refuses the paid path outright', async () => {
    // The startup call is a proactive sweep, not the guarantee. The guarantee is
    // that a process which has not PROVEN the store cannot spend from it at all
    // — otherwise a Hermes tool call arriving before the sweep would be the hole.
    const boot = await bootProcess();
    const turn = 'gib der Aubergine ein Gesicht';
    const { handle, permit } = await armedConversation(boot, 'conv-1', turn);

    const restarted = await restartProcess();
    expect(restarted.store.readVideoEditSpendStoreHealth()).toBe('unproven');

    const attempt = await attemptEdit(restarted, { handle, permit, instruction: turn });
    expect(attempt.fetchSpy).not.toHaveBeenCalled();
    expect(attempt.debitSpy).not.toHaveBeenCalled();
  });

  it('req-i: a fresh ordinary send in ANOTHER conversation restores health WITHOUT reviving the old permit', async () => {
    // The realistic recovery. A send is what clears the process-wide deny, and
    // it clears it by running the reinitialization first — which is why the
    // pre-restart permit is already gone by the time anything is spendable
    // again. Without the sweep, "restore health" would mean "re-open the old
    // wallet".
    const boot = await bootProcess();
    const turn = 'gib der Aubergine ein Gesicht';
    const { handle, permit } = await armedConversation(boot, 'conv-1', turn);

    const restarted = await restartProcess();
    // No explicit startup call at all in this run.
    expect(restarted.store.readVideoEditSpendStoreHealth()).toBe('unproven');

    const fresh = await armedConversation(restarted, 'conv-2', 'mach mir ein neues Video');
    expect(restarted.store.readVideoEditSpendStoreHealth()).toBe('healthy');

    const stale = await attemptEdit(restarted, { handle, permit, instruction: turn });
    expect(stale.fetchSpy).not.toHaveBeenCalled();
    expect(stale.debitSpy).not.toHaveBeenCalled();

    // POSITIVE CONTROL, in the same run: the lane really can reach the provider
    // and the debit, so the zero above is a refusal and not a broken harness.
    const live = await attemptEdit(restarted, {
      handle: fresh.handle,
      permit: fresh.permit,
      instruction: 'mach mir ein neues Video',
    });
    expect(live.result.ok).toBe(true);
    expect(live.fetchSpy).toHaveBeenCalledTimes(1);
    expect(live.debitSpy).toHaveBeenCalledTimes(1);
  });
});

describe('MAT-1747 round 5 requirement (ii) — a cleanup that cannot prove itself blocks GLOBALLY', () => {
  it('req-ii: an unprovable reinitialization denies every conversation before fetch and before debit', async () => {
    const boot = await bootProcess();
    const first = await armedConversation(boot, 'conv-1', 'gib der Aubergine ein Gesicht');
    const second = await armedConversation(boot, 'conv-2', 'mach den Hintergrund blau');

    // Every live authority exists and NONE of them can be deleted: readable
    // directories, unwritable contents. That is exactly "we cannot prove the
    // live authority is gone", and nothing else refuses in this state.
    const health = withWhollyUnsweepableStore(() => boot.store.reinitializeVideoEditSpendStore(dataRoot));
    expect(health).toBe('denied');
    expect(boot.store.isVideoEditSpendStoreHealthy()).toBe(false);
    // The permits and the turn pointers are still on disk — so if the paid path
    // ran, it would find everything it needs and charge.
    expect(listNames(spendPermitDir()).filter((name) => name.length === 69).length).toBe(2);
    expect(listNames(turnDir()).filter((name) => name.slice(-12) === '.active.json').length).toBe(2);

    // BOTH conversations, not just the one that happened to be steered.
    const one = await attemptEdit(boot, {
      handle: first.handle,
      permit: first.permit,
      instruction: 'gib der Aubergine ein Gesicht',
    });
    expect(one.fetchSpy).not.toHaveBeenCalled();
    expect(one.debitSpy).not.toHaveBeenCalled();

    const two = await attemptEdit(boot, {
      handle: second.handle,
      permit: second.permit,
      instruction: 'mach den Hintergrund blau',
    });
    expect(two.fetchSpy).not.toHaveBeenCalled();
    expect(two.debitSpy).not.toHaveBeenCalled();
  });

  it('req-ii: retrying the edit never clears the process-wide deny, and neither does the clock', async () => {
    const boot = await bootProcess();
    const armed = await armedConversation(boot, 'conv-1', 'gib der Aubergine ein Gesicht');

    withWhollyUnsweepableStore(() => boot.store.reinitializeVideoEditSpendStore(dataRoot));
    expect(boot.store.isVideoEditSpendStoreHealthy()).toBe(false);

    // Unrolled deliberately: these three must run ONE AFTER THE OTHER. Running
    // them in parallel would be a different test — the claim is that a retry
    // does not clear the state for the retry that follows it.
    const first = await attemptEdit(boot, {
      handle: armed.handle,
      permit: armed.permit,
      instruction: 'gib der Aubergine ein Gesicht',
    });
    expect(first.fetchSpy).not.toHaveBeenCalled();
    expect(first.debitSpy).not.toHaveBeenCalled();
    expect(boot.store.isVideoEditSpendStoreHealthy()).toBe(false);

    const second = await attemptEdit(boot, {
      handle: armed.handle,
      permit: armed.permit,
      instruction: 'gib der Aubergine ein Gesicht',
    });
    expect(second.fetchSpy).not.toHaveBeenCalled();
    expect(second.debitSpy).not.toHaveBeenCalled();
    expect(boot.store.isVideoEditSpendStoreHealthy()).toBe(false);

    const third = await attemptEdit(boot, {
      handle: armed.handle,
      permit: armed.permit,
      instruction: 'gib der Aubergine ein Gesicht',
    });
    expect(third.fetchSpy).not.toHaveBeenCalled();
    expect(third.debitSpy).not.toHaveBeenCalled();
    expect(boot.store.isVideoEditSpendStoreHealthy()).toBe(false);

    // "Never on a timer" is a rule the sweep has to obey, not a sentence.
    boot.store.pruneVideoEditSpendPermits(dataRoot, Date.now() + 400 * 24 * 60 * 60 * 1000);
    expect(boot.store.isVideoEditSpendStoreHealthy()).toBe(false);
  });
});

describe('MAT-1747 round 5 requirement (iii) — completed receipts survive, so a legitimate retry is still free', () => {
  it('req-iii: reinitialization keeps the consumed claim, the turn spend and the result receipt, and deletes the live authorities', async () => {
    const boot = await bootProcess();
    const turn = 'gib der Aubergine ein Gesicht';
    const armed = await armedConversation(boot, 'conv-1', turn);

    const paid = await attemptEdit(boot, { handle: armed.handle, permit: armed.permit, instruction: turn });
    expect(paid.result.ok).toBe(true);
    expect(paid.fetchSpy).toHaveBeenCalledTimes(1);
    expect(paid.debitSpy).toHaveBeenCalledTimes(1);

    // A lock, so the sweep has one to clear.
    expect(boot.store.acquireVideoEditInflightLock(dataRoot, 'conv-lock')).toBe(true);
    expect(listNames(inflightDir()).length).toBe(1);

    const restarted = await restartProcess();
    expect(restarted.store.reinitializeVideoEditSpendStore(dataRoot)).toBe('healthy');

    const permitNames = listNames(spendPermitDir()).filter((name) => name.slice(-5) === '.json');
    // LIVE authority: gone. `<64 hex>.json` is the permit record.
    expect(permitNames.filter((name) => name.length === 69)).toEqual([]);
    // COMPLETED receipts: kept.
    expect(permitNames.filter((name) => name.slice(-14) === '.consumed.json').length).toBe(1);
    expect(permitNames.filter((name) => name.slice(-12) === '.result.json').length).toBe(1);
    // The turn's one-spend claim is a receipt too; the active-turn pointer is not.
    const turnNames = listNames(turnDir());
    expect(turnNames.filter((name) => name.slice(-11) === '.spent.json').length).toBe(1);
    expect(turnNames.filter((name) => name.slice(-12) === '.active.json')).toEqual([]);
    // In-flight locks are live authority.
    expect(listNames(inflightDir())).toEqual([]);
  });

  it('req-iii: after the restart the same edit is answered from its receipt — no second fetch, no second debit', async () => {
    const boot = await bootProcess();
    const turn = 'gib der Aubergine ein Gesicht';
    const armed = await armedConversation(boot, 'conv-1', turn);

    const paid = await attemptEdit(boot, { handle: armed.handle, permit: armed.permit, instruction: turn });
    expect(paid.result.ok).toBe(true);
    expect(paid.fetchSpy).toHaveBeenCalledTimes(1);

    const restarted = await restartProcess();
    expect(restarted.store.reinitializeVideoEditSpendStore(dataRoot)).toBe('healthy');

    const replay = await attemptEdit(restarted, { handle: armed.handle, permit: armed.permit, instruction: turn });
    expect(replay.result.ok).toBe(true);
    expect((replay.result as { replayed?: boolean }).replayed).toBe(true);
    expect(replay.fetchSpy).not.toHaveBeenCalled();
    expect(replay.debitSpy).not.toHaveBeenCalled();
  });
});

describe('MAT-1747 round 5 requirement (iv) — after a clean start, ordinary use is unaffected', () => {
  it('req-iv: a clean startup reinitialization is healthy, and a normal send mints and spends exactly once', async () => {
    const boot = await bootProcess();
    // A store that has never been created holds no live authority — provably
    // clean, and an untouched seat must not be denied for having nothing.
    expect(boot.store.reinitializeVideoEditSpendStore(dataRoot)).toBe('healthy');
    expect(boot.store.isVideoEditSpendStoreHealthy()).toBe(true);

    const turn = 'gib der Aubergine ein Gesicht';
    const armed = await armedConversation(boot, 'conv-1', turn);

    const paid = await attemptEdit(boot, { handle: armed.handle, permit: armed.permit, instruction: turn });
    expect(paid.result.ok).toBe(true);
    expect(paid.fetchSpy).toHaveBeenCalledTimes(1);
    expect(paid.debitSpy).toHaveBeenCalledTimes(1);
  });

  it('req-iv: a conversation retired BEFORE the restart is still retired after it — the sweep never lifts a deny', async () => {
    // The sweep deletes authority; it must not hand any back. Deny markers live
    // in the `deny/` SUBDIRECTORY and every sweep loop takes `entry.isFile()`
    // only, which is the enforcing shape rather than a filter someone could
    // delete.
    const boot = await bootProcess();
    expect(boot.store.denyVideoEditSpend(dataRoot, 'conv-retired')).toBe('durable');

    const restarted = await restartProcess();
    expect(restarted.store.reinitializeVideoEditSpendStore(dataRoot)).toBe('healthy');

    expect(restarted.store.readVideoEditSpendDenyState(dataRoot, 'conv-retired').durable).toBe(true);
    expect(restarted.store.isVideoEditSpendDenied(dataRoot, 'conv-retired')).toBe(true);
  });

  it('req-iv: a reinitialization with no data path names no store and therefore proves nothing', async () => {
    const boot = await bootProcess();
    expect(boot.store.reinitializeVideoEditSpendStore(undefined)).toBe('denied');
    expect(boot.store.isVideoEditSpendStoreHealthy()).toBe(false);
  });
});

/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * MAT-1747 — the PAID GENERATE lane, where this slice added a capability mint.
 *
 * `handleCommandEveVideoGenerate` already had tests. What it did not have was a
 * single test that reaches the line this slice put inside its persistence block:
 *
 *     deps.ensureCapabilityHandle?.(deps.getDataPath(), conversationArtifact);
 *
 * The dep is OPTIONAL, and every pre-existing test builds a deps literal without
 * it, so the optional chain short-circuits and the mint is never executed. That
 * is why "3172 green" says nothing about this line — it is not reached at all.
 *
 * Two claims are worth money here, and neither was pinned:
 *
 *   1. THE ISOLATION. The mint sits inside the enclosing try whose catch returns
 *      `video-artifact-save-failed`. The clip at that point has been generated
 *      AND BILLED upstream and written to disk. If the mint's own try/catch were
 *      removed, a mint failure would tell the user their paid video was not
 *      saved — while it sits on their disk. That is the precise lie the reason
 *      code exists to avoid.
 *
 *   2. THE MINT ACTUALLY HAPPENS, and against the record that was persisted. A
 *      handle minted before the record is written would name a clip nothing can
 *      look up; a handle never minted at all is recoverable (the next envelope
 *      re-mints lazily) but nothing proved the pre-warm works, so the claim was
 *      untested in both directions.
 *
 * Every negative below is paired with the positive control that proves the probe
 * would have fired.
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

import type { CommandEveVideoBridgeDeps } from '@/process/bridge/commandEveVideoBridge';
import { handleCommandEveVideoGenerate } from '@/process/bridge/commandEveVideoBridge';
import {
  ensureVideoEditCapabilityHandle,
  resolveVideoEditCapability,
} from '@/process/commandEve/artifactCapabilityHandleStore';
import { saveVideoArtifactRecord } from '@/process/commandEve/videoArtifactStore';

let dataRoot: string;

const okBody = {
  ok: true,
  artifact: { mime_type: 'video/mp4', data_base64: 'AAAA', bytes: 3, sha256: 'c'.repeat(64) },
  video_generation: {
    model: 'grok-imagine-video',
    resolution: '480p',
    tier: 'sd',
    duration_seconds: 5,
    estimated_credits: 500,
  },
};

const jsonResponse = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

function deps(overrides: Partial<CommandEveVideoBridgeDeps> = {}): CommandEveVideoBridgeDeps {
  return {
    getDataPath: () => dataRoot,
    fetch: (async () => jsonResponse(200, okBody)) as unknown as typeof fetch,
    newRequestId: () => 'req-fixed',
    newArtifactId: () => 'video-generated',
    getActiveSeatId: () => 'seat-1',
    areFileSelectionPathsGranted: () => true,
    readImageSource: () => ({ bytes: new Uint8Array([1, 2, 3, 4]) }),
    saveVideoFile: () => path.join(dataRoot, 'videos', 'video-generated.mp4'),
    saveArtifactRecord: () => {},
    ...overrides,
  };
}

const generate = (overrides: Partial<CommandEveVideoBridgeDeps> = {}) =>
  handleCommandEveVideoGenerate(
    { prompt: 'eine Aubergine, die tanzt', tierId: 'sd', durationSeconds: 5, conversationId: 'conv-1' },
    deps(overrides)
  );

beforeEach(() => {
  vi.clearAllMocks();
  readLicenseWireMock.mockReturnValue({ ok: true, wire: 'ceve-wire-token' });
  dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ceve-generate-mint-'));
  fs.mkdirSync(path.join(dataRoot, 'videos'), { recursive: true });
});

afterEach(() => {
  fs.rmSync(dataRoot, { recursive: true, force: true });
});

describe('a generated clip is pre-warmed with an edit handle', () => {
  it('POSITIVE CONTROL: mints once, for the record that was actually persisted', async () => {
    const ensureCapabilityHandle = vi.fn(() => 'evecap_' + 'a'.repeat(64));
    const saveArtifactRecord = vi.fn();

    const result = await generate({ ensureCapabilityHandle, saveArtifactRecord });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(ensureCapabilityHandle).toHaveBeenCalledTimes(1);
    // The SAME object the store was handed — not a rebuilt copy that could
    // describe a different clip than the one on disk.
    expect(ensureCapabilityHandle).toHaveBeenCalledWith(dataRoot, result.conversationArtifact);
    expect(saveArtifactRecord).toHaveBeenCalledWith(dataRoot, result.conversationArtifact);
  });

  it('mints AFTER the record is saved, never before', async () => {
    // A handle minted first would name an artifact id that nothing can resolve,
    // because `resolveVideoEditCapability` looks the record up by id.
    const order: string[] = [];
    await generate({
      saveArtifactRecord: () => {
        order.push('save');
      },
      ensureCapabilityHandle: (() => {
        order.push('mint');
        return undefined;
      }) as unknown as typeof ensureVideoEditCapabilityHandle,
    });
    expect(order).toEqual(['save', 'mint']);
  });

  it('does not mint when there is no conversation to mint for', async () => {
    const ensureCapabilityHandle = vi.fn(() => 'evecap_' + 'a'.repeat(64));
    const result = await handleCommandEveVideoGenerate(
      { prompt: 'p', tierId: 'sd', durationSeconds: 5 },
      deps({ ensureCapabilityHandle })
    );
    expect(result.ok).toBe(true);
    expect(ensureCapabilityHandle).not.toHaveBeenCalled();
  });

  it('END TO END: the real store turns the generated clip into a resolvable capability', async () => {
    // No stub at all — the production mint against a real temp data path, so
    // this proves the pre-warm produces authority a later turn can actually use
    // rather than merely proving a function was called.
    const result = await generate({
      saveArtifactRecord: saveVideoArtifactRecord,
      ensureCapabilityHandle: ensureVideoEditCapabilityHandle,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const artifact = result.conversationArtifact;
    expect(artifact).toBeDefined();
    if (!artifact) return;

    const handle = ensureVideoEditCapabilityHandle(dataRoot, artifact);
    expect(typeof handle).toBe('string');
    const resolution = resolveVideoEditCapability(dataRoot, {
      handle,
      observedArtifactSha256: artifact.payload.hash,
      expectedConversationId: 'conv-1',
    });
    expect(resolution.ok).toBe(true);
    if (resolution.ok === false) return;
    expect(resolution.grant.artifact_id).toBe('video-generated');
    expect(resolution.grant.operation).toBe('video_edit');
  });
});

describe('a mint failure never reports a saved, billed clip as unsaved', () => {
  it('keeps the generation successful when the handle mint throws', async () => {
    // THE REGRESSION THIS FILE EXISTS FOR. Remove the inner try/catch around the
    // mint and this goes red with `video-artifact-save-failed` — the app telling
    // a user that a video they have already been charged for was not saved,
    // while it sits on their disk.
    const saveArtifactRecord = vi.fn();
    const result = await generate({
      saveArtifactRecord,
      ensureCapabilityHandle: (() => {
        throw new Error('capability store unwritable');
      }) as unknown as typeof ensureVideoEditCapabilityHandle,
    });

    expect(saveArtifactRecord).toHaveBeenCalledTimes(1);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.conversationArtifact).toBeDefined();
    expect(result.conversationArtifact?.payload.path).toBe(path.join(dataRoot, 'videos', 'video-generated.mp4'));
  });

  it('DISCRIMINATING CONTROL: a real save failure still reports itself', async () => {
    // The probe above must not be passing because the handler cannot fail at
    // all. A throw from the SAVE — outside the mint's own catch — is still the
    // honest "produced, not saved" refusal.
    const result = await generate({
      saveArtifactRecord: () => {
        throw new Error('disk full');
      },
      ensureCapabilityHandle: ensureVideoEditCapabilityHandle,
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reasonCode).toBe('video-artifact-save-failed');
  });

  it('a mint that merely declines leaves the clip saved and the turn successful', async () => {
    // `ensureVideoEditCapabilityHandle` returns undefined rather than throwing
    // when it cannot mint. That is not an error condition for the turn: the
    // envelope re-mints lazily on the next send.
    const result = await generate({
      saveArtifactRecord: saveVideoArtifactRecord,
      ensureCapabilityHandle: (() => undefined) as unknown as typeof ensureVideoEditCapabilityHandle,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.conversationArtifact?.id).toBe('video-generated');
    // And nothing was written into the capability store by this turn.
    const capabilityDir = path.join(dataRoot, 'command-eve-artifact-capabilities');
    expect(fs.existsSync(capabilityDir)).toBe(false);
  });
});

describe('the generate lane never invents a handle of its own', () => {
  it('emits no capability value into the result the renderer receives', async () => {
    const handle = 'evecap_' + crypto.randomBytes(32).toString('hex');
    const result = await generate({ ensureCapabilityHandle: (() => handle) as never });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // The handle reaches the model through the sanitized context envelope on a
    // later turn, never through this response. A credential riding the generate
    // result would be one more surface with a different redaction story.
    expect(JSON.stringify(result)).not.toContain(handle);
  });
});

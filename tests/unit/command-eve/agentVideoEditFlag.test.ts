/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * MAT-1747, 1.823.6 — legacy video edit stays release-fenced.
 *
 * The product contract being pinned:
 *
 *   (a) legacy video edit is closed by default;
 *   (b) no environment spelling reopens it;
 *   (c) no readable licence wire reopens it;
 *   (d) Main consequently emits neither tool advertisement nor spend permit.
 *
 * The first block tests the pure resolver; the second tests the production
 * helper against the real at-rest store (only the OS safeStorage primitive is
 * stubbed, via the documented hook); the third drives the REAL context-envelope
 * handler with the `isVideoEditEnabled` dep OMITTED, so the production fallback
 * — the same call Main makes — is what answers.
 */

import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  COMMAND_EVE_AGENT_VIDEO_EDIT_FLAG,
  COMMAND_EVE_VIDEO_HD15_FLAG,
  COMMAND_EVE_VIDEO_PRESET_VOICES_FLAG,
  isAgentVideoEditAdvertisingEnabled,
  readVideoSeatCapabilities,
  resolveAgentVideoEditAdvertisement,
} from '@/process/commandEve/agentVideoEditFlag';
import { storeLicenseWire } from '@/common/config/licenseWireAtRest';
import { setSafeStorageForTesting, type SafeStorageAdapter } from '@/common/config/keychain';
import { handleCommandEveArtifactContextEnvelope } from '@/process/bridge/commandEveVideoBridge';
import { buildConversationArtifactEnvelopeEntries } from '@/process/commandEve/artifactCapabilityHandleStore';
import {
  denyVideoEditSpend,
  issueVideoEditSpendPermit,
  recordActiveUserTurn,
  reinitializeVideoEditSpendStore,
} from '@/process/commandEve/videoEditSpendPermitStore';
import { saveVideoArtifactRecord } from '@/process/commandEve/videoArtifactStore';
import { buildVideoConversationArtifact } from '@/common/config/videoGenerationRequestCore';

/** Synthetic CEVE wire string — NOT a real license. */
const FAKE_WIRE = 'CEVE.v2.FAKE-payload-TESTONLY.FAKE-sig-TESTONLY';

const CLOSED_SEAT_SENTENCE =
  'No managed MCP artifact capabilities are enabled on this seat right now. `editable` describes the clip, not something you can do.';

function availableAdapter(): SafeStorageAdapter {
  return {
    isEncryptionAvailable: () => true,
    encryptString: (plainText: string) => Buffer.from(`enc::${plainText}`, 'utf8'),
    decryptString: (encrypted: Buffer) => {
      const raw = encrypted.toString('utf8');
      if (!raw.startsWith('enc::')) throw new Error('bad ciphertext');
      return raw.slice('enc::'.length);
    },
  };
}

describe('resolveAgentVideoEditAdvertisement — the pure decision', () => {
  it('stays closed for every carrier and eligibility combination', () => {
    expect(resolveAgentVideoEditAdvertisement({ env: {}, licenseWirePresent: true })).toBe(false);
    expect(resolveAgentVideoEditAdvertisement({ env: {}, licenseWirePresent: false })).toBe(false);
    for (const spelling of ['1', ' 1 ', '0', 'true', 'yes', 'on', '']) {
      expect(
        resolveAgentVideoEditAdvertisement({
          env: { [COMMAND_EVE_AGENT_VIDEO_EDIT_FLAG]: spelling },
          licenseWirePresent: true,
        })
      ).toBe(false);
    }
  });
});

describe('readVideoSeatCapabilities — released video model surface', () => {
  it('offers HD 1.5 by default for the licensed 1.820.4 release', () => {
    expect(readVideoSeatCapabilities({})).toEqual({
      hd15Available: true,
      presetVoicesAvailable: false,
    });
  });

  it("accepts exactly '0' (trimmed) as the HD 1.5 emergency kill-switch", () => {
    expect(readVideoSeatCapabilities({ [COMMAND_EVE_VIDEO_HD15_FLAG]: '0' }).hd15Available).toBe(false);
    expect(readVideoSeatCapabilities({ [COMMAND_EVE_VIDEO_HD15_FLAG]: ' 0 ' }).hd15Available).toBe(false);
  });

  it('does not let unrelated spellings disable the released HD 1.5 surface', () => {
    for (const spelling of ['1', 'true', 'yes', 'off', '']) {
      expect(readVideoSeatCapabilities({ [COMMAND_EVE_VIDEO_HD15_FLAG]: spelling }).hd15Available).toBe(true);
    }
  });

  it("keeps preset voices fail-closed behind exact '1'", () => {
    for (const spelling of ['0', 'true', 'yes', '']) {
      expect(
        readVideoSeatCapabilities({ [COMMAND_EVE_VIDEO_PRESET_VOICES_FLAG]: spelling }).presetVoicesAvailable
      ).toBe(false);
    }
    expect(readVideoSeatCapabilities({ [COMMAND_EVE_VIDEO_PRESET_VOICES_FLAG]: ' 1 ' }).presetVoicesAvailable).toBe(
      true
    );
  });
});

describe('isAgentVideoEditAdvertisingEnabled — the production read', () => {
  let dataRoot: string;
  const savedEnv = process.env[COMMAND_EVE_AGENT_VIDEO_EDIT_FLAG];

  beforeEach(() => {
    setSafeStorageForTesting(availableAdapter());
    dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ceve-video-edit-flag-'));
    delete process.env[COMMAND_EVE_AGENT_VIDEO_EDIT_FLAG];
  });

  afterEach(() => {
    setSafeStorageForTesting(undefined);
    if (savedEnv === undefined) delete process.env[COMMAND_EVE_AGENT_VIDEO_EDIT_FLAG];
    else process.env[COMMAND_EVE_AGENT_VIDEO_EDIT_FLAG] = savedEnv;
    fs.rmSync(dataRoot, { recursive: true, force: true });
  });

  it('stays OFF for a stored readable wire, including a stale carrier', () => {
    expect(storeLicenseWire(dataRoot, FAKE_WIRE).ok).toBe(true);
    expect(isAgentVideoEditAdvertisingEnabled(dataRoot)).toBe(false);
    process.env[COMMAND_EVE_AGENT_VIDEO_EDIT_FLAG] = '1';
    expect(isAgentVideoEditAdvertisingEnabled(dataRoot)).toBe(false);
  });
});

describe('the context envelope asks the SAME resolver when no dep is injected', () => {
  let dataRoot: string;
  let videoRoot: string;
  const savedEnv = process.env[COMMAND_EVE_AGENT_VIDEO_EDIT_FLAG];

  const SOURCE_BYTES = Buffer.from('the founders five second aubergine clip');

  function seedEditableClip(): void {
    const sourcePath = path.join(videoRoot, 'video-aubergine.mp4');
    fs.writeFileSync(sourcePath, SOURCE_BYTES);
    saveVideoArtifactRecord(
      dataRoot,
      buildVideoConversationArtifact({
        id: 'video-aubergine',
        conversationId: 'conv-1',
        createdAtMs: 1_754_000_000_000,
        path: sourcePath,
        artifact: {
          mimeType: 'video/mp4',
          sha256: crypto.createHash('sha256').update(SOURCE_BYTES).digest('hex'),
          bytes: SOURCE_BYTES.byteLength,
          durationSeconds: 5,
          resolution: '480p',
          estimatedCredits: 500,
          model: 'grok-imagine-video',
          dataBase64: '',
          tierId: 'sd',
        } as never,
      })
    );
  }

  /**
   * The production dep set with ONE member deliberately MISSING:
   * `isVideoEditEnabled`. What answers instead is the handler's own fallback —
   * `isAgentVideoEditAdvertisingEnabled(dataPath)` — i.e. the exact call the
   * main process makes. Injecting the flag here would test the test.
   */
  function envelopeDepsWithoutFlag() {
    return {
      getDataPath: () => dataRoot,
      buildEntries: buildConversationArtifactEnvelopeEntries,
      issuePermit: issueVideoEditSpendPermit,
      recordActiveTurn: recordActiveUserTurn,
      denySpend: denyVideoEditSpend,
    };
  }

  beforeEach(() => {
    setSafeStorageForTesting(availableAdapter());
    dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ceve-video-edit-envelope-flag-'));
    videoRoot = path.join(dataRoot, 'videos');
    fs.mkdirSync(videoRoot, { recursive: true });
    delete process.env[COMMAND_EVE_AGENT_VIDEO_EDIT_FLAG];
    seedEditableClip();
    expect(reinitializeVideoEditSpendStore(dataRoot)).toBe('healthy');
  });

  afterEach(() => {
    setSafeStorageForTesting(undefined);
    if (savedEnv === undefined) delete process.env[COMMAND_EVE_AGENT_VIDEO_EDIT_FLAG];
    else process.env[COMMAND_EVE_AGENT_VIDEO_EDIT_FLAG] = savedEnv;
    fs.rmSync(dataRoot, { recursive: true, force: true });
  });

  it('a stale enabled carrier and readable wire still mint no permit or tool advertisement', async () => {
    expect(storeLicenseWire(dataRoot, FAKE_WIRE).ok).toBe(true);
    process.env[COMMAND_EVE_AGENT_VIDEO_EDIT_FLAG] = '1';
    const { envelope } = await handleCommandEveArtifactContextEnvelope(
      { conversationId: 'conv-1', requestedEditOperation: 'video_edit', userTurnText: 'gib der Aubergine ein Gesicht' },
      envelopeDepsWithoutFlag()
    );
    expect(envelope).toContain(CLOSED_SEAT_SENTENCE);
    expect(envelope).not.toContain('eve_video_edit');
    expect(envelope).not.toMatch(/evespend_[0-9a-f]{64}/);
    expect(envelope).toMatch(/edit_handle=evecap_[0-9a-f]{64}/);
  });

  it("a KILL-SWITCHED seat ('0') gets the exact closed-seat sentence and no permit", async () => {
    expect(storeLicenseWire(dataRoot, FAKE_WIRE).ok).toBe(true);
    process.env[COMMAND_EVE_AGENT_VIDEO_EDIT_FLAG] = '0';
    const { envelope } = await handleCommandEveArtifactContextEnvelope(
      { conversationId: 'conv-1', requestedEditOperation: 'video_edit', userTurnText: 'gib der Aubergine ein Gesicht' },
      envelopeDepsWithoutFlag()
    );
    expect(envelope).toContain(CLOSED_SEAT_SENTENCE);
    expect(envelope).not.toContain('eve_video_edit');
    expect(envelope).not.toMatch(/evespend_/);
  });

  it('an INELIGIBLE seat (no licence wire) gets the same sentence and no permit', async () => {
    const { envelope } = await handleCommandEveArtifactContextEnvelope(
      { conversationId: 'conv-1', requestedEditOperation: 'video_edit', userTurnText: 'gib der Aubergine ein Gesicht' },
      envelopeDepsWithoutFlag()
    );
    expect(envelope).toContain(CLOSED_SEAT_SENTENCE);
    expect(envelope).not.toContain('eve_video_edit');
    expect(envelope).not.toMatch(/evespend_/);
  });

  it("an ineligible seat with a stray '1' in the env STILL gets the closed-seat sentence", async () => {
    // The no-bypass rule, at the envelope level: '1' is a no-op, not an override.
    process.env[COMMAND_EVE_AGENT_VIDEO_EDIT_FLAG] = '1';
    const { envelope } = await handleCommandEveArtifactContextEnvelope(
      { conversationId: 'conv-1', requestedEditOperation: 'video_edit', userTurnText: 'gib der Aubergine ein Gesicht' },
      envelopeDepsWithoutFlag()
    );
    expect(envelope).toContain(CLOSED_SEAT_SENTENCE);
    expect(envelope).not.toContain('eve_video_edit');
    expect(envelope).not.toMatch(/evespend_/);
  });
});

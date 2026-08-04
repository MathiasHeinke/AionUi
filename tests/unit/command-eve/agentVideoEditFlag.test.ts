/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * MAT-1747, 1.820.2 — the advertisement resolver, and the envelope that asks it.
 *
 * The product contract being pinned:
 *
 *   (a) an ELIGIBLE seat — licence wire present and readable via the REAL
 *       readLicenseWire — advertises `eve_video_edit` BY DEFAULT, env unset;
 *   (b) exactly `'0'` (trimmed) is the kill-switch and wins over eligibility;
 *   (c) no licence wire, or one that will not read, fails CLOSED;
 *   (d) `'1'` is a no-op — it does NOT bypass the eligibility check, because
 *       advertising a paid capability on an unauthenticated seat is forbidden.
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
  isAgentVideoEditAdvertisingEnabled,
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
  'No artifact capabilities are enabled on this seat right now. `editable` describes the clip, not something you can do.';

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
  it('(a) an eligible seat advertises BY DEFAULT, env unset', () => {
    expect(resolveAgentVideoEditAdvertisement({ env: {}, licenseWirePresent: true })).toBe(true);
  });

  it("(b) exactly '0' is the kill-switch and wins over eligibility", () => {
    expect(
      resolveAgentVideoEditAdvertisement({
        env: { [COMMAND_EVE_AGENT_VIDEO_EDIT_FLAG]: '0' },
        licenseWirePresent: true,
      })
    ).toBe(false);
    // Trimmed: whitespace around the '0' does not weaken the kill-switch.
    expect(
      resolveAgentVideoEditAdvertisement({
        env: { [COMMAND_EVE_AGENT_VIDEO_EDIT_FLAG]: ' 0 ' },
        licenseWirePresent: true,
      })
    ).toBe(false);
  });

  it('(c) no licence wire fails CLOSED, env unset', () => {
    expect(resolveAgentVideoEditAdvertisement({ env: {}, licenseWirePresent: false })).toBe(false);
  });

  it("(d) '1' is a no-op and does NOT bypass eligibility", () => {
    expect(
      resolveAgentVideoEditAdvertisement({
        env: { [COMMAND_EVE_AGENT_VIDEO_EDIT_FLAG]: '1' },
        licenseWirePresent: false,
      })
    ).toBe(false);
    // POSITIVE CONTROL: on an eligible seat '1' stays harmless — the same answer
    // as the unset default, so a stale `=1` in a shell profile changes nothing.
    expect(
      resolveAgentVideoEditAdvertisement({
        env: { [COMMAND_EVE_AGENT_VIDEO_EDIT_FLAG]: '1' },
        licenseWirePresent: true,
      })
    ).toBe(true);
    // And no other spelling opens anything on an ineligible seat either.
    for (const spelling of ['true', 'yes', 'on', '']) {
      expect(
        resolveAgentVideoEditAdvertisement({
          env: { [COMMAND_EVE_AGENT_VIDEO_EDIT_FLAG]: spelling },
          licenseWirePresent: false,
        })
      ).toBe(false);
    }
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

  it('(a) eligible seat (wire stored via the REAL at-rest path) → ON, env unset', () => {
    expect(storeLicenseWire(dataRoot, FAKE_WIRE).ok).toBe(true);
    expect(isAgentVideoEditAdvertisingEnabled(dataRoot)).toBe(true);
  });

  it("(b) kill-switch '0' + readable wire → OFF", () => {
    expect(storeLicenseWire(dataRoot, FAKE_WIRE).ok).toBe(true);
    process.env[COMMAND_EVE_AGENT_VIDEO_EDIT_FLAG] = '0';
    expect(isAgentVideoEditAdvertisingEnabled(dataRoot)).toBe(false);
  });

  it('(c) no licence wire → OFF; unreadable (malformed) wire → OFF', () => {
    expect(isAgentVideoEditAdvertisingEnabled(dataRoot)).toBe(false);
    // A malformed record on disk is a contract violation, not an eligibility.
    const dir = path.join(dataRoot, 'command-eve-runtime', 'entitlement');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'license-wire.json'), JSON.stringify({ wire_ref: FAKE_WIRE }));
    expect(isAgentVideoEditAdvertisingEnabled(dataRoot)).toBe(false);
  });

  it("(d) '1' without a licence wire → still OFF (no bypass)", () => {
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

  it('an ELIGIBLE seat with an editable clip advertises eve_video_edit AND mints a permit, env unset', async () => {
    expect(storeLicenseWire(dataRoot, FAKE_WIRE).ok).toBe(true);
    const { envelope } = await handleCommandEveArtifactContextEnvelope(
      { conversationId: 'conv-1', requestedEditOperation: 'video_edit', userTurnText: 'gib der Aubergine ein Gesicht' },
      envelopeDepsWithoutFlag()
    );
    expect(envelope).toContain('Allowed capabilities on this seat: eve_video_edit.');
    expect(envelope).toMatch(/evespend_[0-9a-f]{64}/);
    expect(envelope).toMatch(/edit_handle=evecap_[0-9a-f]{64}/);
    expect(envelope).not.toContain(CLOSED_SEAT_SENTENCE);
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

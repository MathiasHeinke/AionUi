/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * MAT-1747 C2 on disk.
 *
 * A handle is a bearer secret, so the file it lives in is part of the security
 * claim, not an implementation detail. These tests assert the mode, assert the
 * secret is not the filename, and assert that reuse is real — because minting a
 * fresh handle every turn would create hundreds of live keys to one paid action.
 */

import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  ARTIFACT_CAPABILITY_TTL_MS,
  buildConversationArtifactEnvelopeEntries,
  ensureVideoEditCapabilityHandle,
  mintVideoEditCapabilityHandle,
  pruneArtifactCapabilityGrants,
  readArtifactCapabilityGrant,
  resolveVideoEditCapability,
} from '@/process/commandEve/artifactCapabilityHandleStore';
import { saveVideoArtifactRecord } from '@/process/commandEve/videoArtifactStore';
import {
  buildVideoConversationArtifact,
  type CommandEveVideoConversationArtifact,
} from '@/common/config/videoGenerationRequestCore';

let tmpRoot: string;
let videoRoot: string;

const SOURCE_BYTES = Buffer.from('the founders aubergine clip');
const SOURCE_SHA = crypto.createHash('sha256').update(SOURCE_BYTES).digest('hex');

beforeEach(() => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ceve-capability-store-'));
  videoRoot = path.join(tmpRoot, 'videos');
  fs.mkdirSync(videoRoot, { recursive: true });
});

afterEach(() => {
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

function makeArtifact(
  overrides: { id?: string; conversationId?: string; durationSeconds?: number; sha?: string } = {}
): CommandEveVideoConversationArtifact {
  const id = overrides.id ?? 'video-1';
  const filePath = path.join(videoRoot, `${id}.mp4`);
  fs.writeFileSync(filePath, SOURCE_BYTES);
  return buildVideoConversationArtifact({
    id,
    conversationId: overrides.conversationId ?? 'conv-1',
    createdAtMs: 1_754_000_000_000,
    path: filePath,
    artifact: {
      mimeType: 'video/mp4',
      sha256: overrides.sha ?? SOURCE_SHA,
      bytes: SOURCE_BYTES.byteLength,
      durationSeconds: overrides.durationSeconds ?? 5,
      resolution: '480p',
      estimatedCredits: 500,
      model: 'grok-imagine-video',
      dataBase64: '',
      tierId: 'sd',
    } as never,
  });
}

describe('the grant file', () => {
  it('is 0600 and does not have the secret as its name', () => {
    const artifact = makeArtifact();
    const handle = mintVideoEditCapabilityHandle(tmpRoot, artifact);
    expect(handle).toBeDefined();

    const directory = path.join(tmpRoot, 'command-eve-artifact-capabilities');
    const files = fs.readdirSync(directory).filter((name) => name.endsWith('.json'));
    expect(files).toHaveLength(1);
    // The same discipline the shim auth token file uses. A grant readable by
    // another user is a paid action readable by another user.
    expect(fs.statSync(path.join(directory, files[0])).mode & 0o077).toBe(0);
    // The handle IS the authority, so a directory listing must not contain it.
    expect(files[0]).not.toContain(handle!.slice('evecap_'.length));
  });

  it('never mints for a clip that is not editable', () => {
    expect(mintVideoEditCapabilityHandle(tmpRoot, makeArtifact({ durationSeconds: 12 }))).toBeUndefined();
    // Positive control: the same store DOES mint for an editable clip, so the
    // refusal above is about the clip and not about the directory.
    expect(mintVideoEditCapabilityHandle(tmpRoot, makeArtifact({ durationSeconds: 5 }))).toBeDefined();
  });
});

describe('reuse and expiry', () => {
  it('returns the SAME handle for the same artifact instead of minting per turn', () => {
    const artifact = makeArtifact();
    const first = ensureVideoEditCapabilityHandle(tmpRoot, artifact);
    const second = ensureVideoEditCapabilityHandle(tmpRoot, artifact);
    const third = ensureVideoEditCapabilityHandle(tmpRoot, artifact);
    expect(first).toBeDefined();
    expect(second).toBe(first);
    expect(third).toBe(first);
    // One live secret, not three. The envelope rides EVERY turn, so a fresh mint
    // per turn would leave a growing pile of valid keys to one paid action.
    const directory = path.join(tmpRoot, 'command-eve-artifact-capabilities');
    expect(fs.readdirSync(directory).filter((n) => n.endsWith('.json'))).toHaveLength(1);
  });

  it('mints a NEW handle when the artifact bytes changed', () => {
    const artifact = makeArtifact();
    const first = ensureVideoEditCapabilityHandle(tmpRoot, artifact);
    const changed = { ...artifact, payload: { ...artifact.payload, hash: 'f'.repeat(64) } };
    const second = ensureVideoEditCapabilityHandle(tmpRoot, changed);
    expect(second).toBeDefined();
    expect(second).not.toBe(first);
  });

  it('stops resolving a grant past its TTL, and sweeps it', () => {
    const artifact = makeArtifact();
    const nowMs = 1_754_000_000_000;
    const handle = mintVideoEditCapabilityHandle(tmpRoot, artifact, { nowMs })!;
    // Still valid one millisecond before the TTL...
    expect(readArtifactCapabilityGrant(tmpRoot, handle, nowMs + ARTIFACT_CAPABILITY_TTL_MS)).toBeDefined();
    // ...and gone one millisecond after. A key to a paid action that never
    // expires outlives every later decision about the conversation.
    expect(readArtifactCapabilityGrant(tmpRoot, handle, nowMs + ARTIFACT_CAPABILITY_TTL_MS + 1)).toBeUndefined();
    expect(pruneArtifactCapabilityGrants(tmpRoot, nowMs + ARTIFACT_CAPABILITY_TTL_MS + 1)).toBe(1);
  });
});

describe('resolveVideoEditCapability', () => {
  function seed(overrides: { conversationId?: string } = {}) {
    const artifact = makeArtifact(overrides);
    saveVideoArtifactRecord(tmpRoot, artifact);
    const handle = ensureVideoEditCapabilityHandle(tmpRoot, artifact)!;
    return { artifact, handle };
  }

  it('authorises the handle it minted for the bytes on disk', () => {
    const { artifact, handle } = seed();
    const resolved = resolveVideoEditCapability(tmpRoot, { handle, observedArtifactSha256: SOURCE_SHA });
    expect(resolved.ok).toBe(true);
    expect(resolved.ok && resolved.artifact.id).toBe(artifact.id);
  });

  it('refuses an unknown handle rather than falling back to the newest clip', () => {
    seed();
    expect(
      resolveVideoEditCapability(tmpRoot, {
        handle: `evecap_${'9'.repeat(64)}`,
        observedArtifactSha256: SOURCE_SHA,
      })
    ).toEqual({ ok: false, reason: 'handle-unknown' });
  });

  it('refuses a malformed handle', () => {
    seed();
    expect(resolveVideoEditCapability(tmpRoot, { handle: 'conv-1', observedArtifactSha256: SOURCE_SHA })).toEqual({
      ok: false,
      reason: 'handle-malformed',
    });
  });

  it('refuses when the caller fences it to a different conversation', () => {
    const { handle } = seed();
    expect(
      resolveVideoEditCapability(tmpRoot, {
        handle,
        observedArtifactSha256: SOURCE_SHA,
        expectedConversationId: 'conv-elsewhere',
      })
    ).toEqual({ ok: false, reason: 'conversation-mismatch' });
  });

  it('refuses when the bytes changed under the handle', () => {
    const { handle } = seed();
    const otherSha = crypto.createHash('sha256').update('something else entirely').digest('hex');
    expect(resolveVideoEditCapability(tmpRoot, { handle, observedArtifactSha256: otherSha })).toEqual({
      ok: false,
      reason: 'artifact-changed',
    });
  });

  it('refuses when the artifact record is gone', () => {
    const { artifact, handle } = seed();
    fs.rmSync(path.join(tmpRoot, 'command-eve-video-artifacts', artifact.conversation_id), {
      recursive: true,
      force: true,
    });
    expect(resolveVideoEditCapability(tmpRoot, { handle, observedArtifactSha256: SOURCE_SHA })).toEqual({
      ok: false,
      reason: 'artifact-missing',
    });
  });
});

describe('the envelope entries this store produces', () => {
  it('lists newest first and carries a handle only for editable clips', () => {
    const editable = makeArtifact({ id: 'video-old' });
    saveVideoArtifactRecord(tmpRoot, editable);
    const tooLong = { ...makeArtifact({ id: 'video-new', durationSeconds: 30 }), created_at: 1_754_000_500_000 };
    saveVideoArtifactRecord(tmpRoot, tooLong);

    const entries = buildConversationArtifactEnvelopeEntries(tmpRoot, 'conv-1');
    expect(entries.map((e) => e.artifactId)).toEqual(['video-new', 'video-old']);
    expect(entries[0].editable).toBe(false);
    expect(entries[0].editHandle).toBeUndefined();
    expect(entries[1].editable).toBe(true);
    expect(entries[1].editHandle).toMatch(/^evecap_[0-9a-f]{64}$/);
  });

  it('leaves an inapplicable optional ABSENT, not present-and-undefined', () => {
    // The entry builder stopped spreading `{}` inside its map (oxlint
    // no-map-spread) and now assigns conditionally onto a typed local. Those two
    // shapes are indistinguishable through `toBeUndefined()` — which passes for
    // an absent key AND for a key whose value is undefined — so the difference
    // is asserted here through own-property checks instead.
    //
    // Why it is worth asserting at all — stated honestly, because the earlier
    // version of this comment was not. It claimed the envelope is serialised to
    // the model and that `"editHandle": undefined` would therefore tell the
    // model a handle exists. THAT IS FALSE. The envelope is never JSON; it is
    // rendered as key=value text by `renderEntry`
    // (eveArtifactContextEnvelopeCore.ts:146/147/151), and every optional sits
    // behind a truthiness guard — so present-and-undefined renders
    // BYTE-IDENTICALLY to absent, and no model-visible difference exists.
    //
    // The real reason: `EveArtifactEnvelopeEntry` declares these as optional
    // properties, and an optional that does not apply being genuinely ABSENT is
    // what that type describes. A key carrying `undefined` satisfies the
    // compiler while contradicting the interface, and it changes what
    // `Object.keys`, spreads and structured-clone downstream of this builder
    // would see. `Object.hasOwn` is the only assertion that can tell the two
    // shapes apart — `toBeUndefined()` passes for both — which is why the
    // assertions below are meaningful even though today's renderer cannot see
    // the difference. Proved by sabotage: making the three assignments in
    // `buildConversationArtifactEnvelopeEntries` unconditional turns the first
    // three expectations red.
    const tooLong = makeArtifact({ id: 'video-long', durationSeconds: 30 });
    saveVideoArtifactRecord(tmpRoot, tooLong);

    const [entry] = buildConversationArtifactEnvelopeEntries(tmpRoot, 'conv-1');
    expect(Object.hasOwn(entry, 'editHandle')).toBe(false);
    expect(Object.hasOwn(entry, 'parentArtifactId')).toBe(false);
    expect(Object.hasOwn(entry, 'selected')).toBe(false);
    // The keys that always apply are still own properties, so the assertion
    // above cannot pass merely because the object came out empty.
    expect(Object.hasOwn(entry, 'artifactId')).toBe(true);
    expect(Object.hasOwn(entry, 'editable')).toBe(true);
    expect(Object.hasOwn(entry, 'artifactSha256')).toBe(true);
  });

  it('marks the active selection without granting it anything extra', () => {
    saveVideoArtifactRecord(tmpRoot, makeArtifact({ id: 'video-a' }));
    const entries = buildConversationArtifactEnvelopeEntries(tmpRoot, 'conv-1', {
      selectedArtifactIds: ['video-a'],
    });
    expect(entries[0].selected).toBe(true);
  });

  it('never leaks another conversation’s artifacts or handles', () => {
    saveVideoArtifactRecord(tmpRoot, makeArtifact({ id: 'video-mine', conversationId: 'conv-1' }));
    saveVideoArtifactRecord(tmpRoot, makeArtifact({ id: 'video-theirs', conversationId: 'conv-2' }));
    const entries = buildConversationArtifactEnvelopeEntries(tmpRoot, 'conv-1');
    expect(entries.map((e) => e.artifactId)).toEqual(['video-mine']);
  });
});

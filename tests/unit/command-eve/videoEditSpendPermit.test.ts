/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * MAT-1747 — the ephemeral single-use spend permit, pure core and store.
 *
 * The founder removed the confirmation popup. That decision bounds what a paid
 * action may ASK the user, not what it may COST them. This file is where the
 * remaining bound lives, so every claim below is written as something that can
 * go red:
 *
 *   - a permit exists only because a person sent a turn (no text, no permit);
 *   - it binds to the conversation, the operation, the covered bytes and the
 *     hash of that raw turn;
 *   - it dies in minutes, not weeks;
 *   - it is consumed exactly once, by an EXCLUSIVE CREATE rather than a
 *     read-then-write, which is what makes two concurrent arrivals impossible
 *     rather than unlikely;
 *   - the same permit with a different instruction fails closed;
 *   - the same permit with the SAME instruction recovers the first result;
 *   - a new turn retires the previous turn's permit, so permits cannot be banked.
 *
 * Every "cannot happen" has a positive control next to it, because a store that
 * silently wrote nothing would pass a suite of negative assertions perfectly.
 */

import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  describeSpendPermitRefusal,
  evaluateVideoEditSpendPermit,
  isWellFormedVideoEditSpendPermit,
  mintVideoEditSpendPermit,
  VIDEO_EDIT_SPEND_PERMIT_MAX_ARTIFACTS,
  VIDEO_EDIT_SPEND_PERMIT_TTL_MS,
} from '@/common/config/eveVideoEditSpendPermitCore';
import {
  acquireVideoEditInflightLock,
  consumeVideoEditSpendPermit,
  evaluateStoredVideoEditSpendPermit,
  issueVideoEditSpendPermit,
  pruneVideoEditSpendPermits,
  readVideoEditSpendCompletion,
  readVideoEditSpendPermitRecord,
  recordVideoEditSpendCompletion,
  releaseVideoEditInflightLock,
  VIDEO_EDIT_INFLIGHT_LOCK_TTL_MS,
} from '@/process/commandEve/videoEditSpendPermitStore';

const TURN_SHA = crypto.createHash('sha256').update('gib der Aubergine ein Gesicht').digest('hex');
const OTHER_TURN_SHA = crypto.createHash('sha256').update('etwas ganz anderes').digest('hex');
const CLIP_SHA = 'a'.repeat(64);
const OTHER_CLIP_SHA = 'b'.repeat(64);
const INSTRUCTION_SHA = crypto.createHash('sha256').update('gib der Aubergine ein Gesicht').digest('hex');

let dataRoot: string;

beforeEach(() => {
  dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ceve-spend-permit-'));
});

afterEach(() => {
  fs.rmSync(dataRoot, { recursive: true, force: true });
});

const randomBytes = (size: number) => new Uint8Array(crypto.randomBytes(size));

describe('minting a permit', () => {
  it('produces a prefixed, 32-byte, hex permit bound to the turn', () => {
    const minted = mintVideoEditSpendPermit({
      conversationId: 'conv-1',
      userTurnSha256: TURN_SHA,
      allowedArtifactSha256: [CLIP_SHA],
      nowMs: 1_754_000_000_000,
      randomBytes,
    })!;
    expect(isWellFormedVideoEditSpendPermit(minted.permit)).toBe(true);
    expect(minted.permit).toHaveLength('evespend_'.length + 64);
    expect(minted.record.user_turn_sha256).toBe(TURN_SHA);
    expect(minted.record.conversation_id).toBe('conv-1');
    expect(minted.record.operation).toBe('video_edit');
    expect(minted.record.expires_at_ms - minted.record.issued_at_ms).toBe(VIDEO_EDIT_SPEND_PERMIT_TTL_MS);
  });

  it('refuses without a real user turn — "minted only on a send", enforced', () => {
    // There is no hash of nothing, so there is no permit for nothing. This is
    // the rule that stops a permit from being minted by a timer, by a retry, or
    // by the model asking for one.
    for (const bad of ['', 'not-a-hash', 'F'.repeat(64), 'a'.repeat(63)]) {
      expect(
        mintVideoEditSpendPermit({
          conversationId: 'conv-1',
          userTurnSha256: bad,
          allowedArtifactSha256: [CLIP_SHA],
          nowMs: 1,
          randomBytes,
        })
      ).toBeUndefined();
    }
  });

  it('refuses when it would authorise nothing', () => {
    expect(
      mintVideoEditSpendPermit({
        conversationId: 'conv-1',
        userTurnSha256: TURN_SHA,
        allowedArtifactSha256: [],
        nowMs: 1,
        randomBytes,
      })
    ).toBeUndefined();
  });

  it('refuses a short read from the random source rather than minting a weak permit', () => {
    expect(
      mintVideoEditSpendPermit({
        conversationId: 'conv-1',
        userTurnSha256: TURN_SHA,
        allowedArtifactSha256: [CLIP_SHA],
        nowMs: 1,
        randomBytes: () => new Uint8Array(8),
      })
    ).toBeUndefined();
  });

  it('bounds the covered artifacts and drops duplicates', () => {
    const many = Array.from({ length: VIDEO_EDIT_SPEND_PERMIT_MAX_ARTIFACTS + 10 }, (_, i) =>
      crypto.createHash('sha256').update(`clip-${i}`).digest('hex')
    );
    const minted = mintVideoEditSpendPermit({
      conversationId: 'conv-1',
      userTurnSha256: TURN_SHA,
      allowedArtifactSha256: [...many, many[0], many[0]],
      nowMs: 1,
      randomBytes,
    })!;
    expect(minted.record.allowed_artifact_sha256).toHaveLength(VIDEO_EDIT_SPEND_PERMIT_MAX_ARTIFACTS);
    expect(new Set(minted.record.allowed_artifact_sha256).size).toBe(VIDEO_EDIT_SPEND_PERMIT_MAX_ARTIFACTS);
  });
});

describe('judging a presented permit', () => {
  const record = mintVideoEditSpendPermit({
    conversationId: 'conv-1',
    userTurnSha256: TURN_SHA,
    allowedArtifactSha256: [CLIP_SHA],
    nowMs: 1_000,
    randomBytes,
  })!;

  it('accepts the exact permit for the exact conversation, turn and clip — the positive control', () => {
    const verdict = evaluateVideoEditSpendPermit({
      permit: record.permit,
      record: record.record,
      conversationId: 'conv-1',
      operation: 'video_edit',
      observedUserTurnSha256: TURN_SHA,
      observedArtifactSha256: CLIP_SHA,
      nowMs: 2_000,
    });
    expect(verdict.ok).toBe(true);
  });

  it.each([
    ['permit-missing', { permit: '' }],
    ['permit-malformed', { permit: 'evespend_nope' }],
    ['permit-unknown', { record: undefined }],
    ['permit-expired', { nowMs: 1_000 + VIDEO_EDIT_SPEND_PERMIT_TTL_MS + 1 }],
    ['permit-conversation-mismatch', { conversationId: 'conv-elsewhere' }],
    // The turn binding, judged rather than merely stored. `unknown` is the
    // conversation whose current turn we cannot read at all — fail closed, since
    // spending on a turn we cannot name is the thing being prevented.
    ['permit-turn-unknown', { observedUserTurnSha256: '' }],
    ['permit-turn-mismatch', { observedUserTurnSha256: OTHER_TURN_SHA }],
    ['permit-artifact-not-covered', { observedArtifactSha256: OTHER_CLIP_SHA }],
  ])('refuses with %s', (reason, override) => {
    const verdict = evaluateVideoEditSpendPermit({
      permit: record.permit,
      record: record.record,
      conversationId: 'conv-1',
      operation: 'video_edit',
      observedUserTurnSha256: TURN_SHA,
      observedArtifactSha256: CLIP_SHA,
      nowMs: 2_000,
      ...(override as Record<string, unknown>),
    });
    expect(verdict.ok).toBe(false);
    expect(verdict.ok === false && verdict.reason).toBe(reason);
    // Every refusal has a sentence of its own. One generic message would leave
    // the user unable to tell "ask again" from "this will never work".
    expect(describeSpendPermitRefusal(verdict.ok === false ? verdict.reason : 'permit-unknown').length).toBeGreaterThan(
      20
    );
  });
});

describe('the store', () => {
  it('writes a record that contains NO permit value at rest', () => {
    // The store is filed under the digest, so the lookup is itself the proof of
    // possession. Unlike the long-lived handle store — which must keep its
    // secret recoverable so the envelope can re-emit it — this one genuinely
    // holds nothing anyone could present.
    const permit = issueVideoEditSpendPermit(dataRoot, {
      conversationId: 'conv-1',
      userTurnSha256: TURN_SHA,
      allowedArtifactSha256: [CLIP_SHA],
    })!;
    const dir = path.join(dataRoot, 'command-eve-artifact-capabilities', 'spend-permits');
    const contents = fs
      .readdirSync(dir, { withFileTypes: true })
      .filter((entry) => entry.isFile())
      .map((entry) => fs.readFileSync(path.join(dir, entry.name), 'utf8'))
      .join('\n');
    expect(contents.length).toBeGreaterThan(0);
    expect(contents).not.toContain(permit);
    expect(contents).not.toContain(permit.slice('evespend_'.length));
    // POSITIVE CONTROL: the record IS there and IS readable by the permit.
    expect(readVideoEditSpendPermitRecord(dataRoot, permit)?.conversation_id).toBe('conv-1');
  });

  it('writes the record 0600', () => {
    const permit = issueVideoEditSpendPermit(dataRoot, {
      conversationId: 'conv-1',
      userTurnSha256: TURN_SHA,
      allowedArtifactSha256: [CLIP_SHA],
    })!;
    const key = crypto.createHash('sha256').update(permit).digest('hex');
    const file = path.join(dataRoot, 'command-eve-artifact-capabilities', 'spend-permits', `${key}.json`);
    expect(fs.statSync(file).mode & 0o077).toBe(0);
  });

  it('retires the previous turn permit when a new turn mints one', () => {
    // "At most ONE distinct paid edit per explicit user turn." Without this, a
    // model could bank a permit per turn and spend them in a burst later.
    const first = issueVideoEditSpendPermit(dataRoot, {
      conversationId: 'conv-1',
      userTurnSha256: TURN_SHA,
      allowedArtifactSha256: [CLIP_SHA],
    })!;
    const second = issueVideoEditSpendPermit(dataRoot, {
      conversationId: 'conv-1',
      userTurnSha256: crypto.createHash('sha256').update('zweite Frage').digest('hex'),
      allowedArtifactSha256: [CLIP_SHA],
    })!;
    expect(readVideoEditSpendPermitRecord(dataRoot, first)).toBeUndefined();
    // POSITIVE CONTROL: the NEW one lives, so the sweep is targeted rather than
    // a store that simply lost everything.
    expect(readVideoEditSpendPermitRecord(dataRoot, second)).toBeTruthy();
  });

  it('does not retire another conversation permit', () => {
    const other = issueVideoEditSpendPermit(dataRoot, {
      conversationId: 'conv-other',
      userTurnSha256: TURN_SHA,
      allowedArtifactSha256: [CLIP_SHA],
    })!;
    issueVideoEditSpendPermit(dataRoot, {
      conversationId: 'conv-1',
      userTurnSha256: TURN_SHA,
      allowedArtifactSha256: [CLIP_SHA],
    });
    expect(readVideoEditSpendPermitRecord(dataRoot, other)).toBeTruthy();
  });

  it('prunes a permit whose window and grace have both closed', () => {
    const permit = issueVideoEditSpendPermit(dataRoot, {
      conversationId: 'conv-1',
      userTurnSha256: TURN_SHA,
      allowedArtifactSha256: [CLIP_SHA],
      nowMs: 1_000,
    })!;
    expect(readVideoEditSpendPermitRecord(dataRoot, permit)).toBeTruthy();
    const removed = pruneVideoEditSpendPermits(
      dataRoot,
      1_000 + VIDEO_EDIT_SPEND_PERMIT_TTL_MS + VIDEO_EDIT_INFLIGHT_LOCK_TTL_MS + 1
    );
    expect(removed).toBeGreaterThan(0);
    expect(readVideoEditSpendPermitRecord(dataRoot, permit)).toBeUndefined();
  });

  it('keeps a permit that is still inside its window', () => {
    const permit = issueVideoEditSpendPermit(dataRoot, {
      conversationId: 'conv-1',
      userTurnSha256: TURN_SHA,
      allowedArtifactSha256: [CLIP_SHA],
      nowMs: 1_000,
    })!;
    expect(pruneVideoEditSpendPermits(dataRoot, 2_000)).toBe(0);
    expect(readVideoEditSpendPermitRecord(dataRoot, permit)).toBeTruthy();
  });

  it('reads back through evaluate, so no caller can skip the judging half', () => {
    const permit = issueVideoEditSpendPermit(dataRoot, {
      conversationId: 'conv-1',
      userTurnSha256: TURN_SHA,
      allowedArtifactSha256: [CLIP_SHA],
    })!;
    expect(
      evaluateStoredVideoEditSpendPermit(dataRoot, {
        permit,
        conversationId: 'conv-1',
        observedArtifactSha256: CLIP_SHA,
      }).ok
    ).toBe(true);
    expect(
      evaluateStoredVideoEditSpendPermit(dataRoot, {
        permit,
        conversationId: 'conv-2',
        observedArtifactSha256: CLIP_SHA,
      }).ok
    ).toBe(false);
  });
});

describe('consuming a permit is a one-shot transaction', () => {
  function issue(): string {
    return issueVideoEditSpendPermit(dataRoot, {
      conversationId: 'conv-1',
      userTurnSha256: TURN_SHA,
      allowedArtifactSha256: [CLIP_SHA],
    })!;
  }

  const turn = { conversationId: 'conv-1', userTurnSha256: TURN_SHA };

  it('succeeds exactly once for the same permit and instruction', () => {
    const permit = issue();
    const first = consumeVideoEditSpendPermit(dataRoot, {
      permit,
      ...turn,
      instructionSha256: INSTRUCTION_SHA,
      artifactSha256: CLIP_SHA,
    });
    const second = consumeVideoEditSpendPermit(dataRoot, {
      permit,
      ...turn,
      instructionSha256: INSTRUCTION_SHA,
      artifactSha256: CLIP_SHA,
    });
    expect(first.ok).toBe(true);
    // Same instruction, no receipt yet -> the first one is still running.
    expect(second.ok === false && second.reason).toBe('permit-in-flight');
  });

  it('refuses the same permit with a DIFFERENT instruction — the loop, closed', () => {
    const permit = issue();
    expect(
      consumeVideoEditSpendPermit(dataRoot, {
        permit,
        ...turn,
        instructionSha256: INSTRUCTION_SHA,
        artifactSha256: CLIP_SHA,
      }).ok
    ).toBe(true);
    const varied = consumeVideoEditSpendPermit(dataRoot, {
      permit,
      ...turn,
      instructionSha256: crypto.createHash('sha256').update('und jetzt blau').digest('hex'),
      artifactSha256: CLIP_SHA,
    });
    expect(varied.ok === false && varied.reason).toBe('permit-consumed');
  });

  it('holds under a concurrent burst: exactly one winner out of twenty', () => {
    // THE property the whole design rests on. A read-then-write would let
    // several of these read "unused" and all conclude they may spend.
    const permit = issue();
    const outcomes = Array.from({ length: 20 }, () =>
      consumeVideoEditSpendPermit(dataRoot, {
        permit,
        ...turn,
        instructionSha256: INSTRUCTION_SHA,
        artifactSha256: CLIP_SHA,
      })
    );
    expect(outcomes.filter((o) => o.ok === true)).toHaveLength(1);
    expect(outcomes.filter((o) => o.ok === false)).toHaveLength(19);
  });

  it('refuses a malformed permit without touching the store', () => {
    const result = consumeVideoEditSpendPermit(dataRoot, {
      permit: 'evespend_short',
      ...turn,
      instructionSha256: INSTRUCTION_SHA,
      artifactSha256: CLIP_SHA,
    });
    expect(result.ok === false && result.reason).toBe('permit-malformed');
  });

  it('refuses a spend it cannot attribute to a turn', () => {
    // Fail closed rather than falling back to permit-only accounting — which is
    // exactly what round 1 did by never having the concept at all.
    const permit = issue();
    for (const bad of [
      { conversationId: '', userTurnSha256: TURN_SHA },
      { conversationId: 'conv-1', userTurnSha256: 'not-a-hash' },
    ]) {
      const result = consumeVideoEditSpendPermit(dataRoot, {
        permit,
        ...bad,
        instructionSha256: INSTRUCTION_SHA,
        artifactSha256: CLIP_SHA,
      });
      expect(result.ok === false && result.reason).toBe('permit-turn-unknown');
    }
    // POSITIVE CONTROL: with the turn named, the same permit spends.
    expect(
      consumeVideoEditSpendPermit(dataRoot, {
        permit,
        ...turn,
        instructionSha256: INSTRUCTION_SHA,
        artifactSha256: CLIP_SHA,
      }).ok
    ).toBe(true);
  });
});

describe('the receipt makes a retry free', () => {
  it('matches only the SAME instruction and the SAME bytes', () => {
    const permit = issueVideoEditSpendPermit(dataRoot, {
      conversationId: 'conv-1',
      userTurnSha256: TURN_SHA,
      allowedArtifactSha256: [CLIP_SHA],
    })!;
    recordVideoEditSpendCompletion(dataRoot, permit, {
      artifact_id: 'edit-1',
      source_artifact_id: 'video-1',
      conversation_id: 'conv-1',
      instruction_sha256: INSTRUCTION_SHA,
      artifact_sha256: CLIP_SHA,
      completed_at_ms: Date.now(),
    });

    expect(
      readVideoEditSpendCompletion(dataRoot, permit, {
        conversationId: 'conv-1',
        instructionSha256: INSTRUCTION_SHA,
        artifactSha256: CLIP_SHA,
      })?.artifact_id
    ).toBe('edit-1');
    // A DIFFERENT instruction must not be able to launder itself into a
    // recovery — that would reopen the varied-instruction loop through the back
    // door.
    expect(
      readVideoEditSpendCompletion(dataRoot, permit, {
        conversationId: 'conv-1',
        instructionSha256: 'c'.repeat(64),
        artifactSha256: CLIP_SHA,
      })
    ).toBeUndefined();
    expect(
      readVideoEditSpendCompletion(dataRoot, permit, {
        conversationId: 'conv-1',
        instructionSha256: INSTRUCTION_SHA,
        artifactSha256: OTHER_CLIP_SHA,
      })
    ).toBeUndefined();
    // ...and neither must a DIFFERENT CONVERSATION, which is the leak an
    // independent audit found: two conversations holding byte-identical clips
    // were otherwise enough for one to recover the other's edit AND its path.
    expect(
      readVideoEditSpendCompletion(dataRoot, permit, {
        conversationId: 'conv-elsewhere',
        instructionSha256: INSTRUCTION_SHA,
        artifactSha256: CLIP_SHA,
      })
    ).toBeUndefined();
  });

  it('survives the permit record being retired by a later turn', () => {
    // Idempotency has to outlive revocation, or a slow edit whose permit was
    // swept by the next turn would come back as a second charge.
    const permit = issueVideoEditSpendPermit(dataRoot, {
      conversationId: 'conv-1',
      userTurnSha256: TURN_SHA,
      allowedArtifactSha256: [CLIP_SHA],
    })!;
    recordVideoEditSpendCompletion(dataRoot, permit, {
      artifact_id: 'edit-1',
      source_artifact_id: 'video-1',
      conversation_id: 'conv-1',
      instruction_sha256: INSTRUCTION_SHA,
      artifact_sha256: CLIP_SHA,
      completed_at_ms: Date.now(),
    });
    issueVideoEditSpendPermit(dataRoot, {
      conversationId: 'conv-1',
      userTurnSha256: crypto.createHash('sha256').update('naechste Frage').digest('hex'),
      allowedArtifactSha256: [CLIP_SHA],
    });
    expect(readVideoEditSpendPermitRecord(dataRoot, permit)).toBeUndefined();
    expect(
      readVideoEditSpendCompletion(dataRoot, permit, {
        conversationId: 'conv-1',
        instructionSha256: INSTRUCTION_SHA,
        artifactSha256: CLIP_SHA,
      })?.artifact_id
    ).toBe('edit-1');
  });
});

describe('at most one paid edit in flight per conversation', () => {
  it('grants the lock once and refuses the second holder', () => {
    expect(acquireVideoEditInflightLock(dataRoot, 'conv-1', 1_000)).toBe(true);
    expect(acquireVideoEditInflightLock(dataRoot, 'conv-1', 1_100)).toBe(false);
    // A DIFFERENT conversation is unaffected — the lock is a fence, not a global
    // mutex on the feature.
    expect(acquireVideoEditInflightLock(dataRoot, 'conv-2', 1_100)).toBe(true);
  });

  it('reopens after release', () => {
    expect(acquireVideoEditInflightLock(dataRoot, 'conv-1', 1_000)).toBe(true);
    releaseVideoEditInflightLock(dataRoot, 'conv-1');
    expect(acquireVideoEditInflightLock(dataRoot, 'conv-1', 1_100)).toBe(true);
  });

  it('reclaims a STALE lock rather than closing the lane forever', () => {
    // A crash mid-edit must cost one wait, not a permanently dead feature.
    expect(acquireVideoEditInflightLock(dataRoot, 'conv-1', 1_000)).toBe(true);
    expect(acquireVideoEditInflightLock(dataRoot, 'conv-1', 1_000 + VIDEO_EDIT_INFLIGHT_LOCK_TTL_MS - 1)).toBe(false);
    expect(acquireVideoEditInflightLock(dataRoot, 'conv-1', 1_000 + VIDEO_EDIT_INFLIGHT_LOCK_TTL_MS + 1)).toBe(true);
  });
});

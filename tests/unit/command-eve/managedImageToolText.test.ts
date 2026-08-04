import { describe, expect, it } from 'vitest';

import {
  buildManagedImageToolText,
  isWellFormedImageStagedHandle,
  mintImageStagedHandle,
  parseManagedImageArtifactRecord,
} from '@/common/config/managedImageArtifactCore';
import { collectImageBindFromToolCallUpdate, extractImageStagedHandle } from '@/common/config/imageArtifactBindCore';

const HANDLE = `img_h_${'ab'.repeat(32)}`;

/** The P0 leak tokens the pre-contract lane shipped into model-visible text. */
const FORBIDDEN_TOKENS = ['/Users/', 'file:', 'MEDIA:', 'data:image'];

describe('the managed tool text is PATH-FREE and carries no edit instruction', () => {
  it('names the staged handle and human metadata only', () => {
    const text = buildManagedImageToolText({
      artifactHandle: HANDLE,
      resolution: '1K',
      aspectRatio: '16:9',
      bytesCount: 380_000,
      model: 'Nano Banana 2',
    });
    expect(text).toContain(HANDLE);
    expect(text).toContain('1K');
    expect(text).toContain('16:9');
    expect(text).toContain('Nano Banana 2');
    for (const token of FORBIDDEN_TOKENS) expect(text).not.toContain(token);
    // CoS 1.820.3: the staged handle is stage/bind/display authority ONLY.
    // The text must not teach the model to use it for edits — the DISTINCT
    // `evecap_` handle from the bound turn's envelope is the edit credential.
    expect(text).not.toContain('Bearbeit');
    expect(text).not.toContain('edit');
    expect(text).toContain('Interne Artefakt-Referenz');
  });

  it('cannot be made to carry a path through any parameter', () => {
    const text = buildManagedImageToolText({
      artifactHandle: HANDLE,
      resolution: '/Users/alice/conversations',
      aspectRatio: 'file:',
      bytesCount: 1,
      model: 'data:image/png;base64,',
    });
    // Sharp, not soft (CoS 1.820.3): hostile metadata in EVERY interpolated
    // parameter must degrade to `unbekannt`, so the text provably carries none
    // of the forbidden tokens — the handle is the only artifact identity.
    for (const token of FORBIDDEN_TOKENS) expect(text).not.toContain(token);
    expect(text).not.toContain('/Users/alice/conversations');
    expect(text).not.toContain('data:image/png;base64,');
    expect(text).toContain('unbekannt');
    expect(extractImageStagedHandle(text)).toBe(HANDLE);
  });

  it('degrades overlong and control-char metadata instead of leaking it', () => {
    const text = buildManagedImageToolText({
      artifactHandle: HANDLE,
      resolution: '1K'.repeat(100),
      aspectRatio: '16\t:9',
      bytesCount: 1,
      model: 'MEDIA: /Users/alice/x.png',
    });
    for (const token of FORBIDDEN_TOKENS) expect(text).not.toContain(token);
    expect(text).not.toContain('1K'.repeat(100));
    expect(text).not.toContain('16\t:9');
    expect(text).toContain('unbekannt');
  });

  it('passes controlled registry metadata through verbatim', () => {
    const text = buildManagedImageToolText({
      artifactHandle: HANDLE,
      resolution: '1024x1024',
      aspectRatio: '1:1',
      bytesCount: 648_841,
      model: 'Nano Banana 2',
    });
    expect(text).toContain('1024x1024');
    expect(text).toContain('1:1');
    expect(text).toContain('Nano Banana 2');
    expect(text).toContain('634 KB');
  });
});

describe('the staged handle primitive', () => {
  it('mints well-formed handles and refuses a short random source', () => {
    const handle = mintImageStagedHandle({ randomBytes: (size) => new Uint8Array(size).fill(7) });
    expect(handle).toBe(`img_h_${'07'.repeat(32)}`);
    expect(isWellFormedImageStagedHandle(handle)).toBe(true);
    expect(mintImageStagedHandle({ randomBytes: () => new Uint8Array(8) })).toBeUndefined();
  });

  it('accepts only the exact shape', () => {
    expect(isWellFormedImageStagedHandle(HANDLE)).toBe(true);
    expect(isWellFormedImageStagedHandle(`evecap_${'ab'.repeat(32)}`)).toBe(false);
    expect(isWellFormedImageStagedHandle(`img_h_${'ab'.repeat(31)}`)).toBe(false);
    expect(isWellFormedImageStagedHandle(`img_h_${'AB'.repeat(32)}`)).toBe(false);
    expect(isWellFormedImageStagedHandle(42)).toBe(false);
  });
});

describe('extractImageStagedHandle', () => {
  it('lifts the first well-formed handle out of tool text', () => {
    const text = buildManagedImageToolText({
      artifactHandle: HANDLE,
      resolution: '1K',
      aspectRatio: '1:1',
      bytesCount: 1024,
    });
    expect(extractImageStagedHandle(text)).toBe(HANDLE);
  });

  it('finds the handle inside the image_edit loopback JSON answer too', () => {
    const json = JSON.stringify({ ok: true, artifact_id: HANDLE, parent_artifact_id: 'img_1' });
    expect(extractImageStagedHandle(json)).toBe(HANDLE);
  });

  it('returns undefined for prose, other credentials and truncated handles', () => {
    expect(extractImageStagedHandle('Bild erstellt.')).toBeUndefined();
    expect(extractImageStagedHandle(`evecap_${'ab'.repeat(32)}`)).toBeUndefined();
    expect(extractImageStagedHandle(`img_h_${'ab'.repeat(20)}`)).toBeUndefined();
    expect(extractImageStagedHandle(undefined)).toBeUndefined();
  });

  it('skips a prefix that is prose and finds the real one after it', () => {
    expect(extractImageStagedHandle(`img_h_kurz und dann ${HANDLE}`)).toBe(HANDLE);
  });
});

describe('collectImageBindFromToolCallUpdate', () => {
  it('extracts {handle, toolCallId} from a raw acp_tool_call update', () => {
    const candidate = collectImageBindFromToolCallUpdate({
      tool_call_id: 'call-1',
      content: [
        {
          type: 'content',
          content: { type: 'text', text: `Bild erstellt. Interne Artefakt-Referenz: ${HANDLE} (1K).` },
        },
      ],
    });
    expect(candidate).toEqual({ toolCallId: 'call-1', handle: HANDLE });
  });

  it('returns undefined for updates without id, content or handle', () => {
    expect(collectImageBindFromToolCallUpdate(undefined)).toBeUndefined();
    expect(collectImageBindFromToolCallUpdate({ content: [] })).toBeUndefined();
    expect(
      collectImageBindFromToolCallUpdate({
        tool_call_id: 'call-1',
        content: [{ type: 'content', content: { text: 'kein handle' } }],
      })
    ).toBeUndefined();
  });
});

describe('parseManagedImageArtifactRecord validates EVERY typed field', () => {
  const valid = {
    id: 'img_abc123',
    conversation_id: 'conv-1',
    kind: 'image',
    status: 'active',
    payload: {
      artifact_type: 'image',
      title: 'Bild 1K',
      description: '1K · 16:9 · model',
      managed_image: true,
      mime_type: 'image/png',
      sha256: 'a'.repeat(64),
      size: 1234,
      tier: 'quality',
      model: 'gemini',
      resolution: '1K',
      aspect_ratio: '16:9',
      prompt_sha256: 'b'.repeat(64),
      parent_artifact_id: 'img_parent',
    },
    created_at: 1_754_000_000_000,
    updated_at: 1_754_000_000_100,
    bound_tool_call_id: 'call-1',
  };

  it('accepts a fully valid record', () => {
    expect(parseManagedImageArtifactRecord(valid)?.id).toBe('img_abc123');
    expect(parseManagedImageArtifactRecord({ ...valid, bound_tool_call_id: undefined })?.id).toBe('img_abc123');
  });

  it('refuses partially-valid JSON instead of casting it into the type', () => {
    const cases: Array<[string, unknown]> = [
      ['empty title', { payload: { ...valid.payload, title: '' } }],
      ['non-finite size', { payload: { ...valid.payload, size: Number.NaN } }],
      ['zero size', { payload: { ...valid.payload, size: 0 } }],
      ['non-finite created_at', { created_at: Number.POSITIVE_INFINITY }],
      ['zero updated_at', { updated_at: 0 }],
      ['unsafe id', { id: '../escape' }],
      ['unsafe conversation', { conversation_id: 'a/b' }],
      ['non-sha payload hash', { payload: { ...valid.payload, sha256: 'zz' } }],
      ['missing model', { payload: { ...valid.payload, model: 7 } }],
      ['unsafe parent id', { payload: { ...valid.payload, parent_artifact_id: 'a/b' } }],
      ['staged with conversation', { status: 'staged', conversation_id: 'conv-1' }],
      ['active without conversation', { status: 'active', conversation_id: null }],
    ];
    for (const [label, patch] of cases) {
      const merged = { ...valid, ...(patch as Record<string, unknown>) };
      expect(parseManagedImageArtifactRecord(merged), label).toBeUndefined();
    }
  });

  it('never exposes a blob path: the writers put no path key into the payload type', () => {
    // Structural proof of the privacy invariant rather than a runtime one: the
    // payload type has no path field at all, so no record this lane writes can
    // carry one. A hand-forged path key is inert extra data, never read back.
    const record = parseManagedImageArtifactRecord(valid);
    expect(record && 'path' in record.payload).toBe(false);
  });

  it('a staged record with null conversation is valid', () => {
    expect(
      parseManagedImageArtifactRecord({
        ...valid,
        status: 'staged',
        conversation_id: null,
        bound_tool_call_id: undefined,
      })?.status
    ).toBe('staged');
  });
});

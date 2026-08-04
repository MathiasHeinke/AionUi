import { describe, expect, it, vi } from 'vitest';

import {
  artifactCapabilityCallHandler,
  type ArtifactCapabilityLoopbackDeps,
} from '@/process/commandEve/artifactCapabilityLoopback';

function deps(overrides: Partial<ArtifactCapabilityLoopbackDeps> = {}): ArtifactCapabilityLoopbackDeps {
  return {
    getDataPath: () => '/tmp/unused',
    listArtifactRecords: () => [],
    readGrant: () => undefined,
    videoEdit: vi.fn(),
    isVideoEditEnabled: () => false,
    imageEdit: vi.fn(),
    isImageEditEnabled: () => true,
    ...overrides,
  };
}

describe('the image_edit loopback branch', () => {
  it('a disabled seat is 403, not 404 — the capability exists and is deliberately closed', async () => {
    const imageEdit = vi.fn();
    const result = await artifactCapabilityCallHandler(
      {
        operation: 'image_edit',
        handle: `evecap_${'1'.repeat(64)}`,
        permit: `evespend_${'2'.repeat(64)}`,
        instruction: 'heller',
      },
      deps({ isImageEditEnabled: () => false, imageEdit })
    );
    expect(result).toEqual({ status: 403, payload: { ok: false, reason: 'agent-image-edit-disabled' } });
    expect(imageEdit).not.toHaveBeenCalled();
  });

  it('a missing permit reaches the shared handler as empty and is refused BEFORE the provider — 400 with the named reason', async () => {
    // The shared handler is the authority; here a stand-in proves the loopback
    // passes the permit through unrepaired and maps the refusal to 400.
    const imageEdit = vi.fn(async () => ({
      ok: false as const,
      reasonCode: 'image-edit-permit-missing',
      message: 'Für eine Bildbearbeitung braucht es eine frische Anfrage von dir.',
      retryable: false,
    }));
    const result = await artifactCapabilityCallHandler(
      { operation: 'image_edit', handle: `evecap_${'1'.repeat(64)}`, instruction: 'heller' },
      deps({ imageEdit })
    );
    expect(result.status).toBe(400);
    expect(result.payload).toMatchObject({ ok: false, reason: 'image-edit-permit-missing' });
    expect(imageEdit).toHaveBeenCalledWith({ handle: `evecap_${'1'.repeat(64)}`, instruction: 'heller', permit: '' });
  });

  it('success is PATH-FREE: staged handle + parent id, no path, no MEDIA line, no bytes', async () => {
    const childHandle = `img_h_${'9'.repeat(64)}`;
    const imageEdit = vi.fn(async () => ({
      ok: true as const,
      artifactHandle: childHandle,
      parentArtifactId: 'img_parent1',
    }));
    const result = await artifactCapabilityCallHandler(
      {
        operation: 'image_edit',
        handle: `evecap_${'1'.repeat(64)}`,
        permit: `evespend_${'2'.repeat(64)}`,
        instruction: 'heller',
      },
      deps({ imageEdit })
    );
    expect(result).toEqual({
      status: 200,
      payload: { ok: true, artifact_id: childHandle, parent_artifact_id: 'img_parent1' },
    });
    const serialized = JSON.stringify(result.payload);
    for (const token of ['/Users/', 'file:', 'MEDIA:', 'data:image']) {
      expect(serialized).not.toContain(token);
    }
  });

  it('a refusal from the shared handler maps to 400 with its reason; unknown operations stay 400', async () => {
    const imageEdit = vi.fn(async () => ({
      ok: false as const,
      reasonCode: 'image-edit-handle-unknown',
      message: 'Dieser Bildbezug ist unbekannt.',
      retryable: false,
    }));
    const refused = await artifactCapabilityCallHandler(
      {
        operation: 'image_edit',
        handle: `evecap_${'4'.repeat(64)}`,
        permit: `evespend_${'5'.repeat(64)}`,
        instruction: 'x',
      },
      deps({ imageEdit })
    );
    expect(refused.status).toBe(400);
    expect(refused.payload).toMatchObject({ ok: false, reason: 'image-edit-handle-unknown' });

    const unsupported = await artifactCapabilityCallHandler({ operation: 'image_delete' }, deps());
    expect(unsupported).toEqual({ status: 400, payload: { ok: false, reason: 'unsupported-operation' } });
  });
});

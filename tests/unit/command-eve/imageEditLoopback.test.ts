import { describe, expect, it, vi } from 'vitest';

import {
  artifactCapabilityCallHandler,
  type ArtifactCapabilityLoopbackDeps,
} from '@/process/commandEve/artifactCapabilityLoopback';

const REQUEST_ID = 'a'.repeat(64);

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
        instruction: 'heller',
        requestId: REQUEST_ID,
      },
      deps({ isImageEditEnabled: () => false, imageEdit })
    );
    expect(result).toEqual({ status: 403, payload: { ok: false, reason: 'agent-image-edit-disabled' } });
    expect(imageEdit).not.toHaveBeenCalled();
  });

  it('forwards only handle, instruction, and the internal Hermes request identity', async () => {
    const imageEdit = vi.fn(async () => ({
      ok: true as const,
      artifactHandle: `img_h_${'9'.repeat(64)}`,
      parentArtifactId: 'img_parent1',
    }));
    await artifactCapabilityCallHandler(
      {
        operation: 'image_edit',
        handle: `evecap_${'1'.repeat(64)}`,
        instruction: 'heller',
        requestId: REQUEST_ID,
      },
      deps({ imageEdit })
    );
    expect(imageEdit).toHaveBeenCalledWith({
      handle: `evecap_${'1'.repeat(64)}`,
      instruction: 'heller',
      requestId: REQUEST_ID,
    });
  });

  it('does not repair a missing logical id before Main rejects the request', async () => {
    const imageEdit = vi.fn(async () => ({
      ok: false as const,
      reasonCode: 'image-edit-request-identity-missing',
      message: 'Die Bildbearbeitung hat keine gültige Hermes-Aufrufkennung erhalten.',
      retryable: false,
    }));
    const result = await artifactCapabilityCallHandler(
      { operation: 'image_edit', handle: `evecap_${'1'.repeat(64)}`, instruction: 'heller' },
      deps({ imageEdit })
    );
    expect(result).toMatchObject({
      status: 400,
      payload: { ok: false, reason: 'image-edit-request-identity-missing' },
    });
    expect(imageEdit).toHaveBeenCalledWith({
      handle: `evecap_${'1'.repeat(64)}`,
      instruction: 'heller',
      requestId: undefined,
    });
  });
});

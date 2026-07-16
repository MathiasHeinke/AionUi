import { describe, expect, it } from 'vitest';

import {
  COLIBRI_MODEL_SNAPSHOT,
  COLIBRI_MTP_PINS,
  COLIBRI_SOURCE,
  COMMAND_EVE_COLIBRI_MODEL_ID,
  isColibriModelRequest,
  resolveColibriPaths,
} from '@/process/commandEve/localInference/colibriManifest';

describe('Colibrì pinned manifest', () => {
  it('pins immutable source and uncensored model revisions', () => {
    expect(COLIBRI_SOURCE.commit).toMatch(/^[a-f0-9]{40}$/);
    expect(COLIBRI_SOURCE.sha256).toMatch(/^[a-f0-9]{64}$/);
    expect(COLIBRI_MODEL_SNAPSHOT.revision).toMatch(/^[a-f0-9]{40}$/);
    expect(COLIBRI_MODEL_SNAPSHOT.treeSha256).toMatch(/^[a-f0-9]{64}$/);
    expect(COLIBRI_MODEL_SNAPSHOT.fileCount).toBe(170);
    expect(COLIBRI_MODEL_SNAPSHOT.totalSizeBytes).toBe(383_957_283_536);
  });

  it('pins the three int8 MTP files rather than the broken int4 head', () => {
    expect(COLIBRI_MTP_PINS.map((pin) => pin.sizeBytes)).toEqual([3_527_131_672, 5_366_238_584, 1_065_950_496]);
    expect(COLIBRI_MTP_PINS.every((pin) => pin.path.endsWith('.safetensors'))).toBe(true);
  });

  it('keeps runtime files under the per-user Command EVE runtime root', () => {
    const paths = resolveColibriPaths('/tmp/eve-user');
    expect(paths.root).toBe('/tmp/eve-user/command-eve-runtime/local-inference/colibri-glm-5-2');
    expect(paths.enginePath).toContain(COLIBRI_SOURCE.commit);
    expect(paths.enginePath.endsWith('/c/glm')).toBe(true);
    expect(paths.modelDir.startsWith(paths.root)).toBe(true);
  });

  it('recognizes only the stable Colibrì runtime and ACP model ids', () => {
    expect(isColibriModelRequest(COMMAND_EVE_COLIBRI_MODEL_ID)).toBe(true);
    expect(isColibriModelRequest(`custom:${COMMAND_EVE_COLIBRI_MODEL_ID}`)).toBe(true);
    expect(isColibriModelRequest('glm-5.2')).toBe(false);
  });
});

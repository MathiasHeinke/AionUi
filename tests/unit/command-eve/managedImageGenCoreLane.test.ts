import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { viaShimMock } = vi.hoisted(() => ({ viaShimMock: vi.fn() }));

vi.mock('@/common/chat/managedImageGenerationClient', () => ({
  executeManagedImageGenerationViaShim: (...args: unknown[]) => viaShimMock(...args),
}));

import { executeImageGeneration } from '@/common/chat/imageGenCore';
import {
  COMMAND_EVE_MANAGED_IMAGE_MODEL,
  COMMAND_EVE_MANAGED_IMAGE_PLATFORM,
} from '@/common/config/eveManagedImageGenerationCore';
import type { TProviderWithModel } from '@/common/config/storage';

const HANDLE = `img_h_${'ab'.repeat(32)}`;

const managedProvider: TProviderWithModel = {
  id: 'command-eve-managed-image',
  name: 'EVE Visual Directions',
  platform: COMMAND_EVE_MANAGED_IMAGE_PLATFORM,
  base_url: 'http://127.0.0.1:41235/v1',
  api_key: 'nonce',
  use_model: COMMAND_EVE_MANAGED_IMAGE_MODEL,
};

const FORBIDDEN_TOKENS = ['/Users/', 'file:', 'MEDIA:', 'data:image'];

let workspace: string;

beforeEach(() => {
  workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'ceve-imagegen-ws-'));
  viaShimMock.mockReset();
  viaShimMock.mockResolvedValue({
    ok: true,
    artifactHandle: HANDLE,
    mediaType: 'image/png',
    sha256: 'a'.repeat(64),
    bytesCount: 380_000,
    resolution: '1K',
    aspectRatio: '16:9',
    model: 'Nano Banana 2',
  });
});

afterEach(() => {
  fs.rmSync(workspace, { recursive: true, force: true });
});

describe('the managed lane of executeImageGeneration (P0 leak gate)', () => {
  it('returns path-free tool text with the staged handle — and writes NOTHING to the workspace', async () => {
    const result = await executeImageGeneration({ prompt: 'eine Aubergine' }, managedProvider, workspace);
    expect(result.success).toBe(true);
    expect(result.text).toContain(HANDLE);
    for (const token of FORBIDDEN_TOKENS) expect(result.text).not.toContain(token);
    // No workspace save on the managed lane — the legacy `saveGeneratedImage`
    // path is unreachable from here.
    expect(result.imagePath).toBeUndefined();
    expect(result.relativeImagePath).toBeUndefined();
    expect(fs.readdirSync(workspace)).toEqual([]);
  });

  it('NEGATIVE: the legacy "Generated image saved to:" line is unreachable in the managed flow', async () => {
    // The legacy branch (path text, workspace write) exists for OTHER
    // providers only. For the managed provider the function MUST return
    // through the staged-handle branch — proven by the tokens being absent
    // even though the workspace dir is writable and named like a home path.
    const homeishWorkspace = path.join(workspace, 'Users', 'alice', 'conversations', 'conv-1');
    fs.mkdirSync(homeishWorkspace, { recursive: true });
    const result = await executeImageGeneration(
      { prompt: 'ein Bild', aspect_ratio: '16:9', resolution: '1K' },
      managedProvider,
      homeishWorkspace
    );
    expect(result.success).toBe(true);
    expect(result.text).not.toContain('Generated image saved to');
    expect(result.text).not.toContain(homeishWorkspace);
    expect(result.text).not.toContain('/Users/');
    expect(fs.readdirSync(homeishWorkspace)).toEqual([]);
  });

  it('a managed failure surfaces the error text and no handle', async () => {
    viaShimMock.mockResolvedValue({ ok: false, error: 'Managed image generation failed.' });
    const result = await executeImageGeneration({ prompt: 'x' }, managedProvider, workspace);
    expect(result.success).toBe(false);
    expect(result.text).not.toContain('img_h_');
    for (const token of FORBIDDEN_TOKENS) expect(result.text).not.toContain(token);
  });
});

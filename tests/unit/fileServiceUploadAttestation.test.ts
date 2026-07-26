/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it, vi } from 'vitest';

import { isAppOwnedUploadPathAttested } from '@/renderer/services/FileService';

describe('HTTP upload path attestation', () => {
  it('preserves WebUI behavior when no Electron bridge exists', async () => {
    await expect(isAppOwnedUploadPathAttested('/tmp/aionui/general/image.png', undefined)).resolves.toBe(true);
  });

  it('passes the exact backend path to the Electron attestation bridge', async () => {
    const registerAppUploadPath = vi.fn(async () => true);
    const filePath = '/tmp/aionui/conversation-1/image.png';

    await expect(isAppOwnedUploadPathAttested(filePath, { registerAppUploadPath })).resolves.toBe(true);
    expect(registerAppUploadPath).toHaveBeenCalledOnce();
    expect(registerAppUploadPath).toHaveBeenCalledWith(filePath);
  });

  it('fails closed when main rejects the backend-returned path', async () => {
    await expect(
      isAppOwnedUploadPathAttested('/outside/image.png', {
        registerAppUploadPath: async () => false,
      })
    ).resolves.toBe(false);
  });
});

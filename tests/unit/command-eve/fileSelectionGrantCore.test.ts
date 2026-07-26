/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  areCommandEveFileSelectionPathsGranted,
  clearCommandEveFileSelectionGrantsForTests,
  consumeCommandEveFileSelectionPathGrant,
  registerCommandEveAppOwnedUploadGrant,
  registerCommandEveFileSelectionGrant,
} from '@process/commandEve/fileSelectionGrantCore';

describe('Command EVE native file-selection grants', () => {
  const tempRoots: string[] = [];

  afterEach(() => {
    clearCommandEveFileSelectionGrantsForTests();
    for (const root of tempRoots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
  });

  it('binds a selected read path to the active seat and purpose', () => {
    const filePath = '/tmp/eve-user-selected/deck.pptx';
    expect(
      registerCommandEveFileSelectionGrant({
        filePath,
        seatId: 'seat-a',
        purpose: 'read',
        nowMs: 1_000,
      })
    ).toBe(true);
    expect(
      areCommandEveFileSelectionPathsGranted({
        filePaths: [filePath],
        seatId: 'seat-a',
        purpose: 'read',
        nowMs: 2_000,
      })
    ).toBe(true);
    expect(
      areCommandEveFileSelectionPathsGranted({
        filePaths: [filePath],
        seatId: 'seat-b',
        purpose: 'read',
        nowMs: 2_000,
      })
    ).toBe(false);
    expect(
      areCommandEveFileSelectionPathsGranted({
        filePaths: [filePath],
        seatId: 'seat-a',
        purpose: 'write',
        nowMs: 2_000,
      })
    ).toBe(false);
  });

  it('consumes a save-dialog write grant exactly once', () => {
    const filePath = '/tmp/eve-user-selected/report.pdf';
    expect(registerCommandEveFileSelectionGrant({ filePath, seatId: 'seat-a', purpose: 'write', nowMs: 1_000 })).toBe(
      true
    );
    expect(
      consumeCommandEveFileSelectionPathGrant({
        filePath,
        seatId: 'seat-a',
        purpose: 'write',
        nowMs: 2_000,
      })
    ).toBe(true);
    expect(
      consumeCommandEveFileSelectionPathGrant({
        filePath,
        seatId: 'seat-a',
        purpose: 'write',
        nowMs: 2_001,
      })
    ).toBe(false);
  });

  it('expires grants and rejects renderer-invented relative or nul paths', () => {
    expect(registerCommandEveFileSelectionGrant({ filePath: 'relative.pptx', seatId: 'seat-a', purpose: 'read' })).toBe(
      false
    );
    expect(
      registerCommandEveFileSelectionGrant({ filePath: '/tmp/bad\0name.pptx', seatId: 'seat-a', purpose: 'read' })
    ).toBe(false);
    expect(
      registerCommandEveFileSelectionGrant({
        filePath: '/tmp/expired.pptx',
        seatId: 'seat-a',
        purpose: 'read',
        nowMs: 1_000,
        ttlMs: 10,
      })
    ).toBe(true);
    expect(
      areCommandEveFileSelectionPathsGranted({
        filePaths: ['/tmp/expired.pptx'],
        seatId: 'seat-a',
        purpose: 'read',
        nowMs: 1_010,
      })
    ).toBe(false);
  });

  it('grants only real app-owned HTTP upload files below temp/aionui', () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'eve-app-upload-grant-'));
    tempRoots.push(tempDir);
    const uploadDir = path.join(tempDir, 'aionui', 'general');
    fs.mkdirSync(uploadDir, { recursive: true });
    const uploaded = path.join(uploadDir, 'screenshot.png');
    fs.writeFileSync(uploaded, Buffer.from('png'));

    expect(registerCommandEveAppOwnedUploadGrant({ filePath: uploaded, tempDir, seatId: 'seat-a', nowMs: 1_000 })).toBe(
      true
    );
    expect(
      areCommandEveFileSelectionPathsGranted({
        filePaths: [uploaded],
        seatId: 'seat-a',
        purpose: 'read',
        nowMs: 2_000,
      })
    ).toBe(true);

    const outside = path.join(tempDir, 'outside.png');
    fs.writeFileSync(outside, Buffer.from('outside'));
    expect(registerCommandEveAppOwnedUploadGrant({ filePath: outside, tempDir, seatId: 'seat-a' })).toBe(false);
  });

  it.runIf(process.platform !== 'win32')('rejects a symlink planted inside the app upload root', () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'eve-app-upload-link-'));
    tempRoots.push(tempDir);
    const uploadDir = path.join(tempDir, 'aionui', 'general');
    fs.mkdirSync(uploadDir, { recursive: true });
    const outside = path.join(tempDir, 'outside.png');
    const linked = path.join(uploadDir, 'linked.png');
    fs.writeFileSync(outside, Buffer.from('outside'));
    fs.symlinkSync(outside, linked);

    expect(registerCommandEveAppOwnedUploadGrant({ filePath: linked, tempDir, seatId: 'seat-a' })).toBe(false);
  });

  it.runIf(process.platform !== 'win32')('rejects an app upload root that is itself a symlink', () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'eve-app-upload-root-link-'));
    const outsideRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'eve-app-upload-outside-root-'));
    tempRoots.push(tempDir, outsideRoot);
    const outsideUploadDir = path.join(outsideRoot, 'general');
    fs.mkdirSync(outsideUploadDir, { recursive: true });
    const uploaded = path.join(outsideUploadDir, 'screenshot.png');
    fs.writeFileSync(uploaded, Buffer.from('outside'));
    fs.symlinkSync(outsideRoot, path.join(tempDir, 'aionui'));

    expect(registerCommandEveAppOwnedUploadGrant({ filePath: uploaded, tempDir, seatId: 'seat-a' })).toBe(false);
  });

  it('keeps the grant channel inside preload/main-owned selection paths', () => {
    const preload = fs.readFileSync(path.resolve('packages/desktop/src/preload/main.ts'), 'utf8');
    const dialogBridge = fs.readFileSync(path.resolve('packages/desktop/src/process/bridge/dialogBridge.ts'), 'utf8');
    const fileService = fs.readFileSync(path.resolve('packages/desktop/src/renderer/services/FileService.ts'), 'utf8');
    const imageBridge = fs.readFileSync(
      path.resolve('packages/desktop/src/process/bridge/commandEveImageBridge.ts'),
      'utf8'
    );
    const presentationBridge = fs.readFileSync(
      path.resolve('packages/desktop/src/process/bridge/commandEvePresentationBridge.ts'),
      'utf8'
    );

    expect(preload).toContain('webUtils.getPathForFile(file)');
    expect(preload).toContain('COMMAND_EVE_FILE_SELECTION_GRANT_CHANNEL');
    expect(preload).toContain('COMMAND_EVE_APP_UPLOAD_GRANT_CHANNEL');
    expect(preload).toContain('registerAppUploadPath');
    expect(preload).toContain('ipcRenderer.invoke(COMMAND_EVE_APP_UPLOAD_GRANT_CHANNEL');
    expect(dialogBridge).toContain("purpose: 'read'");
    expect(dialogBridge).toContain("purpose: 'write'");
    expect(dialogBridge).toContain("app.getPath('temp')");
    expect(dialogBridge).toContain('registerCommandEveAppOwnedUploadGrant');
    expect(dialogBridge).toContain('ipcMain.handle(COMMAND_EVE_APP_UPLOAD_GRANT_CHANNEL');
    expect(fileService).toContain('isAppOwnedUploadPathAttested(result.data)');
    expect(imageBridge).toContain('EVE_IMAGE_SOURCE_NOT_USER_SELECTED');
    expect(presentationBridge).toContain('EVE_PRESENTATION_SOURCE_NOT_USER_SELECTED');
  });
});

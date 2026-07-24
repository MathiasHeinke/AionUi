/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import fs from 'node:fs';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  areCommandEveFileSelectionPathsGranted,
  clearCommandEveFileSelectionGrantsForTests,
  consumeCommandEveFileSelectionPathGrant,
  registerCommandEveFileSelectionGrant,
} from '@process/commandEve/fileSelectionGrantCore';

describe('Command EVE native file-selection grants', () => {
  afterEach(() => clearCommandEveFileSelectionGrantsForTests());

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

  it('keeps the grant channel inside preload/main-owned selection paths', () => {
    const preload = fs.readFileSync(path.resolve('packages/desktop/src/preload/main.ts'), 'utf8');
    const dialogBridge = fs.readFileSync(path.resolve('packages/desktop/src/process/bridge/dialogBridge.ts'), 'utf8');
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
    expect(dialogBridge).toContain("purpose: 'read'");
    expect(dialogBridge).toContain("purpose: 'write'");
    expect(imageBridge).toContain('EVE_IMAGE_SOURCE_NOT_USER_SELECTED');
    expect(presentationBridge).toContain('EVE_PRESENTATION_SOURCE_NOT_USER_SELECTED');
  });
});

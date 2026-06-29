/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

// Issue 4: project rename persists a localStorage label override (the on-disk
// directory + conversation workspace paths are untouched), and clearing it
// restores the path-derived default.

import { describe, expect, it, beforeEach } from 'vitest';
import {
  getWorkspaceCustomName,
  setWorkspaceCustomName,
} from '@/renderer/utils/workspace/workspaceName';

const WS = '/Users/x/Developer/hermes-temp-6969007f';

describe('workspace custom name (project rename)', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it('is undefined before any rename', () => {
    expect(getWorkspaceCustomName(WS)).toBeUndefined();
  });

  it('persists a trimmed custom name', () => {
    setWorkspaceCustomName(WS, '  Mein Projekt  ');
    expect(getWorkspaceCustomName(WS)).toBe('Mein Projekt');
  });

  it('a blank name clears the override (restores default)', () => {
    setWorkspaceCustomName(WS, 'Renamed');
    expect(getWorkspaceCustomName(WS)).toBe('Renamed');
    setWorkspaceCustomName(WS, '   ');
    expect(getWorkspaceCustomName(WS)).toBeUndefined();
  });

  it('overrides are per-workspace', () => {
    setWorkspaceCustomName(WS, 'A');
    setWorkspaceCustomName('/other/path', 'B');
    expect(getWorkspaceCustomName(WS)).toBe('A');
    expect(getWorkspaceCustomName('/other/path')).toBe('B');
  });

  it('survives a corrupt store (fails soft to no override)', () => {
    localStorage.setItem('aionui_workspace_custom_name', '{not json');
    expect(getWorkspaceCustomName(WS)).toBeUndefined();
    // and a subsequent write recovers cleanly
    setWorkspaceCustomName(WS, 'Recovered');
    expect(getWorkspaceCustomName(WS)).toBe('Recovered');
  });
});

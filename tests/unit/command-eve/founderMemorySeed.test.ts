/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import { afterEach, describe, expect, it } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';

import {
  resolveCommandEveRuntimeBootstrapPaths,
  seedFounderUserProfile,
} from '@/process/commandEve/runtimeBootstrapCore';
import type { RuntimeBootstrapIdentityProfile } from '@/process/commandEve/runtimeBootstrapCore';

const mkProfile = (over: Partial<RuntimeBootstrapIdentityProfile> = {}): RuntimeBootstrapIdentityProfile => ({
  version: 'command-eve-first-run-profile/v0',
  source: 'registration',
  confidence: 'needs_confirmation',
  needs_confirmation: true,
  updated_at: '2026-06-26T00:00:00.000Z',
  founder_name: 'Mathias',
  company_name: 'FYN Labs',
  ...over,
});

describe('seedFounderUserProfile — durable founder memory bootstrap', () => {
  const dirs: string[] = [];
  const freshPaths = () => {
    const ud = fs.mkdtempSync(path.join(os.tmpdir(), 'eve-mem-seed-'));
    dirs.push(ud);
    return resolveCommandEveRuntimeBootstrapPaths(ud);
  };
  afterEach(() => {
    for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
  });

  it('seeds memories/USER.md with a reliable identity + the learning scaffold', () => {
    const paths = freshPaths();
    const wrote = seedFounderUserProfile(paths, mkProfile());
    expect(wrote).toBe(true);
    const md = fs.readFileSync(path.join(paths.hermesHome, 'memories', 'USER.md'), 'utf8');
    expect(md).toContain('Mathias');
    expect(md).toContain('FYN Labs');
    expect(md).toContain('Schreibstimme'); // the scaffold (voice capture) is present
    expect(md).toContain('§'); // entries use the memory tool's delimiter so EVE can append cleanly
  });

  it('does NOT enshrine placeholder-confidence garbage as the operator identity', () => {
    const paths = freshPaths();
    seedFounderUserProfile(
      paths,
      mkProfile({ confidence: 'placeholder', founder_name: 'Marketing', company_name: 'Mathiasheinke' })
    );
    const md = fs.readFileSync(path.join(paths.hermesHome, 'memories', 'USER.md'), 'utf8');
    expect(md).not.toContain('Marketing');
    expect(md).not.toContain('Mathiasheinke');
    expect(md).toContain('Noch keine bestätigte Identität'); // honest placeholder, asks instead of inventing
  });

  it('is idempotent — never clobbers a USER.md EVE has already grown', () => {
    const paths = freshPaths();
    const userMd = path.join(paths.hermesHome, 'memories', 'USER.md');
    fs.mkdirSync(path.dirname(userMd), { recursive: true });
    fs.writeFileSync(userMd, 'Operator heißt Mathias, mag knappe Antworten ohne Floskeln.');
    const wrote = seedFounderUserProfile(paths, mkProfile());
    expect(wrote).toBe(false);
    expect(fs.readFileSync(userMd, 'utf8')).toBe('Operator heißt Mathias, mag knappe Antworten ohne Floskeln.');
  });
});

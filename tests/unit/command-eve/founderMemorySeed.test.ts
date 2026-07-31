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
  COMMAND_EVE_RUNTIME_BOOTSTRAP_VERSION,
  resolveCommandEveRuntimeBootstrapPaths,
  seedFounderUserProfile,
  syncCommandEveRegistrationIdentityArtifacts,
} from '@/process/commandEve/runtimeBootstrapCore';
import type { RuntimeBootstrapIdentityProfile } from '@/process/commandEve/runtimeBootstrapCore';
import { registerTenant } from '@/process/commandEve/entitlementCore';

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

  it('adds a confirmed registration seed without changing grown memory during explicit reconciliation', () => {
    const paths = freshPaths();
    const userMd = path.join(paths.hermesHome, 'memories', 'USER.md');
    const grownMemory = 'Operator bevorzugt knappe Antworten.\nEine gewachsene Erinnerung bleibt exakt erhalten.\n';
    fs.mkdirSync(path.dirname(userMd), { recursive: true });
    fs.writeFileSync(userMd, grownMemory);

    const confirmedProfile = mkProfile({
      source: 'registration',
      confidence: 'verified',
      needs_confirmation: false,
      founder_name: 'Confirmed Founder',
      company_name: 'Confirmed Company',
    });
    const wrote = seedFounderUserProfile(paths, confirmedProfile, {
      allowConfirmedRegistrationInsert: true,
    });

    const reconciled = fs.readFileSync(userMd, 'utf8');
    expect(wrote).toBe(true);
    expect(reconciled).toContain('<!-- CE:OPERATOR-SEED:v1 -->');
    expect(reconciled).toContain('# Operator\nName: Confirmed Founder\nFirma/Brand: Confirmed Company');
    expect(reconciled.endsWith(grownMemory)).toBe(true);
    expect(seedFounderUserProfile(paths, confirmedProfile, { allowConfirmedRegistrationInsert: true })).toBe(false);
    expect(fs.readFileSync(userMd, 'utf8')).toBe(reconciled);
  });

  it('migrates the legacy machine seed and refreshes only the confirmed operator identity', () => {
    const paths = freshPaths();
    const userMd = path.join(paths.hermesHome, 'memories', 'USER.md');
    fs.mkdirSync(path.dirname(userMd), { recursive: true });
    fs.writeFileSync(
      userMd,
      [
        '# Operator\nName: Old macOS Guess\nFirma/Brand: (unbestätigt — beiläufig nachfragen)\n(Bei der Registrierung angegeben — beim ersten Gespräch kurz bestätigen lassen.)',
        '# Was ich über den Operator lernen + hier festhalten soll\n- bestehender Scaffold',
        '# Gewachsene Erinnerung\nAntworten bitte knapp.',
      ].join('\n§\n') + '\n'
    );

    const confirmedProfile = mkProfile({
      source: 'registration',
      confidence: 'verified',
      needs_confirmation: false,
      founder_name: 'Confirmed Founder',
      company_name: 'Confirmed Company',
    });
    const wrote = seedFounderUserProfile(paths, confirmedProfile);

    const refreshed = fs.readFileSync(userMd, 'utf8');
    expect(wrote).toBe(true);
    expect(refreshed).toContain('<!-- CE:OPERATOR-SEED:v1 -->');
    expect(refreshed).toContain('# Operator\nName: Confirmed Founder\nFirma/Brand: Confirmed Company');
    expect(refreshed).not.toContain('Old macOS Guess');
    expect(refreshed).toContain('# Gewachsene Erinnerung\nAntworten bitte knapp.');
    expect(seedFounderUserProfile(paths, confirmedProfile)).toBe(false);
    expect(fs.readFileSync(userMd, 'utf8')).toContain('# Gewachsene Erinnerung\nAntworten bitte knapp.');
  });

  it('synchronizes registration into profile, receipt and USER.md after the cold bootstrap', async () => {
    const paths = freshPaths();
    seedFounderUserProfile(
      paths,
      mkProfile({
        source: 'macos_full_name',
        founder_name: 'OS Guess',
        company_name: undefined,
      })
    );
    fs.mkdirSync(path.dirname(paths.receiptPath), { recursive: true });
    fs.writeFileSync(
      paths.receiptPath,
      JSON.stringify({
        version: COMMAND_EVE_RUNTIME_BOOTSTRAP_VERSION,
        app_release: '1.819.2',
        stages: [],
        identity: { source: 'macos_full_name', founder_name: 'OS Guess' },
      })
    );
    const registeredAt = new Date('2026-07-25T12:00:00.000Z');
    expect(
      registerTenant(
        {
          name: 'EVE Release Test',
          company: 'FYN Labs Release QA',
          email: 'eve-release@example.invalid',
          consent: true,
        },
        { userDataPath: paths.userDataPath, now: () => registeredAt }
      ).ok
    ).toBe(true);

    const synced = await syncCommandEveRegistrationIdentityArtifacts(paths.userDataPath, {
      env: {},
      now: () => new Date('2026-07-25T12:00:01.000Z'),
      displayNameLookup: () => '',
    });

    expect(synced.ok).toBe(true);
    expect(synced.profile).toMatchObject({
      source: 'registration',
      confidence: 'verified',
      needs_confirmation: false,
      founder_name: 'EVE Release Test',
      company_name: 'FYN Labs Release QA',
    });
    const userMd = fs.readFileSync(path.join(paths.hermesHome, 'memories', 'USER.md'), 'utf8');
    expect(userMd).toContain(
      '# Operator\nName: EVE Release Test\nFirma/Brand: FYN Labs Release QA\n(Bei der Registrierung angegeben.)'
    );
    expect(userMd).not.toContain('OS Guess');
    const receipt = JSON.parse(fs.readFileSync(paths.receiptPath, 'utf8'));
    expect(receipt.identity).toMatchObject({
      source: 'registration',
      confidence: 'verified',
      founder_name: 'EVE Release Test',
      company_name: 'FYN Labs Release QA',
      profile_path: paths.firstRunProfile,
    });
  });

  it('reconciles confirmed registration into an unmanaged grown USER.md without clobbering it', async () => {
    const paths = freshPaths();
    const userMd = path.join(paths.hermesHome, 'memories', 'USER.md');
    const grownMemory = 'Bestehende Erinnerung aus einer älteren Installation.\n';
    fs.mkdirSync(path.dirname(userMd), { recursive: true });
    fs.writeFileSync(userMd, grownMemory);
    fs.mkdirSync(path.dirname(paths.receiptPath), { recursive: true });
    fs.writeFileSync(
      paths.receiptPath,
      JSON.stringify({
        version: COMMAND_EVE_RUNTIME_BOOTSTRAP_VERSION,
        app_release: '1.820.1',
        stages: [],
      })
    );
    expect(
      registerTenant(
        {
          name: 'Explicit Founder',
          company: 'Explicit Company',
          email: 'explicit-founder@example.invalid',
          consent: true,
        },
        { userDataPath: paths.userDataPath, now: () => new Date('2026-07-31T05:00:00.000Z') }
      ).ok
    ).toBe(true);

    const synced = await syncCommandEveRegistrationIdentityArtifacts(paths.userDataPath, {
      env: {},
      now: () => new Date('2026-07-31T05:00:01.000Z'),
      displayNameLookup: () => '',
    });

    expect(synced.ok).toBe(true);
    expect(synced.operator_seed_changed).toBe(true);
    const reconciled = fs.readFileSync(userMd, 'utf8');
    expect(reconciled).toContain('# Operator\nName: Explicit Founder\nFirma/Brand: Explicit Company');
    expect(reconciled).toContain(grownMemory);
  });
});

/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  DEFAULT_COMMAND_EVE_MULTIMODAL_TTS_CONSENT,
  commandEveMultimodalTtsConsentPath,
  evaluateCommandEveMultimodalTtsConsentAllowed,
  parseCommandEveMultimodalTtsConsent,
  readCommandEveMultimodalTtsConsent,
  readCommandEveMultimodalTtsConsentFromFile,
  setCommandEveMultimodalTtsConsent,
  writeCommandEveMultimodalTtsConsentToFile,
} from '@/process/commandEve/multimodalTtsConsentCore';

const roots: string[] = [];
let root = '';

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'command-eve-multimodal-tts-consent-'));
  roots.push(root);
});

afterEach(() => {
  for (const dir of roots.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
  root = '';
});

describe('Command EVE multimodal TTS consent core', () => {
  it('defaults to not consented and cloud_auto lane', () => {
    expect(DEFAULT_COMMAND_EVE_MULTIMODAL_TTS_CONSENT).toEqual({
      consent: false,
      privacyLane: 'cloud_auto',
    });
    expect(readCommandEveMultimodalTtsConsent(root).consent).toBe(false);
  });

  it('parses fail-closed and only grants consent for boolean true', () => {
    expect(parseCommandEveMultimodalTtsConsent(undefined).consent).toBe(false);
    expect(parseCommandEveMultimodalTtsConsent('{no').consent).toBe(false);
    expect(parseCommandEveMultimodalTtsConsent('{"consent":"true","privacyLane":"cloud_us"}').consent).toBe(false);
    expect(parseCommandEveMultimodalTtsConsent('{"consent":true,"privacyLane":"cloud_us"}')).toMatchObject({
      consent: true,
      privacyLane: 'cloud_us',
    });
  });

  it('normalizes invalid and unsupported persisted privacy lanes back to cloud_auto', () => {
    expect(parseCommandEveMultimodalTtsConsent('{"consent":true,"privacyLane":"moon"}')).toMatchObject({
      consent: true,
      privacyLane: 'cloud_auto',
    });
    expect(parseCommandEveMultimodalTtsConsent('{"consent":true,"privacyLane":"cloud_eu"}')).toMatchObject({
      consent: true,
      privacyLane: 'cloud_auto',
    });
  });

  it('evaluates allowed only for explicit consent', () => {
    expect(evaluateCommandEveMultimodalTtsConsentAllowed(undefined)).toBe(false);
    expect(evaluateCommandEveMultimodalTtsConsentAllowed({ consent: false, privacyLane: 'cloud_us' })).toBe(false);
    expect(evaluateCommandEveMultimodalTtsConsentAllowed({ consent: true, privacyLane: 'cloud_us' })).toBe(true);
  });

  it('reads missing files as the fail-closed default', () => {
    const state = readCommandEveMultimodalTtsConsentFromFile('/missing.json', () => {
      throw new Error('ENOENT');
    });
    expect(state).toEqual(DEFAULT_COMMAND_EVE_MULTIMODAL_TTS_CONSENT);
  });

  it('writes normalized consent and preserves previous lane when no lane is supplied', () => {
    let written = '';
    const first = writeCommandEveMultimodalTtsConsentToFile(
      '/x.json',
      { consent: true, privacyLane: 'cloud_us' },
      (_p, data) => {
        written = data;
      }
    );
    expect(first).toMatchObject({ consent: true, privacyLane: 'cloud_us' });
    expect(JSON.parse(written)).toMatchObject({ consent: true, privacyLane: 'cloud_us' });

    const second = writeCommandEveMultimodalTtsConsentToFile(
      '/x.json',
      { consent: false },
      (_p, data) => {
        written = data;
      },
      first
    );
    expect(second).toMatchObject({ consent: false, privacyLane: 'cloud_us' });
    expect(JSON.parse(written)).toMatchObject({ consent: false, privacyLane: 'cloud_us' });
  });

  it('does not persist unsupported EU/DE lanes for the current US-only TTS consent slice', () => {
    const result = setCommandEveMultimodalTtsConsent(root, {
      consent: true,
      privacyLane: 'cloud_de',
    });

    expect(result).toMatchObject({ persisted: true, consent: true, privacyLane: 'cloud_auto' });
    expect(readCommandEveMultimodalTtsConsent(root)).toMatchObject({ consent: true, privacyLane: 'cloud_auto' });
  });

  it('persists through the filesystem with owner-only permissions', () => {
    const result = setCommandEveMultimodalTtsConsent(root, { consent: true, privacyLane: 'cloud_us' });

    expect(result).toMatchObject({
      version: 'command-eve-multimodal-tts-consent/v0',
      persisted: true,
      consent: true,
      privacyLane: 'cloud_us',
    });
    expect(readCommandEveMultimodalTtsConsent(root)).toMatchObject({ consent: true, privacyLane: 'cloud_us' });

    const mode = fs.statSync(commandEveMultimodalTtsConsentPath(root)).mode & 0o777;
    if (process.platform !== 'win32') {
      expect(mode).toBe(0o600);
    }
  });
});

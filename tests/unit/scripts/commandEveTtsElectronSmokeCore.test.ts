/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

// @ts-nocheck - the smoke core is an Electron-run .mjs helper with JS exports.
import crypto from 'node:crypto';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  buildCommandEveTtsSmokeRequest,
  commandEveTtsSmokeLicenseWirePath,
  parseCommandEveTtsSmokeConsent,
  parseCommandEveTtsSmokeLicenseWireRecord,
  redactServerControlledMessage,
  resolveCommandEveTtsSmokeUserDataPath,
  summarizeCommandEveTtsSmokeResponse,
} from '../../../scripts/command-eve-tts-electron-smoke-core.mjs';

describe('command-eve TTS Electron smoke core', () => {
  it('prefers the existing release license-wire path before dev/app fallbacks', () => {
    const homeDir = '/Users/tester';
    const releasePath = path.resolve(homeDir, '.command-eve');
    const chosen = resolveCommandEveTtsSmokeUserDataPath({
      env: {},
      homeDir,
      platform: 'darwin',
      appUserDataPath: path.join(homeDir, 'Library', 'Application Support', 'Electron'),
      existsSync: (candidate) => candidate === commandEveTtsSmokeLicenseWirePath(releasePath),
    });

    expect(chosen).toBe(releasePath);
  });

  it('honors an explicit userData override', () => {
    expect(
      resolveCommandEveTtsSmokeUserDataPath({
        env: { COMMAND_EVE_USER_DATA_PATH: '/tmp/command-eve-user-data' },
        homeDir: '/Users/tester',
      })
    ).toBe(path.resolve('/tmp/command-eve-user-data'));
  });

  it('rejects plaintext or malformed license-wire records', () => {
    expect(
      parseCommandEveTtsSmokeLicenseWireRecord('{"version":"command-eve-license-wire/v0","wire_ref":"CEVE.v2.a.b"}')
    ).toEqual({
      ok: false,
      reason_code: 'LICENSE_WIRE_NOT_A_REF',
    });
    expect(parseCommandEveTtsSmokeLicenseWireRecord('{}')).toEqual({
      ok: false,
      reason_code: 'LICENSE_WIRE_RECORD_INVALID',
    });
  });

  it('keeps consent fail-closed and preserves supported cloud lanes', () => {
    expect(parseCommandEveTtsSmokeConsent(undefined)).toEqual({ consent: false, privacyLane: 'cloud_auto' });
    expect(parseCommandEveTtsSmokeConsent('{"consent":true,"privacyLane":"cloud_us"}')).toEqual({
      consent: true,
      privacyLane: 'cloud_us',
    });
    expect(parseCommandEveTtsSmokeConsent('{"consent":true,"privacyLane":"cloud_de"}')).toEqual({
      consent: true,
      privacyLane: 'cloud_de',
    });
  });

  it('builds the server-side xAI TTS request without provider keys', () => {
    const request = buildCommandEveTtsSmokeRequest({
      text: '  Hallo   EVE  ',
      privacyLane: 'cloud_us',
      voiceId: 'eve voice!',
      language: 'de-DE',
      requestId: 'smoke 1',
    });

    expect(request).toMatchObject({
      ok: true,
      body: {
        provider: 'xai',
        capability: 'tts',
        privacyLane: 'cloud_us',
        directProviderKeyPresentInDesktop: false,
        text: 'Hallo EVE',
        voice_id: 'eve',
        language: 'de-DE',
        requestId: 'smoke-1',
      },
    });
    expect(JSON.stringify(request)).not.toMatch(/apiKey|api_key|xai-/i);
  });

  it('summarizes valid audio responses without leaking base64 audio', () => {
    const audio = Buffer.from([0, 1, 2, 3]);
    const response = {
      ok: true,
      provider: 'xai',
      capability: 'tts',
      reason: 'provider-complete',
      artifact: {
        status: 'created',
        kind: 'audio',
        mime_type: 'Audio/MPEG; codecs=mp3',
        encoding: 'base64',
        data_base64: audio.toString('base64'),
        bytes: audio.length,
      },
      residency: {
        requestedPrivacyLane: 'cloud_us',
        effectiveResidency: 'us_cloud',
        confirmation: 'explicit-us-cloud',
      },
      tts: {
        voice_id: 'eve',
        language: 'de-DE',
        text_length: 12,
        output_format: { codec: 'mp3' },
      },
    };

    const summarized = summarizeCommandEveTtsSmokeResponse(response, 'cloud_us');

    expect(summarized).toEqual({
      ok: true,
      provider: 'xai',
      capability: 'tts',
      mime_type: 'audio/mpeg',
      bytes: audio.length,
      audio_sha256: crypto.createHash('sha256').update(audio).digest('hex'),
      residency: {
        requestedPrivacyLane: 'cloud_us',
        effectiveResidency: 'us_cloud',
        confirmation: 'explicit-us-cloud',
      },
      tts: {
        voice_id: 'eve',
        language: 'de-DE',
        text_length: 12,
        output_format: { codec: 'mp3' },
      },
    });
    expect(JSON.stringify(summarized)).not.toContain(audio.toString('base64'));
  });

  it('fails closed on invalid media shapes and redacts server-controlled messages', () => {
    expect(
      summarizeCommandEveTtsSmokeResponse(
        {
          ok: true,
          provider: 'xai',
          capability: 'tts',
          reason: 'provider-complete',
          artifact: {
            status: 'created',
            kind: 'audio',
            mime_type: 'application/json',
            encoding: 'base64',
            data_base64: 'AAE=',
            bytes: 2,
          },
          residency: {
            requestedPrivacyLane: 'cloud_auto',
            effectiveResidency: 'us_cloud',
            confirmation: 'server-must-confirm-us-cloud',
          },
        },
        'cloud_auto'
      )
    ).toMatchObject({ ok: false, reason_code: 'EVE_MULTIMODAL_TTS_BAD_BODY' });
    expect(
      redactServerControlledMessage('debug Bearer CEVE.v2.secretpayload.secretsig and xai-secret1234567890')
    ).not.toContain('secret');
  });
});

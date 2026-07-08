/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';

import {
  buildTtsFailureArtifact,
  decideTtsReadAloudRoute,
  decideVoiceComposerAction,
} from '@/process/commandEve/voicePolishCore';

describe('Command EVE voice polish core', () => {
  it('maps Enter during recording to transcribe-only, never send', () => {
    expect(
      decideVoiceComposerAction({
        trigger: 'keyboard_enter',
        hasPendingSpeech: true,
        hasDraftText: false,
      })
    ).toEqual({
      action: 'transcribe_only',
      shouldSend: false,
      shouldTranscribe: true,
    });
  });

  it('maps the send arrow during recording to transcribe-then-send', () => {
    expect(
      decideVoiceComposerAction({
        trigger: 'send_button',
        hasPendingSpeech: true,
        hasDraftText: false,
      })
    ).toEqual({
      action: 'transcribe_then_send',
      shouldSend: true,
      shouldTranscribe: true,
    });
  });

  it('keeps shift-enter as text editing instead of speech submission', () => {
    expect(
      decideVoiceComposerAction({
        trigger: 'keyboard_enter',
        hasPendingSpeech: true,
        hasDraftText: true,
        shiftKey: true,
      })
    ).toEqual({
      action: 'noop',
      shouldSend: false,
      shouldTranscribe: false,
    });
  });

  it('maps manual transcribe to transcribe-only without sending', () => {
    expect(
      decideVoiceComposerAction({
        trigger: 'manual_transcribe',
        hasPendingSpeech: true,
        hasDraftText: true,
      })
    ).toEqual({
      action: 'transcribe_only',
      shouldSend: false,
      shouldTranscribe: true,
    });
  });

  it('routes local-only TTS to local speech when available and blocks cloud when not', () => {
    expect(
      decideTtsReadAloudRoute({
        privacyMode: 'local_only',
        userConsent: true,
        cloudGatewayReady: true,
        localSpeechAvailable: true,
        requestId: 'tts-1',
      })
    ).toEqual({
      ok: true,
      route: 'local_speech_synthesis',
      reasonCode: 'voice.tts.local-pass',
    });

    const blocked = decideTtsReadAloudRoute({
      privacyMode: 'local_only',
      userConsent: true,
      cloudGatewayReady: true,
      localSpeechAvailable: false,
      requestId: 'tts-2',
    });

    expect(blocked).toMatchObject({
      ok: false,
      route: 'local_speech_synthesis',
      reasonCode: 'voice.tts.blocked-local-only',
      failureArtifact: {
        artifactType: 'failure',
        title: 'Read aloud blocked',
        error: 'Cloud TTS is disabled while Datenschutz is local-only.',
        receipt: {
          requestId: 'tts-2',
          route: 'local',
          status: 'blocked',
          humanGate: 'HG-2',
        },
      },
    });
  });

  it('requires consent and gateway readiness before cloud TTS', () => {
    expect(
      decideTtsReadAloudRoute({
        privacyMode: 'privacy_first',
        userConsent: false,
        cloudGatewayReady: true,
        localSpeechAvailable: true,
        requestId: 'tts-3',
      })
    ).toMatchObject({
      ok: false,
      reasonCode: 'voice.tts.consent-required',
      failureArtifact: { receipt: { status: 'blocked', humanGate: 'HG-1' } },
    });

    expect(
      decideTtsReadAloudRoute({
        privacyMode: 'cloud_balanced',
        userConsent: true,
        cloudGatewayReady: false,
        localSpeechAvailable: true,
        requestId: 'tts-4',
      })
    ).toMatchObject({
      ok: false,
      reasonCode: 'voice.tts.gateway-not-ready',
      failureArtifact: { receipt: { status: 'failed' } },
    });
  });

  it('builds visible TTS failure artifacts with provider receipts', () => {
    expect(
      buildTtsFailureArtifact({
        requestId: 'tts-5',
        title: 'Read aloud failed',
        error: 'Provider timeout',
        privacyMode: 'cloud_balanced',
        route: 'xai',
        provider: 'xai',
        model: 'grok-tts',
      })
    ).toMatchObject({
      artifactType: 'failure',
      title: 'Read aloud failed',
      error: 'Provider timeout',
      receipt: {
        requestId: 'tts-5',
        provider: 'xai',
        model: 'grok-tts',
        route: 'xai',
        dataClass: 'S1-internal-low',
        humanGate: 'HG-1',
        status: 'failed',
      },
    });
  });
});

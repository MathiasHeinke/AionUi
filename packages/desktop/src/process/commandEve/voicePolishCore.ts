/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Command EVE voice polish contract (1.7.6 SG-08).
 *
 * The renderer owns mic/audio surfaces, but the behavioral contract must be
 * deterministic: Enter transcribes only, Send transcribes then sends, and any
 * failed read-aloud path can become a visible failure artifact.
 */

import {
  buildFailureArtifact,
  type GeneratedArtifactPayload,
  type GeneratedArtifactRoute,
} from './artifactContractCore';
import type { RuntimeGatePrivacyMode, SensitivityClass } from './runtimeGateCore';

export type VoiceComposerTrigger = 'keyboard_enter' | 'send_button' | 'manual_transcribe';
export type VoiceComposerAction = 'noop' | 'send_now' | 'transcribe_only' | 'transcribe_then_send';

export type VoiceComposerInput = {
  trigger: VoiceComposerTrigger;
  hasPendingSpeech: boolean;
  hasDraftText?: boolean;
  shiftKey?: boolean;
};

export type VoiceComposerDecision = {
  action: VoiceComposerAction;
  shouldSend: boolean;
  shouldTranscribe: boolean;
};

export type TtsReadAloudRouteDecision =
  | {
      ok: true;
      route: 'local_speech_synthesis' | 'cloud_tts';
      reasonCode: 'voice.tts.local-pass' | 'voice.tts.cloud-pass';
    }
  | {
      ok: false;
      route: 'cloud_tts';
      reasonCode: 'voice.tts.blocked-local-only' | 'voice.tts.consent-required' | 'voice.tts.gateway-not-ready';
      failureArtifact: GeneratedArtifactPayload;
    };

export type TtsFailureArtifactInput = {
  requestId: string;
  title: string;
  error: string;
  privacyMode: RuntimeGatePrivacyMode;
  dataClass?: SensitivityClass;
  route?: GeneratedArtifactRoute;
  provider?: string;
  model?: string;
  blocked?: boolean;
};

function decision(action: VoiceComposerAction): VoiceComposerDecision {
  return {
    action,
    shouldSend: action === 'send_now' || action === 'transcribe_then_send',
    shouldTranscribe: action === 'transcribe_only' || action === 'transcribe_then_send',
  };
}

function privacyDescription(privacyMode: RuntimeGatePrivacyMode): string {
  switch (privacyMode) {
    case 'local_only':
      return 'Cloud TTS is blocked by local-only privacy mode.';
    case 'privacy_first':
      return 'Cloud TTS requires explicit consent in privacy-first mode.';
    case 'cloud_balanced':
    default:
      return 'Cloud TTS could not produce audio.';
  }
}

export function decideVoiceComposerAction(input: VoiceComposerInput): VoiceComposerDecision {
  if (input.trigger === 'keyboard_enter') {
    if (input.shiftKey) return decision('noop');
    if (input.hasPendingSpeech) return decision('transcribe_only');
    return decision(input.hasDraftText ? 'send_now' : 'noop');
  }

  if (input.trigger === 'manual_transcribe') {
    return decision(input.hasPendingSpeech ? 'transcribe_only' : 'noop');
  }

  if (input.hasPendingSpeech) {
    return decision('transcribe_then_send');
  }
  return decision(input.hasDraftText ? 'send_now' : 'noop');
}

export function buildTtsFailureArtifact(input: TtsFailureArtifactInput): GeneratedArtifactPayload {
  return buildFailureArtifact({
    requestId: input.requestId,
    title: input.title,
    description: privacyDescription(input.privacyMode),
    error: input.error,
    dataClass: input.dataClass || 'S1-internal-low',
    humanGate: input.privacyMode === 'local_only' ? 'HG-2' : 'HG-1',
    route: input.route || 'xai',
    provider: input.provider,
    model: input.model,
    blocked: input.blocked,
  });
}

export function decideTtsReadAloudRoute(input: {
  privacyMode: RuntimeGatePrivacyMode;
  userConsent: boolean;
  cloudGatewayReady: boolean;
  localSpeechAvailable: boolean;
  requestId: string;
}): TtsReadAloudRouteDecision {
  if (input.privacyMode === 'local_only') {
    if (input.localSpeechAvailable) {
      return {
        ok: true,
        route: 'local_speech_synthesis',
        reasonCode: 'voice.tts.local-pass',
      };
    }
    return {
      ok: false,
      route: 'cloud_tts',
      reasonCode: 'voice.tts.blocked-local-only',
      failureArtifact: buildTtsFailureArtifact({
        requestId: input.requestId,
        title: 'Read aloud blocked',
        error: 'Cloud TTS is disabled while Datenschutz is local-only.',
        privacyMode: input.privacyMode,
        blocked: true,
      }),
    };
  }

  if (!input.userConsent) {
    return {
      ok: false,
      route: 'cloud_tts',
      reasonCode: 'voice.tts.consent-required',
      failureArtifact: buildTtsFailureArtifact({
        requestId: input.requestId,
        title: 'Read aloud needs consent',
        error: 'Cloud TTS needs explicit privacy consent before audio generation.',
        privacyMode: input.privacyMode,
        blocked: true,
      }),
    };
  }

  if (!input.cloudGatewayReady) {
    return {
      ok: false,
      route: 'cloud_tts',
      reasonCode: 'voice.tts.gateway-not-ready',
      failureArtifact: buildTtsFailureArtifact({
        requestId: input.requestId,
        title: 'Read aloud unavailable',
        error: 'Cloud TTS gateway is not ready.',
        privacyMode: input.privacyMode,
      }),
    };
  }

  return {
    ok: true,
    route: 'cloud_tts',
    reasonCode: 'voice.tts.cloud-pass',
  };
}

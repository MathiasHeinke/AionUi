import { describe, expect, it } from 'vitest';
import {
  DEFAULT_SPEECH_TO_TEXT_CONFIG,
  failClosedSpeechToTextConfig,
  normalizeSpeechToTextConfig,
} from '@/common/config/speechToTextConfigCore';

describe('speech-to-text product defaults', () => {
  it('enables bundled local speech input when persisted config is absent', () => {
    expect(normalizeSpeechToTextConfig()).toEqual(DEFAULT_SPEECH_TO_TEXT_CONFIG);
    expect(DEFAULT_SPEECH_TO_TEXT_CONFIG.enabled).toBe(true);
    expect(DEFAULT_SPEECH_TO_TEXT_CONFIG.provider).toBe('local');
    expect(DEFAULT_SPEECH_TO_TEXT_CONFIG.local?.model).toBe('small');
  });

  it('preserves an explicit operator disable', () => {
    const normalized = normalizeSpeechToTextConfig({
      enabled: false,
      provider: 'local',
    });

    expect(normalized.enabled).toBe(false);
    expect(normalized.provider).toBe('local');
  });

  it('represents an unavailable config read as disabled without changing product defaults', () => {
    expect(failClosedSpeechToTextConfig()).toMatchObject({
      enabled: false,
      provider: 'local',
      local: { model: 'small' },
    });
    expect(DEFAULT_SPEECH_TO_TEXT_CONFIG.enabled).toBe(true);
  });
});

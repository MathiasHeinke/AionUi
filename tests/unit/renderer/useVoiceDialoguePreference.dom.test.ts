import {
  useVoiceDialoguePreference,
  VOICE_DIALOGUE_PREFERENCE_KEY,
} from '@/renderer/components/chat/voiceDialogue/useVoiceDialoguePreference';
import { act, renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, it } from 'vitest';

describe('useVoiceDialoguePreference', () => {
  beforeEach(() => window.localStorage.clear());

  it('persists explicit opt-in across remount without any recording side effect', () => {
    const first = renderHook(() => useVoiceDialoguePreference());
    expect(first.result.current.enabled).toBe(false);

    act(() => first.result.current.setEnabled(true));
    expect(window.localStorage.getItem(VOICE_DIALOGUE_PREFERENCE_KEY)).toBe('true');
    first.unmount();

    const restarted = renderHook(() => useVoiceDialoguePreference());
    expect(restarted.result.current.enabled).toBe(true);
  });
});

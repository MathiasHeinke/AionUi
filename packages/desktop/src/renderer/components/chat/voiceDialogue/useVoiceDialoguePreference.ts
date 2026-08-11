import { useCallback, useEffect, useState } from 'react';

export const VOICE_DIALOGUE_PREFERENCE_KEY = 'command-eve.voice-dialogue.enabled';
const VOICE_DIALOGUE_PREFERENCE_EVENT = 'command-eve:voice-dialogue-preference';

const readPreference = (): boolean => {
  if (typeof window === 'undefined') return false;
  try {
    return window.localStorage.getItem(VOICE_DIALOGUE_PREFERENCE_KEY) === 'true';
  } catch {
    return false;
  }
};

export function useVoiceDialoguePreference() {
  const [enabled, setEnabledState] = useState(readPreference);

  useEffect(() => {
    const sync = () => setEnabledState(readPreference());
    window.addEventListener(VOICE_DIALOGUE_PREFERENCE_EVENT, sync);
    window.addEventListener('storage', sync);
    return () => {
      window.removeEventListener(VOICE_DIALOGUE_PREFERENCE_EVENT, sync);
      window.removeEventListener('storage', sync);
    };
  }, []);

  const setEnabled = useCallback((next: boolean) => {
    setEnabledState(next);
    try {
      window.localStorage.setItem(VOICE_DIALOGUE_PREFERENCE_KEY, String(next));
    } catch {
      // A blocked storage write keeps the current in-memory choice for this run.
    }
    window.dispatchEvent(new Event(VOICE_DIALOGUE_PREFERENCE_EVENT));
  }, []);

  return { enabled, setEnabled };
}

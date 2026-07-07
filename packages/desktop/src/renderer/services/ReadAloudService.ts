type ReadAloudOptions = {
  lang?: string;
  onEnd?: () => void;
  onError?: (event: SpeechSynthesisErrorEvent) => void;
  onStart?: () => void;
};

let activeUtterance: SpeechSynthesisUtterance | null = null;
const CANCELLED_READ_ALOUD_ERRORS = new Set(['canceled', 'cancelled', 'interrupted']);

export const isReadAloudAvailable = () =>
  typeof window !== 'undefined' &&
  'speechSynthesis' in window &&
  typeof window.speechSynthesis?.speak === 'function' &&
  typeof SpeechSynthesisUtterance !== 'undefined';

export const stopReadAloud = () => {
  if (!isReadAloudAvailable()) {
    activeUtterance = null;
    return;
  }
  window.speechSynthesis.cancel();
  activeUtterance = null;
};

export const readAloudText = (text: string, options?: ReadAloudOptions) => {
  const normalizedText = text.trim();
  if (!normalizedText || !isReadAloudAvailable()) {
    return false;
  }

  stopReadAloud();

  const utterance = new SpeechSynthesisUtterance(normalizedText);
  if (options?.lang) {
    utterance.lang = options.lang;
  }
  utterance.onstart = () => {
    activeUtterance = utterance;
    options?.onStart?.();
  };
  utterance.onend = () => {
    if (activeUtterance === utterance) {
      activeUtterance = null;
    }
    options?.onEnd?.();
  };
  utterance.onerror = (event) => {
    if (activeUtterance === utterance) {
      activeUtterance = null;
    }
    if (!CANCELLED_READ_ALOUD_ERRORS.has(event.error)) {
      options?.onError?.(event);
    }
  };

  window.speechSynthesis.speak(utterance);
  return true;
};

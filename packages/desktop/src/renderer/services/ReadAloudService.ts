type ReadAloudOptions = {
  lang?: string;
  onEnd?: () => void;
  onError?: () => void;
  onStart?: () => void;
};

let activeUtterance: SpeechSynthesisUtterance | null = null;

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
  utterance.onerror = () => {
    if (activeUtterance === utterance) {
      activeUtterance = null;
    }
    options?.onError?.();
  };

  window.speechSynthesis.speak(utterance);
  return true;
};

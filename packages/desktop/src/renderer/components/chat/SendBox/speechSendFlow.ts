import { appendSpeechTranscript } from '@/renderer/hooks/system/useSpeechInput';

export const shouldTranscribeSpeechOnEnter = (key: string, shiftKey: boolean, hasActiveSpeechInput: boolean) =>
  key === 'Enter' && !shiftKey && hasActiveSpeechInput;

export const shouldAbortPendingSpeechSend = (inputAtSendStart: string, domSnippetCount: number) =>
  !inputAtSendStart.trim() && domSnippetCount === 0;

export const buildSpeechSendDraft = (inputAtSendStart: string, speechTranscript: string | null) =>
  speechTranscript ? appendSpeechTranscript(inputAtSendStart, speechTranscript) : inputAtSendStart;

export const buildInputAfterSpeechSend = (inputAtSendStart: string, currentInput: string) => {
  if (currentInput === inputAtSendStart) {
    return '';
  }
  if (currentInput.startsWith(inputAtSendStart)) {
    return currentInput.slice(inputAtSendStart.length);
  }
  return currentInput;
};

import { ipcBridge } from '@/common';
import type { CommandEveMultimodalTtsArtifact } from '@/common/config/eveMultimodalGatewayCore';
import { isElectronDesktop } from '@/renderer/utils/platform';

type ReadAloudOptions = {
  lang?: string;
  onEnd?: () => void;
  onError?: (event: SpeechSynthesisErrorEvent) => void;
  onStart?: () => void;
  preferCloud?: boolean;
};

const COMMAND_EVE_READ_ALOUD_VOICE_ID = 'eve';

let activeUtterance: SpeechSynthesisUtterance | null = null;
let activeAudio: HTMLAudioElement | null = null;
let activeAudioUrl: string | null = null;
let activeReadAloudRunId = 0;
const CANCELLED_READ_ALOUD_ERRORS = new Set(['canceled', 'cancelled', 'interrupted']);

const isLocalReadAloudAvailable = () =>
  typeof window !== 'undefined' &&
  'speechSynthesis' in window &&
  typeof window.speechSynthesis?.speak === 'function' &&
  typeof SpeechSynthesisUtterance !== 'undefined';

const isCloudAudioReadAloudAvailable = () =>
  isElectronDesktop() &&
  typeof Audio !== 'undefined' &&
  typeof Blob !== 'undefined' &&
  typeof URL !== 'undefined' &&
  typeof URL.createObjectURL === 'function' &&
  typeof atob === 'function';

export const isReadAloudAvailable = () => isLocalReadAloudAvailable() || isCloudAudioReadAloudAvailable();

const createReadAloudRequestId = () => {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return `read-aloud-${crypto.randomUUID()}`;
  }
  return `read-aloud-${Date.now()}-${Math.random().toString(36).slice(2)}`;
};

const cleanupActiveAudio = () => {
  const audio = activeAudio;
  if (audio) {
    audio.pause();
    audio.removeAttribute('src');
    audio.load();
    activeAudio = null;
  }
  if (activeAudioUrl) {
    URL.revokeObjectURL(activeAudioUrl);
    activeAudioUrl = null;
  }
};

export const stopReadAloud = () => {
  activeReadAloudRunId += 1;
  cleanupActiveAudio();
  if (isLocalReadAloudAvailable()) {
    window.speechSynthesis.cancel();
  }
  activeUtterance = null;
};

const buildAudioBlobFromArtifact = (artifact: CommandEveMultimodalTtsArtifact) => {
  const binary = atob(artifact.data_base64);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return new Blob([bytes], { type: artifact.mime_type });
};

const playCloudAudioArtifact = async (
  artifact: CommandEveMultimodalTtsArtifact,
  options: ReadAloudOptions | undefined,
  runId: number
) => {
  const audioUrl = URL.createObjectURL(buildAudioBlobFromArtifact(artifact));
  const audio = new Audio(audioUrl);
  activeAudio = audio;
  activeAudioUrl = audioUrl;

  const cleanupIfCurrent = () => {
    if (activeAudio === audio) {
      cleanupActiveAudio();
    } else {
      URL.revokeObjectURL(audioUrl);
    }
  };

  audio.onplay = () => {
    if (runId === activeReadAloudRunId) {
      options?.onStart?.();
    }
  };
  audio.onended = () => {
    cleanupIfCurrent();
    if (runId === activeReadAloudRunId) {
      options?.onEnd?.();
    }
  };
  audio.onerror = () => {
    cleanupIfCurrent();
    if (runId === activeReadAloudRunId) {
      options?.onError?.({ error: 'audio-playback-failed' } as unknown as SpeechSynthesisErrorEvent);
    }
  };

  try {
    await audio.play();
    return true;
  } catch {
    cleanupIfCurrent();
    return false;
  }
};

const tryCloudReadAloud = async (text: string, options: ReadAloudOptions | undefined, runId: number) => {
  if (!isCloudAudioReadAloudAvailable() || options?.preferCloud === false) {
    return false;
  }

  try {
    const statusResponse = await ipcBridge.commandEve.multimodalTtsStatus.invoke(undefined);
    if (
      runId !== activeReadAloudRunId ||
      !statusResponse.success ||
      !statusResponse.data?.enabled ||
      statusResponse.data.reason_code !== 'EVE_MULTIMODAL_TTS_READY'
    ) {
      return runId !== activeReadAloudRunId;
    }

    const response = await ipcBridge.commandEve.multimodalTts.invoke({
      language: options?.lang,
      requestId: createReadAloudRequestId(),
      text,
      voiceId: COMMAND_EVE_READ_ALOUD_VOICE_ID,
    });
    if (runId !== activeReadAloudRunId) {
      return true;
    }
    if (!response.success || !response.data?.ok) {
      return false;
    }
    return playCloudAudioArtifact(response.data.artifact, options, runId);
  } catch {
    return false;
  }
};

const startLocalReadAloud = (normalizedText: string, options: ReadAloudOptions | undefined, runId: number) => {
  if (!isLocalReadAloudAvailable()) {
    return false;
  }
  const utterance = new SpeechSynthesisUtterance(normalizedText);
  if (options?.lang) {
    utterance.lang = options.lang;
  }
  utterance.onstart = () => {
    if (runId !== activeReadAloudRunId) {
      return;
    }
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

export const readAloudText = async (text: string, options?: ReadAloudOptions) => {
  const normalizedText = text.trim();
  if (!normalizedText || !isReadAloudAvailable()) {
    return false;
  }

  stopReadAloud();
  const runId = ++activeReadAloudRunId;
  const didStartCloud = await tryCloudReadAloud(normalizedText, options, runId);
  if (didStartCloud) {
    return true;
  }
  if (runId !== activeReadAloudRunId) {
    return true;
  }
  return startLocalReadAloud(normalizedText, options, runId);
};

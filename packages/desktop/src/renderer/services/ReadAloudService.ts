import { ipcBridge } from '@/common';
import type {
  CommandEveMultimodalTtsArtifact,
  CommandEveMultimodalTtsReceipt,
  CommandEveMultimodalTtsResidency,
} from '@/common/config/eveMultimodalGatewayCore';
import { isElectronDesktop } from '@/renderer/utils/platform';

export type ReadAloudCloudArtifact = {
  requestId: string;
  sourceUrl: string;
  artifact: CommandEveMultimodalTtsArtifact;
  provider: 'xai';
  residency: CommandEveMultimodalTtsResidency;
  tts?: CommandEveMultimodalTtsReceipt;
  createdAt: number;
};

type ReadAloudOptions = {
  lang?: string;
  onCloudArtifact?: (artifact: ReadAloudCloudArtifact) => void;
  onEnd?: () => void;
  onError?: (event: SpeechSynthesisErrorEvent) => void;
  onStart?: () => void;
  preferCloud?: boolean;
};

const COMMAND_EVE_READ_ALOUD_VOICE_ID = 'eve';
const LOCAL_VOICE_READY_TIMEOUT_MS = 1_500;

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

export function selectLocalSpeechVoice(
  voices: readonly SpeechSynthesisVoice[],
  language?: string
): SpeechSynthesisVoice | null {
  const localVoices = voices.filter((voice) => voice.localService === true);
  if (localVoices.length === 0) return null;
  const requested = language?.trim().toLowerCase();
  if (!requested) return localVoices.find((voice) => voice.default) ?? localVoices[0] ?? null;
  const exact = localVoices.find((voice) => voice.lang.trim().toLowerCase() === requested);
  if (exact) return exact;
  const requestedBase = requested.split('-')[0];
  return localVoices.find((voice) => voice.lang.trim().toLowerCase().split('-')[0] === requestedBase) ?? null;
}

const waitForLocalSpeechVoice = async (language?: string): Promise<SpeechSynthesisVoice | null> => {
  if (!isLocalReadAloudAvailable() || typeof window.speechSynthesis.getVoices !== 'function') return null;
  const initialVoices = window.speechSynthesis.getVoices();
  const initialMatch = selectLocalSpeechVoice(initialVoices, language);
  if (initialMatch || initialVoices.length > 0) return initialMatch;
  if (typeof window.speechSynthesis.addEventListener !== 'function') return null;

  return new Promise((resolve) => {
    let settled = false;
    const finish = (voice: SpeechSynthesisVoice | null) => {
      if (settled) return;
      settled = true;
      window.clearTimeout(timeout);
      window.speechSynthesis.removeEventListener('voiceschanged', handleVoicesChanged);
      resolve(voice);
    };
    const handleVoicesChanged = () => {
      const voices = window.speechSynthesis.getVoices();
      if (voices.length > 0) finish(selectLocalSpeechVoice(voices, language));
    };
    const timeout = window.setTimeout(() => finish(null), LOCAL_VOICE_READY_TIMEOUT_MS);
    window.speechSynthesis.addEventListener('voiceschanged', handleVoicesChanged);
  });
};

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

const buildAudioDataUrlFromArtifact = (artifact: CommandEveMultimodalTtsArtifact) =>
  `data:${artifact.mime_type};base64,${artifact.data_base64}`;

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
    const statusResponse = await ipcBridge.commandEve.multimodalTtsStatus.invoke({});
    if (
      runId !== activeReadAloudRunId ||
      !statusResponse.success ||
      !statusResponse.data?.enabled ||
      statusResponse.data.reason_code !== 'EVE_MULTIMODAL_TTS_READY'
    ) {
      return runId !== activeReadAloudRunId;
    }

    const requestId = createReadAloudRequestId();
    const response = await ipcBridge.commandEve.multimodalTts.invoke({
      language: options?.lang,
      requestId,
      text,
      voiceId: COMMAND_EVE_READ_ALOUD_VOICE_ID,
    });
    if (runId !== activeReadAloudRunId) {
      return true;
    }
    if (!response.success || !response.data?.ok) {
      return false;
    }
    const didPlay = await playCloudAudioArtifact(response.data.artifact, options, runId);
    if (didPlay && runId === activeReadAloudRunId) {
      options?.onCloudArtifact?.({
        requestId,
        sourceUrl: buildAudioDataUrlFromArtifact(response.data.artifact),
        artifact: response.data.artifact,
        provider: response.data.provider,
        residency: response.data.residency,
        tts: response.data.tts,
        createdAt: Date.now(),
      });
    }
    return didPlay;
  } catch {
    return false;
  }
};

const startLocalReadAloud = async (normalizedText: string, options: ReadAloudOptions | undefined, runId: number) => {
  if (!isLocalReadAloudAvailable()) {
    return false;
  }
  const voice = await waitForLocalSpeechVoice(options?.lang);
  if (runId !== activeReadAloudRunId) return true;
  if (!voice) return false;
  const utterance = new SpeechSynthesisUtterance(normalizedText);
  utterance.voice = voice;
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
    if (runId !== activeReadAloudRunId) return;
    if (activeUtterance === utterance) {
      activeUtterance = null;
    }
    options?.onEnd?.();
  };
  utterance.onerror = (event) => {
    if (runId !== activeReadAloudRunId) return;
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

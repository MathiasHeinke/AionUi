import type { TMessage } from '@/common/chat/chatLib';
import type { SpeechInputStatus } from '@/renderer/hooks/system/useSpeechInput';
import { readAloudText, stopReadAloud } from '@/renderer/services/ReadAloudService';
import { emitAcpPerformanceMark } from '@/renderer/utils/performance/acpPerformanceMarks';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  findLatestAssistantMessageId,
  resolveVoiceDialogueLanguage,
  resolveVoiceDialoguePhase,
  selectAssistantReplyAfter,
  type VoiceDialoguePlaybackState,
} from './voiceDialogueCore';
import { useVoiceDialoguePreference } from './useVoiceDialoguePreference';

export type VoiceDialogueCompletion = {
  sequence: number;
  turnId: string;
  completedAt: number;
};

type PendingVoiceTurn = {
  afterCompletionSequence: number;
  baselineAssistantMessageId: string | null;
  expectedTurnId: string | null;
};

export function useVoiceDialogue(input: {
  activeTurnId: string | null;
  available: boolean;
  completion: VoiceDialogueCompletion | null;
  conversationId: string;
  isTurnActive: boolean;
  language?: string;
  messages: TMessage[];
  speechStatus: SpeechInputStatus;
  turnErrored: boolean;
}) {
  const preference = useVoiceDialoguePreference();
  const enabled = input.available && preference.enabled;
  const [playbackState, setPlaybackState] = useState<VoiceDialoguePlaybackState>('idle');
  const pendingTurnRef = useRef<PendingVoiceTurn | null>(null);
  const previousTurnActiveRef = useRef(false);
  const handledCompletionSequenceRef = useRef(0);
  const ownsReadAloudRef = useRef(false);
  const playbackRunRef = useRef(0);
  const conversationIdRef = useRef(input.conversationId);

  useEffect(() => {
    if (conversationIdRef.current === input.conversationId) return;
    conversationIdRef.current = input.conversationId;
    pendingTurnRef.current = null;
    handledCompletionSequenceRef.current = 0;
    previousTurnActiveRef.current = false;
    playbackRunRef.current += 1;
    if (ownsReadAloudRef.current) stopReadAloud();
    ownsReadAloudRef.current = false;
    setPlaybackState('idle');
  }, [input.conversationId, input.isTurnActive]);

  useEffect(() => {
    const wasActive = previousTurnActiveRef.current;
    if (enabled && !wasActive && input.isTurnActive) {
      playbackRunRef.current += 1;
      stopReadAloud();
      ownsReadAloudRef.current = false;
      pendingTurnRef.current = {
        afterCompletionSequence: input.completion?.sequence ?? 0,
        baselineAssistantMessageId: findLatestAssistantMessageId(input.messages),
        expectedTurnId: input.activeTurnId,
      };
      setPlaybackState('idle');
    }
    previousTurnActiveRef.current = input.isTurnActive;
  }, [enabled, input.activeTurnId, input.completion?.sequence, input.isTurnActive, input.messages]);

  useEffect(() => {
    const pending = pendingTurnRef.current;
    if (!enabled || !input.isTurnActive || !input.activeTurnId || !pending || pending.expectedTurnId) return;
    pendingTurnRef.current = {
      ...pending,
      expectedTurnId: input.activeTurnId,
    };
  }, [enabled, input.activeTurnId, input.isTurnActive]);

  useEffect(() => {
    if (!enabled || !input.turnErrored) return;
    pendingTurnRef.current = null;
    playbackRunRef.current += 1;
    ownsReadAloudRef.current = false;
    stopReadAloud();
    setPlaybackState('error');
  }, [enabled, input.turnErrored]);

  useEffect(() => {
    const completion = input.completion;
    const pending = pendingTurnRef.current;
    if (!enabled || !completion || !pending) return;
    if (!pending.expectedTurnId || completion.turnId !== pending.expectedTurnId) return;
    if (completion.sequence <= pending.afterCompletionSequence) return;
    if (completion.sequence <= handledCompletionSequenceRef.current) return;

    const reply = selectAssistantReplyAfter(input.messages, pending.baselineAssistantMessageId);
    if (!reply) return;

    handledCompletionSequenceRef.current = completion.sequence;
    pendingTurnRef.current = null;
    setPlaybackState('idle');
    const playbackRun = playbackRunRef.current + 1;
    playbackRunRef.current = playbackRun;
    ownsReadAloudRef.current = true;
    const isCurrentPlayback = () => playbackRunRef.current === playbackRun;
    void readAloudText(reply.text, {
      lang: resolveVoiceDialogueLanguage(input.language),
      preferCloud: false,
      onStart: () => {
        if (!isCurrentPlayback()) return;
        emitAcpPerformanceMark({
          stage: 'tts_playback_started',
          conversationId: input.conversationId,
          turnId: completion.turnId,
        });
        setPlaybackState('speaking');
      },
      onEnd: () => {
        if (!isCurrentPlayback()) return;
        ownsReadAloudRef.current = false;
        setPlaybackState('idle');
      },
      onError: () => {
        if (!isCurrentPlayback()) return;
        ownsReadAloudRef.current = false;
        setPlaybackState('error');
      },
    })
      .then((started) => {
        if (!isCurrentPlayback()) return;
        if (!started) {
          ownsReadAloudRef.current = false;
          setPlaybackState('error');
        }
      })
      .catch(() => {
        if (!isCurrentPlayback()) return;
        ownsReadAloudRef.current = false;
        setPlaybackState('error');
      });
  }, [enabled, input.completion, input.conversationId, input.language, input.messages]);

  const cancel = useCallback(() => {
    pendingTurnRef.current = null;
    playbackRunRef.current += 1;
    ownsReadAloudRef.current = false;
    stopReadAloud();
    setPlaybackState('idle');
  }, []);

  useEffect(
    () => () => {
      playbackRunRef.current += 1;
      if (ownsReadAloudRef.current) stopReadAloud();
    },
    []
  );

  const toggle = useCallback(() => {
    const next = !preference.enabled;
    if (!next) cancel();
    preference.setEnabled(next);
  }, [cancel, preference]);

  const beforeStartRecording = useCallback(() => {
    const shouldCancelTurn = input.isTurnActive;
    cancel();
    return shouldCancelTurn;
  }, [cancel, input.isTurnActive]);

  const phase = useMemo(
    () =>
      resolveVoiceDialoguePhase({
        enabled,
        speechStatus: input.speechStatus,
        turnActive: input.isTurnActive,
        playbackState,
      }),
    [enabled, input.isTurnActive, input.speechStatus, playbackState]
  );

  return {
    beforeStartRecording,
    cancel,
    enabled,
    phase,
    toggle,
  };
}

/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import type { TMessage } from '@/common/chat/chatLib';
import { scrubModelIdentifiers } from '@/common/config/modelIdentifierScrub';
import { parseError, uuid } from '@/common/utils';
import { CLOUD_MODEL_IDENTIFIERS } from '@/renderer/utils/model/modelContextLimits';
import { useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { getConversationRuntimeWorkspaceErrorMessage } from '../../utils/conversationCreateError';
import { buildSendFailureError } from './buildSendFailureError';
import {
  parseComposerWorkProductSelection,
  type ComposerWorkProductSelection,
} from '@/common/config/composerWorkProductModeCore';

type UseAcpInitialMessageParams = {
  conversation_id: string;
  sendInitialMessage: (
    input: string,
    files: string[],
    videoSelection: InitialVideoSelection | undefined,
    composerSelection: ComposerWorkProductSelection
  ) => Promise<boolean>;
  resetState: () => void;
  addOrUpdateMessage: (message: TMessage, prepend?: boolean) => void;
  /**
   * The quota-wall feed (`useQuotaWall().reportInferenceError`), threaded down
   * from `messageState` so a 402 quota_exhausted that kills the SEND surfaces
   * the same warm wall the stream-error lane shows — not a cold
   * UNKNOWN_UPSTREAM_ERROR card. Optional so the hook stays mountable without
   * the wall (tests); absent means every failure takes the cold path.
   */
  reportInferenceError?: (error: unknown, opts: { jobInFlight: boolean }) => boolean;
};

/**
 * Strip a leaked machine body from a user-visible send-failure sentence.
 *
 * WHY THIS EXISTS (quota forensics, CEVE-18205): when Hermes dies on a shim
 * 402, the whole provider body travels as flat text — python-repr JSON
 * included — through the backend's 502 into `parseError`, and the card showed
 * it raw (the observed residue ended in `0.1}]}`). The friendly half of the
 * sentence is worth keeping; the blob is not, in ANY failure, so the cut lives
 * here at the shared binding rather than in one sink.
 *
 * Two cuts, deliberately narrow:
 *   1. one `{…}` span (first `{` to last `}`) — the embedded object body;
 *   2. orphaned tail tokens that contain a closing `}`/`]` but no opener —
 *      what survives when an upstream truncation already ate the blob's head.
 *      Balanced tokens like the `[ACP-AUTH-…]` markers keep both brackets and
 *      pass through untouched — the auth-branch match downstream depends on it.
 *
 * Returns '' when nothing readable remains; the caller falls back to its own
 * translated unknown-error copy, never to an empty card.
 */
export const stripEmbeddedJsonFromSendFailureText = (text: string): string => {
  return text
    .replace(/\{[\s\S]*\}/, ' ')
    .split(/\s+/)
    .filter((token) => !/[}\]]/.test(token) || /[{[]/.test(token))
    .join(' ')
    .replace(/[\s:\-–—]+$/, '')
    .trim();
};

/** The picker's selection, carried from the start-chat surface (MAT-1773 P3). */
export type InitialVideoSelection = {
  modelId: string;
  resolution: string | null;
  durationSeconds: number;
};

/** Defensive read of the carried selection — sessionStorage is not trusted. */
const parseInitialVideoSelection = (value: unknown): InitialVideoSelection | undefined => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  if (typeof record.modelId !== 'string' || record.modelId.trim().length === 0) return undefined;
  if (
    typeof record.durationSeconds !== 'number' ||
    !Number.isFinite(record.durationSeconds) ||
    record.durationSeconds <= 0
  ) {
    return undefined;
  }
  return {
    modelId: record.modelId,
    resolution: typeof record.resolution === 'string' && record.resolution ? record.resolution : null,
    durationSeconds: record.durationSeconds,
  };
};

/**
 * Side-effect-only hook that checks sessionStorage for an initial message
 * and sends it when the ACP conversation first mounts.
 */
export const useAcpInitialMessage = ({
  conversation_id,
  sendInitialMessage,
  resetState,
  addOrUpdateMessage,
  reportInferenceError,
}: UseAcpInitialMessageParams): void => {
  const { t } = useTranslation();

  useEffect(() => {
    const storageKey = `acp_initial_message_${conversation_id}`;
    const storedMessage = sessionStorage.getItem(storageKey);

    if (!storedMessage) return;

    // Clear immediately to prevent duplicate sends (e.g., if component remounts while sendMessage is pending)
    sessionStorage.removeItem(storageKey);

    const submitStoredMessage = async () => {
      try {
        const initialMessage = JSON.parse(storedMessage) as {
          input?: unknown;
          files?: unknown;
          videoSelection?: unknown;
          composerSelection?: unknown;
        };
        const input = typeof initialMessage.input === 'string' ? initialMessage.input : '';
        const files = Array.isArray(initialMessage.files)
          ? initialMessage.files.filter((file): file is string => typeof file === 'string')
          : [];
        const videoSelection = parseInitialVideoSelection(initialMessage.videoSelection);
        const composerSelection = parseComposerWorkProductSelection(initialMessage.composerSelection);

        // The fresh-chat handoff must use the exact same preparation, cost-wall,
        // queue, runtime, and recovery path as an in-chat send.
        const accepted = await sendInitialMessage(input, files, videoSelection, composerSelection);
        // A shared submission can fail closed without throwing (for example a
        // visual-policy receipt or local preparation failure). The start-chat
        // surface has no stream event in that case, so it must explicitly
        // release its loading state instead of showing "EVE denkt" forever.
        if (!accepted) resetState();
      } catch (error) {
        // SCRUBBED (MAT-1749) AT THE BINDING: this sentence is rendered into the
        // chat as a `tips` message and handed to `buildSendFailureError`, and it
        // originates upstream, so it can carry a provider/model id. The console
        // lines below keep the RAW `error` object for debugging — that is the
        // debugging half and must not be confused with the user-facing one.
        const errorMessageText =
          stripEmbeddedJsonFromSendFailureText(
            scrubModelIdentifiers(
              getConversationRuntimeWorkspaceErrorMessage(error, t) || parseError(error) || t('common.unknownError'),
              CLOUD_MODEL_IDENTIFIERS
            )
          ) || t('common.unknownError');
        console.error('[useAcpInitialMessage] Error sending initial message:', error);
        console.error('[useAcpInitialMessage] Error details:', {
          name: (error as Error)?.name,
          message: errorMessageText,
          conversation_id,
        });

        // CEVE-18205 quota gate — ask the wall BEFORE building the cold card.
        // A recognized 402 quota_exhausted (or empty-tank daily cap) surfaces
        // the warm wall; `jobInFlight: true` because the user just actively
        // submitted this send — exactly the in-flight attempt the walls'
        // idle-suppression exists to require. In that case the cold card would
        // only contradict the wall, so it is skipped; every other failure
        // renders exactly as before.
        if (reportInferenceError?.(error, { jobInFlight: true }) === true) {
          resetState();
          return;
        }

        const errorMessage: TMessage = {
          id: uuid(),
          msg_id: uuid(),
          conversation_id: conversation_id,
          type: 'tips',
          position: 'center',
          content: {
            content: errorMessageText,
            type: 'error',
            error: buildSendFailureError(error, errorMessageText),
          },
          created_at: Date.now() + 2,
        };
        addOrUpdateMessage(errorMessage, true);
        resetState();
      }
    };

    submitStoredMessage().catch((error) => {
      console.error('Failed to send initial message:', error);
    });
  }, [addOrUpdateMessage, conversation_id, reportInferenceError, resetState, sendInitialMessage, t]);
};

/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import { conversation } from '@/common/adapter/ipcBridge';
import type { IMessageAcpPermission } from '@/common/chat/chatLib';
import {
  parseComposerArtifactFollowupTarget,
  resolveComposerArtifactReference,
  type ComposerArtifactReference,
} from '@/common/config/composerArtifactReferenceCore';
import { estimateVideoEditCredits } from '@/common/config/videoEditRequestCore';
import {
  hydrateVideoArtifactPayload,
  isVideoEditEligibleTier,
  resolveVideoArtifactTier,
  type CommandEveVideoConversationArtifactPayload,
} from '@/common/config/videoGenerationRequestCore';
import {
  isUsableMediaEditSource,
  isVisibleConversationArtifact,
  useConversationArtifacts,
} from '@/renderer/pages/conversation/Messages/artifacts';
import { emitter } from '@/renderer/utils/emitter';
import { Button, Card } from '@arco-design/web-react';
import { Comment, FileExcel, FilePdf, FileWord, Picture, Projector, Video } from '@renderer/components/icons';
import React, { useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { isExplicitPermissionFailure, isPermissionCardInactive } from './permissionCardPolicy';
import styles from './MessageAcpClarify.module.css';

type ArtifactFollowupMode = ComposerArtifactReference['mode'];

const FOLLOWUP_MODES = new Set<ArtifactFollowupMode>(['image', 'video', 'word', 'excel']);

function recordOf(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

function safeFollowupMode(value: unknown): ArtifactFollowupMode | null {
  return typeof value === 'string' && FOLLOWUP_MODES.has(value as ArtifactFollowupMode)
    ? (value as ArtifactFollowupMode)
    : null;
}

const referenceIcon = (mode: ArtifactFollowupMode): React.ReactNode => {
  const props = { theme: 'outline' as const, size: 17, fill: 'currentColor', 'aria-hidden': true };
  if (mode === 'image') return <Picture {...props} />;
  if (mode === 'video') return <Video {...props} />;
  if (mode === 'presentation') return <Projector {...props} />;
  if (mode === 'pdf') return <FilePdf {...props} />;
  if (mode === 'word') return <FileWord {...props} />;
  return <FileExcel {...props} />;
};

const MessageAcpClarify: React.FC<{ message: IMessageAcpPermission }> = React.memo(({ message }) => {
  const { t } = useTranslation();
  const artifacts = useConversationArtifacts();
  const content = recordOf(message.content) ?? {};
  const toolCall = recordOf(content.tool_call) ?? {};
  const rawInput = recordOf(toolCall.raw_input) ?? {};
  const metadata = recordOf(rawInput.metadata) ?? {};
  const rawQuestion = typeof metadata.question === 'string' ? metadata.question : String(toolCall.title ?? '');
  const sourceUserTurn =
    typeof metadata.source_user_turn === 'string' && metadata.source_user_turn.length <= 8000
      ? metadata.source_user_turn.trim()
      : '';
  const followupMode =
    metadata.interaction_kind === 'artifact_followup' ? safeFollowupMode(metadata.artifact_mode) : null;
  const followupTarget = useMemo(
    () => (followupMode ? parseComposerArtifactFollowupTarget(rawQuestion) : null),
    [followupMode, rawQuestion]
  );
  const referenceUnavailable = t('conversation.workProduct.referenceUnavailable', {
    defaultValue: 'Dieses Artefakt kann nicht mehr als Bearbeitungsquelle verwendet werden.',
  });
  const question = followupMode ? (followupTarget?.question ?? referenceUnavailable) : rawQuestion;
  const options = Array.isArray(content.options) ? content.options : [];
  const cardStatus = content.status ?? content.lifecycle_status ?? toolCall.status;
  const inactive = isPermissionCardInactive(cardStatus);
  const [responding, setResponding] = useState(false);
  const [respondedLabel, setRespondedLabel] = useState<string | null>(null);
  const [responseError, setResponseError] = useState<string | null>(null);
  const respondingRef = useRef(false);
  const respondedRef = useRef(false);

  const followupCandidate = useMemo(() => {
    if (!followupMode || !followupTarget) return null;
    const artifact = artifacts.find((candidate) => candidate.id === followupTarget.artifactId);
    if (!artifact || !isVisibleConversationArtifact(artifact)) return null;
    const reference = resolveComposerArtifactReference(artifact);
    if (
      !reference ||
      reference.mode !== followupMode ||
      reference.conversationId !== message.conversation_id ||
      reference.artifactId !== followupTarget.artifactId
    ) {
      return null;
    }
    if ((reference.mode === 'image' || reference.mode === 'video') && !isUsableMediaEditSource(artifact)) return null;
    return { artifact, reference };
  }, [artifacts, followupMode, followupTarget, message.conversation_id]);
  const followupReference = followupCandidate?.reference ?? null;

  const videoEditEstimate = useMemo(() => {
    if (followupCandidate?.reference.mode !== 'video') return null;
    try {
      const payload = hydrateVideoArtifactPayload(
        followupCandidate.artifact.payload as CommandEveVideoConversationArtifactPayload
      );
      const tierId = resolveVideoArtifactTier(payload);
      if (!isVideoEditEligibleTier(tierId)) return null;
      const credits = estimateVideoEditCredits(tierId, payload.duration_seconds);
      return Number.isFinite(credits) ? { credits, seconds: payload.duration_seconds } : null;
    } catch {
      return null;
    }
  }, [followupCandidate]);

  const answer = async (option: Record<string, unknown>) => {
    if (respondingRef.current || respondedRef.current || inactive) return;
    const optionId = typeof option.option_id === 'string' ? option.option_id : '';
    const optionLabel = typeof option.name === 'string' ? option.name : '';
    if (!optionId || !optionLabel) return;
    if (optionId === 'clarify_choice_0' && followupMode && !followupReference) return;
    respondingRef.current = true;
    setResponding(true);
    setResponseError(null);
    try {
      const result = await conversation.confirmMessage.invoke({
        confirm_key: optionId,
        msg_id: message.id,
        conversation_id: message.conversation_id,
        call_id: typeof toolCall.tool_call_id === 'string' ? toolCall.tool_call_id : message.id,
      });
      if (isExplicitPermissionFailure(result)) throw new Error('Clarify response rejected.');
      respondedRef.current = true;
      setRespondedLabel(optionLabel);
      if (optionId === 'clarify_choice_0' && followupReference && sourceUserTurn) {
        emitter.emit('commandEve.composer.followup.confirmed', {
          conversation_id: message.conversation_id,
          artifact_id: followupReference.artifactId,
          source_user_turn: sourceUserTurn,
        });
      }
    } catch (error) {
      console.error('Error answering clarify prompt:', error);
      setResponseError(
        t('messages.clarify.responseFailed', {
          defaultValue: 'Die Auswahl konnte nicht übernommen werden. Es wurde nichts ausgeführt.',
        })
      );
    } finally {
      respondingRef.current = false;
      setResponding(false);
    }
  };

  return (
    <Card className={styles.card} bordered={false} data-testid='message-acp-clarify-card'>
      <div className='flex flex-col gap-14px'>
        <div className={styles.header}>
          <span className={styles.headerIcon}>
            <Comment theme='outline' size={17} fill='currentColor' aria-hidden='true' />
          </span>
          <div className={styles.question}>{question}</div>
        </div>

        {followupReference && (
          <div className={styles.artifact} data-testid='message-acp-clarify-artifact'>
            <span className={styles.artifactIcon}>{referenceIcon(followupReference.mode)}</span>
            <span className={styles.artifactTitle}>{followupReference.title}</span>
            <span className={styles.artifactKind}>
              {t(`conversation.workProduct.kind.${followupReference.referenceKind}` as const)}
            </span>
            {videoEditEstimate && (
              <span className={styles.artifactKind} data-testid='message-acp-clarify-video-cost'>
                {t('credits.video.costPreview', {
                  defaultValue: 'Dieses ~{{sec}}s-Video kostet ca. {{credits}} Credits — fortfahren?',
                  credits: videoEditEstimate.credits,
                  sec: videoEditEstimate.seconds,
                })}
              </span>
            )}
          </div>
        )}

        {followupMode && followupTarget && !followupReference && (
          <div className={styles.error} data-testid='message-acp-clarify-reference-unavailable'>
            {referenceUnavailable}
          </div>
        )}

        {sourceUserTurn && sourceUserTurn !== question && <p className={styles.sourceTurn}>„{sourceUserTurn}“</p>}

        {!respondedLabel && (
          <div className={styles.choices} role='group' aria-label={question}>
            {options.map((rawOption, index) => {
              const option = recordOf(rawOption);
              if (!option || typeof option.name !== 'string' || typeof option.option_id !== 'string') return null;
              return (
                <Button
                  key={option.option_id}
                  type='secondary'
                  className={`${styles.choice} ${index === 0 ? styles.choicePrimary : ''}`}
                  loading={responding}
                  disabled={responding || inactive || (index === 0 && Boolean(followupMode) && !followupReference)}
                  onClick={() => void answer(option)}
                  data-testid={`message-acp-clarify-option-${index}`}
                >
                  {option.name}
                </Button>
              );
            })}
          </div>
        )}

        {respondedLabel && (
          <div className={styles.resolved} data-testid='message-acp-clarify-resolved'>
            {t('messages.clarify.selected', { choice: respondedLabel, defaultValue: 'Ausgewählt: {{choice}}' })}
          </div>
        )}
        {responseError && <div className={styles.error}>{responseError}</div>}
      </div>
    </Card>
  );
});

export default MessageAcpClarify;

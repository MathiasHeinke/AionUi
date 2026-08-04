/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import type { IConversationMcpStatus } from '@/common/config/storage';
import { isCommandEveAcpConversation } from '@/common/config/commandEveShell';
import { ConversationProvider } from '@/renderer/hooks/context/ConversationContext';
import { useTeamPermission } from '@/renderer/pages/team/hooks/TeamPermissionContext';
import FlexFullContainer from '@renderer/components/layout/FlexFullContainer';
import MessageList from '@renderer/pages/conversation/Messages/MessageList';
import { ConversationArtifactProvider } from '@renderer/pages/conversation/Messages/artifacts';
import {
  MessageListLoadingProvider,
  MessageListProvider,
  useMessageList,
  useMessageLstCache,
} from '@renderer/pages/conversation/Messages/hooks';
import { usePendingConfirmationsRecovery } from '@renderer/pages/conversation/Messages/usePendingConfirmationsRecovery';
import { useConversationRuntimeSnapshot } from '@renderer/pages/conversation/runtime/useConversationRuntimeView';
import { useConversationDocumentPreparation } from '@renderer/pages/conversation/runtime/conversationDocumentPreparationStore';
import HOC from '@renderer/utils/ui/HOC';
import QuotaExhaustedWall from '@renderer/components/billing/QuotaExhaustedWall';
import DailyCapWall from '@renderer/components/billing/DailyCapWall';
import React from 'react';
import { useTranslation } from 'react-i18next';
import AcpE2EStreamInjector from './AcpE2EStreamInjector';
import AcpRuntimeStatus from './AcpRuntimeStatus';
import { useEgressBoundaryStatus } from './EgressBoundaryNotice';
import { shouldShowPendingAssistantActivity } from './pendingAssistantActivity';
import AcpSendBox from './AcpSendBox';
import { useAcpMessage } from './useAcpMessage';

const AcpPendingAssistantActivity: React.FC<{
  conversation_id: string;
  isProcessing: boolean;
  localSubmitting: boolean;
}> = ({ conversation_id, isProcessing, localSubmitting }) => {
  const { t } = useTranslation();
  const messages = useMessageList();
  const latestConversationMessage = messages.findLast((message) => message.conversation_id === conversation_id);

  if (!shouldShowPendingAssistantActivity(isProcessing, localSubmitting, latestConversationMessage?.position)) {
    return null;
  }

  return (
    <div
      className='message-item px-8px m-t-14px max-w-full md:max-w-780px mx-auto flex items-center gap-10px text-t-secondary'
      data-testid='acp-pending-assistant-activity'
      role='status'
      aria-live='polite'
    >
      <span className='h-8px w-8px rd-full bg-warning-6 animate-pulse shrink-0' />
      <span className='font-500'>
        {t('conversation.runtimeStatus.preparing', {
          defaultValue: 'EVE is preparing the task',
        })}
      </span>
    </div>
  );
};

const AcpChat: React.FC<{
  conversation_id: string;
  workspace?: string;
  backend: string;
  session_mode?: string;
  agent_name?: string;
  cron_job_id?: string;
  hideSendBox?: boolean;
  emptySlot?: React.ReactNode;
  /**
   * Rendered ABOVE the message list, inside the MessageListProvider — the seam
   * for surfaces that must stay visible once the emptySlot is gone (v1.6
   * onboarding waiting banner). The slot component decides its own visibility.
   */
  headerSlot?: React.ReactNode;
  loadedSkills?: string[];
  loadedMcpServers?: string[];
  loadedMcpStatuses?: IConversationMcpStatus[];
  waitForWarmup?: boolean;
}> = ({
  conversation_id,
  workspace,
  backend,
  session_mode,
  agent_name,
  cron_job_id,
  hideSendBox,
  emptySlot,
  headerSlot,
  loadedSkills,
  loadedMcpServers,
  loadedMcpStatuses,
  waitForWarmup,
}) => {
  const historyPagination = useMessageLstCache(conversation_id);
  usePendingConfirmationsRecovery(conversation_id);
  const teamPermission = useTeamPermission();
  const messageState = useAcpMessage(conversation_id, {
    skipWarmup: Boolean(teamPermission) || waitForWarmup === false,
    // 1.820.4 (MAT-1772) — the post-turn auto-project hint activates ONLY for
    // the Command-EVE (Hermes) ACP backend. Every other backend keeps its
    // exact previous finish behavior; eligibility itself is re-proven main-side.
    autoProject: isCommandEveAcpConversation(backend),
  });
  // Read the shared runtime store without installing another copy of the IPC
  // hydration/listener effects already owned by the sendbox runtime hook.
  const runtimeView = useConversationRuntimeSnapshot(conversation_id);
  const isPreparingDocument = useConversationDocumentPreparation(conversation_id);
  const egressBoundary = useEgressBoundaryStatus(messageState.running || messageState.aiProcessing);

  return (
    <ConversationProvider
      value={{
        conversation_id: conversation_id,
        workspace,
        type: 'acp',
        cron_job_id,
        hideSendBox,
        loadedSkills,
        loadedMcpServers,
        loadedMcpStatuses,
      }}
    >
      <ConversationArtifactProvider conversation_id={conversation_id}>
        <div className='acp-chat flex-1 flex flex-col px-20px min-h-0'>
          {headerSlot}
          <FlexFullContainer>
            <MessageList
              className='flex-1'
              emptySlot={emptySlot}
              commandEvePermissionPolicy={isCommandEveAcpConversation(backend)}
              suppressEmptySlot={
                !messageState.hasHydratedRunningState ||
                messageState.running ||
                messageState.aiProcessing ||
                runtimeView.isProcessing ||
                isPreparingDocument
              }
              historyPagination={historyPagination}
              tailSlot={
                runtimeView.isProcessing ? (
                  <AcpPendingAssistantActivity
                    conversation_id={conversation_id}
                    isProcessing={runtimeView.isProcessing}
                    localSubmitting={runtimeView.localSubmitting}
                  />
                ) : null
              }
            />
          </FlexFullContainer>
          <AcpE2EStreamInjector conversationId={conversation_id} />
          {/* Lane-3 402 quota-exhausted wall — fed by the LIVE stream-error path
              in useAcpMessage. The wall idle-suppresses itself: it renders only
              when a turn was in-flight AND a 402 quota_exhausted body arrived. */}
          <QuotaExhaustedWall
            body={messageState.quotaWall.body}
            jobInFlight={messageState.quotaWall.jobInFlight}
            autoReloadDefault={messageState.quotaWall.autoReload}
            onAutoReloadChange={messageState.quotaWall.setAutoReload}
            onClose={messageState.quotaWall.closeWall}
          />
          {/* The fair-use DAILY-cap wall (429 → 'eve_daily_cap'). Same
              idle-suppression, and it never sells — not out of politeness, but
              because buying credits does not lift a fair-use cap. It is an abuse
              ceiling, NOT a free allowance: every turn it lets through is metered. */}
          <DailyCapWall
            reached={messageState.quotaWall.dailyCapReached}
            jobInFlight={messageState.quotaWall.jobInFlight}
            onClose={messageState.quotaWall.closeWall}
          />
          {!hideSendBox && (
            <AcpSendBox
              conversation_id={conversation_id}
              backend={backend}
              session_mode={session_mode}
              agent_name={agent_name}
              workspacePath={workspace}
              messageState={messageState}
            ></AcpSendBox>
          )}
          {/* Runtime status is supporting chrome, not a second composer. It sits
              below the input as the chat-column footer and aligns with the
              account footer in the left sidebar. Operators see only the safe
              active phase; dev mode adds diagnostics and log access. */}
          <AcpRuntimeStatus
            activity={messageState.runtimeActivity}
            running={messageState.running || runtimeView.isProcessing || isPreparingDocument}
            aiProcessing={messageState.aiProcessing}
            backend={backend}
            egressBoundary={egressBoundary}
          />
        </div>
      </ConversationArtifactProvider>
    </ConversationProvider>
  );
};

export default HOC.Wrapper(MessageListProvider, MessageListLoadingProvider)(AcpChat);

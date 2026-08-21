/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import type { IMessageAcpPermission } from '@/common/chat/chatLib';
import { conversation } from '@/common/adapter/ipcBridge';
import {
  isExplicitPermissionFailure,
  isPermissionCardInactive,
  isPermissionClassificationUnverified,
  normalizePermissionOptions,
} from './permissionCardPolicy';
import { Button, Card, Radio, Typography } from '@arco-design/web-react';
import { Book, CheckOne, Edit, Lightning, Link, Lock } from '@renderer/components/icons';
import React, { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import MessageAcpClarify from './MessageAcpClarify';

const { Text } = Typography;

interface MessageAcpPermissionProps {
  message: IMessageAcpPermission;
  isCommandEve?: boolean;
}

const COMMAND_EVE_CLARIFY_CALL_ID = /^clarify-[0-9a-f]{32}$/;
const AIONCORE_UNKNOWN_CLASSIFICATION_TITLE_PREFIX = '[classification=unknown] ';

function isCommandEveClarifyMessage(message: IMessageAcpPermission, isCommandEve: boolean): boolean {
  if (!isCommandEve) return false;
  const content = message.content;
  const toolCall = content?.tool_call;
  const rawInput =
    toolCall?.raw_input && typeof toolCall.raw_input === 'object' && !Array.isArray(toolCall.raw_input)
      ? (toolCall.raw_input as Record<string, unknown>)
      : null;
  const metadata =
    rawInput?.metadata && typeof rawInput.metadata === 'object' && !Array.isArray(rawInput.metadata)
      ? (rawInput.metadata as Record<string, unknown>)
      : null;
  if (!toolCall || !rawInput || !metadata) return false;
  if (!COMMAND_EVE_CLARIFY_CALL_ID.test(String(toolCall.tool_call_id ?? '')) || toolCall.kind !== 'execute')
    return false;

  const question = metadata.question;
  const choices = metadata.choices;
  const sourceUserTurn = metadata.source_user_turn;
  if (
    metadata.interaction_kind !== 'clarify' ||
    typeof question !== 'string' ||
    !question ||
    question.length > 4000 ||
    (toolCall.title !== question && toolCall.title !== `${AIONCORE_UNKNOWN_CLASSIFICATION_TITLE_PREFIX}${question}`)
  ) {
    return false;
  }
  if (rawInput.question !== question || !Array.isArray(choices) || choices.length < 1 || choices.length > 4)
    return false;
  if (!choices.every((choice) => typeof choice === 'string' && choice.length > 0 && choice.length <= 512)) return false;
  if (!Array.isArray(rawInput.choices) || rawInput.choices.length !== choices.length) return false;
  if (!rawInput.choices.every((choice, index) => choice === choices[index])) return false;
  if (typeof sourceUserTurn !== 'string' || sourceUserTurn.length > 8000) return false;
  if (Object.keys(metadata).toSorted().join('|') !== 'choices|interaction_kind|question|source_user_turn') return false;
  if (Object.keys(rawInput).toSorted().join('|') !== 'choices|metadata|question') return false;

  const options = Array.isArray(content.options) ? content.options : [];
  if (options.length !== choices.length + 1) return false;
  for (let index = 0; index < choices.length; index += 1) {
    const option = options[index];
    if (
      option?.option_id !== `clarify_choice_${index}` ||
      option?.kind !== 'allow_once' ||
      option?.name !== choices[index]
    ) {
      return false;
    }
  }
  const cancel = options.at(-1);
  return cancel?.option_id === 'clarify_cancel' && cancel.kind === 'reject_once' && cancel.name === 'Cancel';
}

const MessageAcpSecurityPermission: React.FC<MessageAcpPermissionProps> = React.memo(
  ({ message, isCommandEve = false }) => {
    const { options = [], tool_call } = message.content || {};
    const { t } = useTranslation();
    const requestRecord = (message.content || {}) as unknown as Record<string, unknown>;
    const rawInput =
      tool_call?.raw_input && typeof tool_call.raw_input === 'object'
        ? (tool_call.raw_input as Record<string, unknown>)
        : undefined;
    const metadata =
      rawInput?.metadata && typeof rawInput.metadata === 'object'
        ? (rawInput.metadata as Record<string, unknown>)
        : undefined;
    const actionStatus = isPermissionCardInactive(requestRecord.action) ? requestRecord.action : undefined;
    const cardStatus = requestRecord.status ?? requestRecord.lifecycle_status ?? tool_call?.status ?? actionStatus;
    const inactive = isCommandEve && isPermissionCardInactive(cardStatus);
    const classification =
      requestRecord.classification ??
      requestRecord.permission_classification ??
      rawInput?.classification ??
      metadata?.classification;
    const unverified = isCommandEve && isPermissionClassificationUnverified(classification);
    const normalizedOptions = useMemo(
      () =>
        normalizePermissionOptions(
          options.map((option, index) => ({
            id: option?.option_id || `option_${index}`,
            kind: option?.kind,
            label: option?.name || `${t('messages.option')} ${index + 1}`,
          })),
          isCommandEve
        ),
      [isCommandEve, options, t]
    );

    // 基于实际数据生成显示信息
    const getToolInfo = () => {
      if (!tool_call) {
        return {
          title: t('messages.permissionRequest'),
          description: t('messages.agentRequestingPermission'),
          icon: <Lock size={17} aria-hidden='true' />,
        };
      }

      const displayTitle = tool_call.title || tool_call.raw_input?.description || t('messages.permissionRequest');

      // 简单的图标映射
      const kindIcons: Record<string, React.ReactNode> = {
        edit: <Edit size={17} aria-hidden='true' />,
        read: <Book size={17} aria-hidden='true' />,
        fetch: <Link size={17} aria-hidden='true' />,
        execute: <Lightning size={17} aria-hidden='true' />,
      };

      return {
        title: displayTitle,
        icon: kindIcons[tool_call.kind || 'execute'] || <Lightning size={17} aria-hidden='true' />,
      };
    };
    const { title, icon } = getToolInfo();
    const [selected, setSelected] = useState<string | null>(null);
    const [isResponding, setIsResponding] = useState(false);
    const [hasResponded, setHasResponded] = useState(false);
    const [responseError, setResponseError] = useState<string | null>(null);

    const handleConfirm = async () => {
      // `isResponding` too, not just `hasResponded`: the latter is only set after
      // the round trip, so two clicks before the re-render sent two confirms. The
      // second one cannot widen anything (AionCore is idempotent for the same
      // decision), but a different second pick surfaced a conflict error to a user
      // who had done nothing wrong (P3, Kimi).
      if (hasResponded || isResponding || !selected || inactive) return;
      if (!normalizedOptions.some((option) => option.id === selected)) return;

      setIsResponding(true);
      setResponseError(null);
      try {
        const invokeData = {
          confirm_key: selected,
          msg_id: message.id,
          conversation_id: message.conversation_id,
          call_id: tool_call?.tool_call_id || message.id,
        };

        const result = (await conversation.confirmMessage.invoke(invokeData)) as unknown;
        if (isExplicitPermissionFailure(result)) throw new Error('Permission authority rejected the response.');
        setHasResponded(true);
      } catch (error) {
        console.error('Error confirming permission:', error);
        setResponseError(t('messages.permissionResponseFailed'));
      } finally {
        setIsResponding(false);
      }
    };

    const normalizedStatus = String(cardStatus ?? '')
      .trim()
      .toLowerCase();
    const statusLabel = inactive
      ? t(`messages.permissionStatus.${normalizedStatus || 'expired'}`, {
          defaultValue: normalizedStatus || t('messages.permissionStatus.expired'),
        })
      : null;

    return (
      <Card
        className='mb-4'
        bordered={false}
        style={{ background: 'var(--bg-1)', opacity: inactive ? 0.78 : 1 }}
        data-testid='message-acp-permission-card'
        data-permission-status={normalizedStatus || 'pending'}
        data-permission-inactive={inactive ? 'true' : 'false'}
      >
        <div className='space-y-4'>
          {/* Header with icon and title */}
          <div className='flex items-center space-x-2'>
            <span className='text-2xl' aria-hidden>
              {icon}
            </span>
            <Text className='block'>{title}</Text>
          </div>
          {unverified && (
            <div
              className='p-2 rounded-md border'
              data-testid='message-acp-permission-unverified'
              style={{ backgroundColor: 'var(--color-warning-light-1)', borderColor: 'rgb(var(--warning-3))' }}
            >
              <Text className='block text-sm font-500' style={{ color: 'rgb(var(--warning-6))' }}>
                {t('messages.permissionUnverifiedTitle')}
              </Text>
              <Text className='block text-xs text-t-secondary'>{t('messages.permissionUnverifiedDescription')}</Text>
            </div>
          )}
          {statusLabel && (
            <div
              className='p-2 rounded-md border'
              data-testid='message-acp-permission-inactive-banner'
              style={{ backgroundColor: 'var(--color-warning-light-1)', borderColor: 'rgb(var(--warning-3))' }}
            >
              <Text className='text-sm' style={{ color: 'rgb(var(--warning-6))' }}>
                {statusLabel}
              </Text>
            </div>
          )}
          {(tool_call?.raw_input?.command || tool_call?.title) && (
            <div>
              <Text className='text-xs text-t-secondary mb-1'>{t('messages.command')}</Text>
              <code className='text-xs bg-1 p-2 rounded block text-t-primary break-all'>
                {tool_call?.raw_input?.command || tool_call?.title}
              </code>
            </div>
          )}
          {!hasResponded && (
            <>
              <div className='mt-10px'>{t('messages.chooseAction')}</div>
              <Radio.Group
                direction='vertical'
                size='mini'
                value={selected}
                onChange={setSelected}
                disabled={inactive || isResponding}
              >
                {normalizedOptions.length > 0 ? (
                  normalizedOptions.map((option) => (
                    <div key={option.id} data-testid={`message-acp-permission-option-${option.id}`}>
                      <Radio value={option.id} disabled={inactive}>
                        {option.exactSessionIntent ? t('messages.permissionExactSession') : option.label}
                      </Radio>
                    </div>
                  ))
                ) : (
                  <Text type='secondary'>{t('messages.noOptionsAvailable')}</Text>
                )}
              </Radio.Group>
              <div className='flex justify-start pl-20px'>
                <Button
                  type='primary'
                  size='mini'
                  disabled={!selected || isResponding || inactive}
                  onClick={handleConfirm}
                  data-testid='message-acp-permission-confirm'
                >
                  {isResponding ? t('messages.processing') : t('messages.confirm')}
                </Button>
              </div>
            </>
          )}

          {responseError && (
            <div
              className='mt-10px p-2 rounded-md border'
              data-testid='message-acp-permission-error'
              style={{ backgroundColor: 'var(--color-danger-light-1)', borderColor: 'rgb(var(--danger-3))' }}
            >
              <Text className='text-sm' style={{ color: 'rgb(var(--danger-6))' }}>
                {responseError}
              </Text>
            </div>
          )}

          {hasResponded && (
            <div
              className='mt-10px p-2 rounded-md border'
              style={{ backgroundColor: 'var(--color-success-light-1)', borderColor: 'rgb(var(--success-3))' }}
            >
              <Text className='text-sm' style={{ color: 'rgb(var(--success-6))' }}>
                <span className='inline-flex items-center gap-6px'>
                  <CheckOne size={15} aria-hidden='true' />
                  {t('messages.responseSentSuccessfully')}
                </span>
              </Text>
            </div>
          )}
        </div>
      </Card>
    );
  }
);

const MessageAcpPermission: React.FC<MessageAcpPermissionProps> = React.memo((props) => {
  if (isCommandEveClarifyMessage(props.message, props.isCommandEve === true)) {
    return <MessageAcpClarify message={props.message} />;
  }
  return <MessageAcpSecurityPermission {...props} />;
});

export default MessageAcpPermission;

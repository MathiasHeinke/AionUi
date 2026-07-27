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
import { IconBook, IconEdit, IconLink, IconLock, IconThunderbolt } from '@arco-design/web-react/icon';
import React, { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';

const { Text } = Typography;

interface MessageAcpPermissionProps {
  message: IMessageAcpPermission;
  isCommandEve?: boolean;
}

const MessageAcpPermission: React.FC<MessageAcpPermissionProps> = React.memo(({ message, isCommandEve = false }) => {
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
        icon: <IconLock aria-hidden />,
      };
    }

    const displayTitle = tool_call.title || tool_call.raw_input?.description || t('messages.permissionRequest');

    // 简单的图标映射
    const kindIcons: Record<string, React.ReactNode> = {
      edit: <IconEdit aria-hidden />,
      read: <IconBook aria-hidden />,
      fetch: <IconLink aria-hidden />,
      execute: <IconThunderbolt aria-hidden />,
    };

    return {
      title: displayTitle,
      icon: kindIcons[tool_call.kind || 'execute'] || <IconThunderbolt aria-hidden />,
    };
  };
  const { title, icon } = getToolInfo();
  const [selected, setSelected] = useState<string | null>(null);
  const [isResponding, setIsResponding] = useState(false);
  const [hasResponded, setHasResponded] = useState(false);
  const [responseError, setResponseError] = useState<string | null>(null);

  const handleConfirm = async () => {
    if (hasResponded || !selected || inactive) return;
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
              ✓ {t('messages.responseSentSuccessfully')}
            </Text>
          </div>
        )}
      </div>
    </Card>
  );
});

export default MessageAcpPermission;

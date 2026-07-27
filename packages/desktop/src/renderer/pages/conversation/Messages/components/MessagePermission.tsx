/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import type { IMessagePermission } from '@/common/chat/chatLib';
import { ipcBridge } from '@/common';
import {
  isExplicitPermissionFailure,
  isPermissionCardInactive,
  isPermissionClassificationUnverified,
  normalizePermissionOptions,
} from '@/renderer/pages/conversation/Messages/acp/permissionCardPolicy';
import { Button, Card, Radio, Typography } from '@arco-design/web-react';
import React, { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';

const { Text } = Typography;

interface MessagePermissionProps {
  message: IMessagePermission;
  isCommandEve?: boolean;
}

const actionIcons: Record<string, string> = {
  exec: '⚡',
  edit: '✏️',
  info: '📖',
  mcp: '🔌',
};

const MessagePermission: React.FC<MessagePermissionProps> = React.memo(({ message, isCommandEve = false }) => {
  const { t } = useTranslation();
  const { options = [], description, title, action, call_id, command_type } = message.content || {};
  const contentRecord = (message.content || {}) as unknown as Record<string, unknown>;
  const metadata =
    contentRecord.metadata && typeof contentRecord.metadata === 'object'
      ? (contentRecord.metadata as Record<string, unknown>)
      : undefined;
  const actionStatus = isPermissionCardInactive(action) ? action : undefined;
  const cardStatus = contentRecord.status ?? contentRecord.lifecycle_status ?? actionStatus;
  const inactive = isCommandEve && isPermissionCardInactive(cardStatus);
  const classification =
    contentRecord.classification ?? contentRecord.permission_classification ?? metadata?.classification;
  const unverified = isCommandEve && isPermissionClassificationUnverified(classification);
  const normalizedOptions = useMemo(
    () =>
      normalizePermissionOptions(
        options.map((option) => ({
          id: String(option.value),
          kind: String((option as unknown as Record<string, unknown>).kind ?? option.value),
          label: option.label,
          params: option.params,
        })),
        isCommandEve
      ),
    [isCommandEve, options]
  );

  const [selected, setSelected] = useState<string | null>(null);
  const [isResponding, setIsResponding] = useState(false);
  const [hasResponded, setHasResponded] = useState(false);
  const [responseError, setResponseError] = useState<string | null>(null);

  const icon = actionIcons[action || ''] || '🔐';
  const displayTitle = title || description || t('messages.permissionRequest');

  const handleConfirm = async () => {
    if (hasResponded || !selected || inactive) return;
    if (!normalizedOptions.some((option) => option.id === selected)) return;

    setIsResponding(true);
    setResponseError(null);
    try {
      const always_allow = !isCommandEve && selected === 'proceed_always';
      const result = (await ipcBridge.conversation.confirmation.confirm.invoke({
        conversation_id: message.conversation_id,
        call_id,
        msg_id: message.msg_id || '',
        data: { value: selected },
        always_allow,
      })) as unknown;
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
      data-testid='message-permission-card'
      data-permission-status={normalizedStatus || 'pending'}
      data-permission-inactive={inactive ? 'true' : 'false'}
    >
      <div className='space-y-4'>
        <div className='flex items-center space-x-2'>
          <span className='text-2xl'>{icon}</span>
          <Text className='block'>{displayTitle}</Text>
        </div>
        {unverified && (
          <div
            className='p-2 rounded-md border'
            data-testid='message-permission-unverified'
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
            data-testid='message-permission-inactive-banner'
            style={{ backgroundColor: 'var(--color-warning-light-1)', borderColor: 'rgb(var(--warning-3))' }}
          >
            <Text className='text-sm' style={{ color: 'rgb(var(--warning-6))' }}>
              {statusLabel}
            </Text>
          </div>
        )}
        {command_type && (
          <div>
            <Text className='text-xs text-t-secondary mb-1'>{t('messages.command')}</Text>
            <code className='text-xs bg-1 p-2 rounded block text-t-primary break-all'>{command_type}</code>
          </div>
        )}
        {description && description !== displayTitle && (
          <div>
            <Text className='text-xs text-t-secondary'>{description}</Text>
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
                  <div key={option.id} data-testid={`message-permission-option-${option.id}`}>
                    <Radio value={option.id} disabled={inactive}>
                      {option.exactSessionIntent
                        ? t('messages.permissionExactSession')
                        : t(option.label, { ...option.params, defaultValue: option.label })}
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
                data-testid='message-permission-confirm'
              >
                {isResponding ? t('messages.processing') : t('messages.confirm')}
              </Button>
            </div>
          </>
        )}
        {responseError && (
          <div
            className='mt-10px p-2 rounded-md border'
            data-testid='message-permission-error'
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

export default MessagePermission;

/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import { conversation } from '@/common/adapter/ipcBridge';
import type { IMessageAcpPermission } from '@/common/chat/chatLib';
import { Button, Card } from '@arco-design/web-react';
import { Comment } from '@renderer/components/icons';
import React, { useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { isExplicitPermissionFailure, isPermissionCardInactive } from './permissionCardPolicy';
import styles from './MessageAcpClarify.module.css';

function recordOf(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

const MessageAcpClarify: React.FC<{ message: IMessageAcpPermission }> = React.memo(({ message }) => {
  const { t } = useTranslation();
  const content = recordOf(message.content) ?? {};
  const toolCall = recordOf(content.tool_call) ?? {};
  const rawInput = recordOf(toolCall.raw_input) ?? {};
  const metadata = recordOf(rawInput.metadata) ?? {};
  const question = typeof metadata.question === 'string' ? metadata.question : String(toolCall.title ?? '');
  const options = Array.isArray(content.options) ? content.options : [];
  const cardStatus = content.status ?? content.lifecycle_status ?? toolCall.status;
  const inactive = isPermissionCardInactive(cardStatus);
  const [responding, setResponding] = useState(false);
  const [respondedLabel, setRespondedLabel] = useState<string | null>(null);
  const [responseError, setResponseError] = useState<string | null>(null);
  const respondingRef = useRef(false);
  const respondedRef = useRef(false);

  const answer = async (option: Record<string, unknown>, displayLabel: string): Promise<boolean> => {
    if (respondingRef.current || respondedRef.current || inactive) return false;
    const optionId = typeof option.option_id === 'string' ? option.option_id : '';
    const optionLabel = typeof option.name === 'string' ? option.name : '';
    if (!optionId || !optionLabel) return false;

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
      setRespondedLabel(displayLabel);
      return true;
    } catch (error) {
      console.error('Error answering clarify prompt:', error);
      setResponseError(
        t('messages.clarify.responseFailed', {
          defaultValue: 'Die Auswahl konnte nicht übernommen werden. Es wurde nichts ausgeführt.',
        })
      );
      return false;
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
            <Comment size={17} aria-hidden='true' />
          </span>
          <div className={styles.question}>{question}</div>
        </div>

        {!respondedLabel && (
          <div className={styles.choices} role='group' aria-label={question}>
            {options.map((rawOption) => {
              const option = recordOf(rawOption);
              if (!option || typeof option.name !== 'string' || typeof option.option_id !== 'string') return null;
              const optionLabel =
                option.option_id === 'clarify_cancel'
                  ? t('messages.clarify.cancel', { defaultValue: 'Abbrechen' })
                  : option.name;
              return (
                <Button
                  key={option.option_id}
                  className={`${styles.choice} ${option.option_id === 'clarify_cancel' ? '' : styles.choicePrimary}`}
                  type={option.option_id === 'clarify_cancel' ? 'secondary' : 'primary'}
                  size='small'
                  loading={responding}
                  disabled={inactive || responding}
                  onClick={() => void answer(option, optionLabel)}
                >
                  {optionLabel}
                </Button>
              );
            })}
          </div>
        )}

        {respondedLabel && (
          <div className={styles.resolved} data-testid='message-acp-clarify-responded'>
            {t('messages.clarify.selected', { defaultValue: 'Ausgewählt: {{choice}}', choice: respondedLabel })}
          </div>
        )}

        {responseError && (
          <div className={styles.error} data-testid='message-acp-clarify-error'>
            {responseError}
          </div>
        )}
      </div>
    </Card>
  );
});

MessageAcpClarify.displayName = 'MessageAcpClarify';

export default MessageAcpClarify;

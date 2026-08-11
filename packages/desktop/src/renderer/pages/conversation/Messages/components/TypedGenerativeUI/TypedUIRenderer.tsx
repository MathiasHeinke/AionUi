/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  parseTypedUIEnvelope,
  type TypedUIActionReceipt,
  type TypedUIEnvelope,
  type TypedUIValidationIssue,
} from '@/common/typedUI';
import type { ActionBinding, Spec, UIElement } from '@json-render/core';
import { createStateStore } from '@json-render/core';
import { Alert, Button, Spin, Tag } from '@arco-design/web-react';
import { JSONUIProvider, Renderer } from '@json-render/react';
import React, { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  createTypedUIActionHandlers,
  TYPED_UI_INTERNAL_ACTION_ID,
  type TypedUIActionHost,
  type TypedUIReceiptContext,
} from './actions';
import { typedUIRegistry } from './registry';
import styles from './TypedGenerativeUI.module.css';

export interface TypedUIRendererProps {
  content: string | unknown;
  mode: 'compact' | 'full';
  host: TypedUIActionHost;
  receiptContext: TypedUIReceiptContext;
  streaming?: boolean;
  onOpenWorkbench?: () => Promise<void> | void;
}

function toRuntimeSpec(envelope: TypedUIEnvelope, host: TypedUIActionHost): Spec {
  const elements: Record<string, UIElement> = {};
  for (const [elementId, element] of Object.entries(envelope.elements)) {
    const bindings: Record<string, ActionBinding> = {};
    for (const [event, actionId] of Object.entries(element.on || {})) {
      const action = envelope.actions[actionId];
      if (!action) continue;
      if (host.supportsAction?.(action.type) === false) continue;
      bindings[event] = {
        action: action.type,
        params: {
          ...action.params,
          [TYPED_UI_INTERNAL_ACTION_ID]: actionId,
        },
      };
    }
    elements[elementId] = {
      type: element.type,
      props: element.props,
      children: element.children,
      ...(Object.keys(bindings).length > 0 ? { on: bindings } : {}),
    };
  }
  return { root: envelope.root, elements, state: envelope.state };
}

function InvalidTypedUI({ issues }: { issues: TypedUIValidationIssue[] }) {
  const { t } = useTranslation();
  return (
    <Alert
      type='warning'
      title={t('messages.typedUI.invalidTitle')}
      content={t('messages.typedUI.invalidDescription', { code: issues[0]?.code || 'invalid' })}
      data-testid='typed-ui-invalid'
    />
  );
}

function ValidatedTypedUI({
  envelope,
  mode,
  host,
  receiptContext,
  onOpenWorkbench,
}: {
  envelope: TypedUIEnvelope;
  mode: 'compact' | 'full';
  host: TypedUIActionHost;
  receiptContext: TypedUIReceiptContext;
  onOpenWorkbench?: () => Promise<void> | void;
}) {
  const { t } = useTranslation();
  const [lastReceipt, setLastReceipt] = useState<TypedUIActionReceipt>();
  const [actionError, setActionError] = useState<string>();
  const store = useMemo(() => createStateStore(envelope.state), [envelope]);
  const spec = useMemo(() => toRuntimeSpec(envelope, host), [envelope, host]);
  const handlers = useMemo(
    () => createTypedUIActionHandlers({ envelope, receiptContext, store, host, onReceipt: setLastReceipt }),
    [envelope, host, receiptContext, store]
  );

  const openWorkbench = async () => {
    if (!onOpenWorkbench) return;
    setActionError(undefined);
    try {
      const authority = await host.evaluateAuthority('truth_gate');
      const baseReceipt = {
        version: 'command-eve.typed-ui-action-receipt/v1',
        request_id: receiptContext.requestId,
        ...(receiptContext.sourceMessageId ? { source_message_id: receiptContext.sourceMessageId } : {}),
        action_id: 'host-open-workbench',
        action_type: 'open_artifact',
        decided_at: new Date().toISOString(),
        authority,
      } as const;
      if (!authority.allowed) {
        const blocked: TypedUIActionReceipt = { ...baseReceipt, status: 'blocked', reason: authority.reason };
        const persisted = await host.recordReceipt(blocked);
        setLastReceipt({ ...blocked, receipt_id: persisted.receipt_id });
        return;
      }
      const intent: TypedUIActionReceipt = { ...baseReceipt, status: 'authorized' };
      const persistedIntent = await host.recordReceipt(intent);
      try {
        await onOpenWorkbench();
        const completed: TypedUIActionReceipt = {
          ...baseReceipt,
          status: 'completed',
          intent_receipt_id: persistedIntent.receipt_id,
        };
        const persisted = await host.recordReceipt(completed);
        setLastReceipt({ ...completed, receipt_id: persisted.receipt_id });
      } catch {
        const failed: TypedUIActionReceipt = {
          ...baseReceipt,
          status: 'failed',
          intent_receipt_id: persistedIntent.receipt_id,
          reason: 'Workbench navigation or receipt persistence failed.',
        };
        try {
          const persisted = await host.recordReceipt(failed);
          setLastReceipt({ ...failed, receipt_id: persisted.receipt_id });
        } catch {
          setLastReceipt(failed);
        }
        setActionError(t('messages.typedUI.actionUnavailable'));
      }
    } catch {
      setActionError(t('messages.typedUI.actionUnavailable'));
    }
  };

  return (
    <section
      className={styles.root}
      data-mode={mode}
      data-testid={`typed-ui-${mode}`}
      aria-label={t('messages.typedUI.regionLabel')}
    >
      <header className={styles.chrome}>
        <div>
          <strong>{t('messages.typedUI.title')}</strong>
          <span>{envelope.provenance.model}</span>
        </div>
        <Tag>{envelope.catalog_version.replace('command-eve.typed-ui.catalog/', '')}</Tag>
      </header>
      <div className={styles.canvas}>
        <JSONUIProvider registry={typedUIRegistry} store={store} handlers={handlers}>
          <Renderer spec={spec} registry={typedUIRegistry} />
        </JSONUIProvider>
      </div>
      {mode === 'compact' && onOpenWorkbench ? (
        <footer className={styles.footer}>
          <Button type='text' onClick={() => void openWorkbench()}>
            {t('messages.typedUI.openWorkbench')}
          </Button>
        </footer>
      ) : null}
      {actionError ? <Alert type='warning' content={actionError} className={styles.actionError} /> : null}
      <div className={styles.srOnly} role='status' aria-live='polite' data-testid='typed-ui-action-status'>
        {lastReceipt
          ? t(
              lastReceipt.status === 'blocked' || lastReceipt.status === 'failed'
                ? 'messages.typedUI.actionBlocked'
                : 'messages.typedUI.actionCompleted',
              {
                action: lastReceipt.action_type,
                gate: lastReceipt.authority.gate,
              }
            )
          : ''}
      </div>
    </section>
  );
}

export function TypedUIRenderer({
  content,
  mode,
  host,
  receiptContext,
  streaming = false,
  onOpenWorkbench,
}: TypedUIRendererProps) {
  const { t } = useTranslation();
  const result = useMemo(() => parseTypedUIEnvelope(content), [content]);
  if (streaming) {
    return (
      <div className={styles.loading} role='status' data-testid='typed-ui-streaming'>
        <Spin dot />
        <span>{t('messages.typedUI.streaming')}</span>
      </div>
    );
  }
  if ('issues' in result) {
    return <InvalidTypedUI issues={result.issues} />;
  }
  return (
    <ValidatedTypedUI
      envelope={result.value}
      mode={mode}
      host={host}
      receiptContext={receiptContext}
      onOpenWorkbench={onOpenWorkbench}
    />
  );
}

/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  parseTypedUIEnvelope,
  TYPED_UI_ACTION_AUTHORIZATION_VERSION,
  type TypedUIActionReceipt,
  type TypedUIEnvelope,
  type TypedUIProvenanceAttestation,
  type TypedUIValidationIssue,
} from '@/common/typedUI';
import type { ActionBinding, Spec, UIElement } from '@json-render/core';
import { createStateStore } from '@json-render/core';
import { Alert, Button, Spin, Tag } from '@arco-design/web-react';
import { JSONUIProvider, Renderer } from '@json-render/react';
import React, { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  createTypedUIActionHandlers,
  finalizeTypedUIActionWithRetry,
  TYPED_UI_INTERNAL_ACTION_ID,
  TYPED_UI_INTERNAL_UNAVAILABLE_ACTIONS,
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
    const unavailableActions: Record<string, string> = {};
    for (const [event, actionId] of Object.entries(element.on || {})) {
      const action = envelope.actions[actionId];
      if (!action) continue;
      const availability = host.getActionAvailability(action.type, action.params);
      if (!availability.available) {
        unavailableActions[event] = availability.reason || 'action_unavailable';
        continue;
      }
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
      props: {
        ...element.props,
        ...(Object.keys(unavailableActions).length > 0
          ? { [TYPED_UI_INTERNAL_UNAVAILABLE_ACTIONS]: unavailableActions }
          : {}),
      },
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
  const [attestation, setAttestation] = useState<TypedUIProvenanceAttestation>();
  const [attestationFailed, setAttestationFailed] = useState(false);
  const [lastReceipt, setLastReceipt] = useState<TypedUIActionReceipt>();
  const [actionError, setActionError] = useState<string>();
  const store = useMemo(() => createStateStore(envelope.state), [envelope]);
  const spec = useMemo(() => toRuntimeSpec(envelope, host), [envelope, host]);

  useEffect(() => {
    let active = true;
    setAttestation(undefined);
    setAttestationFailed(false);
    void host
      .attestProvenance(envelope)
      .then((result) => {
        if (!active) return;
        if (
          result.status !== 'verified' ||
          result.artifact_id !== receiptContext.artifactId ||
          result.conversation_id !== receiptContext.conversationId ||
          result.source_message_id !== receiptContext.sourceMessageId
        ) {
          setAttestationFailed(true);
          return;
        }
        setAttestation(result);
      })
      .catch(() => {
        if (active) setAttestationFailed(true);
      });
    return () => {
      active = false;
    };
  }, [envelope, host, receiptContext.artifactId, receiptContext.conversationId, receiptContext.sourceMessageId]);

  const handlers = useMemo(
    () =>
      attestation?.status === 'verified'
        ? createTypedUIActionHandlers({ envelope, attestation, receiptContext, store, host, onReceipt: setLastReceipt })
        : {},
    [attestation, envelope, host, receiptContext, store]
  );

  const openWorkbench = async () => {
    if (!onOpenWorkbench || attestation?.status !== 'verified') return;
    setActionError(undefined);
    try {
      const authorization = await host.authorizeAction({
        version: TYPED_UI_ACTION_AUTHORIZATION_VERSION,
        phase: 'authorize',
        request_id: envelope.provenance.request_id,
        artifact_id: receiptContext.artifactId,
        conversation_id: receiptContext.conversationId,
        attestation_id: attestation.attestation_id,
        content_sha256: attestation.content_sha256,
        source_message_id: receiptContext.sourceMessageId,
        action_id: 'host-open-workbench',
        action_type: 'open_artifact',
        params: { artifact_kind: 'chat', artifact_id: receiptContext.artifactId },
      });
      if (authorization.status !== 'authorized') {
        setLastReceipt(authorization);
        return;
      }
      if (!authorization.receipt_id || !authorization.intent_claim_id) throw new Error('missing_intent_identity');
      try {
        await onOpenWorkbench();
      } catch {
        try {
          const failed = await finalizeTypedUIActionWithRetry(host, {
            version: TYPED_UI_ACTION_AUTHORIZATION_VERSION,
            phase: 'finalize',
            intent_receipt_id: authorization.receipt_id,
            intent_claim_id: authorization.intent_claim_id,
            outcome: 'failed',
            reason: 'Workbench navigation or receipt persistence failed.',
          });
          setLastReceipt(failed);
        } catch {
          // Main keeps the intent outstanding if no terminal receipt can be
          // persisted. Never fabricate renderer-only evidence.
        }
        setActionError(t('messages.typedUI.actionUnavailable'));
        return;
      }
      try {
        const completed = await finalizeTypedUIActionWithRetry(host, {
          version: TYPED_UI_ACTION_AUTHORIZATION_VERSION,
          phase: 'finalize',
          intent_receipt_id: authorization.receipt_id,
          intent_claim_id: authorization.intent_claim_id,
          outcome: 'completed',
        });
        setLastReceipt(completed);
      } catch {
        // The Workbench already opened. Keep the Main intent outstanding so a
        // retry cannot open it twice or rewrite the successful effect as failed.
        setActionError(t('messages.typedUI.actionUnavailable'));
      }
    } catch {
      setActionError(t('messages.typedUI.actionUnavailable'));
    }
  };

  const provenanceState = attestationFailed ? 'rejected' : attestation ? 'verified' : 'checking';

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
          <span data-testid='typed-ui-provenance-status'>{t(`messages.typedUI.provenance.${provenanceState}`)}</span>
        </div>
        <Tag>{envelope.catalog_version.replace('command-eve.typed-ui.catalog/', '')}</Tag>
      </header>
      {attestationFailed ? (
        <Alert
          type='warning'
          title={t('messages.typedUI.provenance.rejectedTitle')}
          content={t('messages.typedUI.provenance.rejectedDescription')}
          className={styles.attestationState}
          data-testid='typed-ui-provenance-rejected'
        />
      ) : !attestation ? (
        <div className={styles.loading} role='status' data-testid='typed-ui-provenance-checking'>
          <Spin dot />
          <span>{t('messages.typedUI.provenance.checking')}</span>
        </div>
      ) : (
        <div className={styles.canvas}>
          <JSONUIProvider registry={typedUIRegistry} store={store} handlers={handlers}>
            <Renderer spec={spec} registry={typedUIRegistry} />
          </JSONUIProvider>
        </div>
      )}
      {mode === 'compact' && onOpenWorkbench && attestation?.status === 'verified' ? (
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
  if ('issues' in result) return <InvalidTypedUI issues={result.issues} />;
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

/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import { ipcBridge } from '@/common';
import {
  isHttpUrl,
  TYPED_UI_ACTION_AUTHORIZATION_VERSION,
  TYPED_UI_PROVENANCE_ATTESTATION_VERSION,
  type TypedUIActionAuthorizeRequest,
  type TypedUIActionFinalizeRequest,
  type TypedUIActionReceipt,
  type TypedUIActionType,
  type TypedUIArtifactKind,
  type TypedUIEnvelope,
  type TypedUIProvenanceArtifactRef,
  type TypedUIProvenanceAttestation,
} from '@/common/typedUI';
import type { StateStore } from '@json-render/core';

const INTERNAL_ACTION_ID = '__typed_ui_action_id';
const INTERNAL_UNAVAILABLE_ACTIONS = '__typed_ui_unavailable_actions';

export interface TypedUIActionAvailability {
  available: boolean;
  reason?: string;
}

export interface TypedUIActionHost {
  attestProvenance(envelope: TypedUIEnvelope): Promise<TypedUIProvenanceAttestation>;
  authorizeAction(request: TypedUIActionAuthorizeRequest): Promise<TypedUIActionReceipt>;
  finalizeAction(request: TypedUIActionFinalizeRequest): Promise<TypedUIActionReceipt>;
  getActionAvailability(action: TypedUIActionType, params: Record<string, unknown>): TypedUIActionAvailability;
  openArtifact(kind: TypedUIArtifactKind, artifactId: string): Promise<void> | void;
  openUrl(url: string): Promise<void> | void;
  replyWithState(text: string): Promise<void> | void;
}

export interface TypedUIReceiptContext {
  artifactId: string;
  conversationId: string;
  sourceMessageId: string;
}

export interface TypedUIActionHandlersOptions {
  envelope: TypedUIEnvelope;
  attestation: TypedUIProvenanceAttestation;
  receiptContext: TypedUIReceiptContext;
  store: StateStore;
  host: TypedUIActionHost;
  onReceipt(receipt: TypedUIActionReceipt): void;
}

export async function finalizeTypedUIActionWithRetry(
  host: TypedUIActionHost,
  request: TypedUIActionFinalizeRequest
): Promise<TypedUIActionReceipt> {
  try {
    return await host.finalizeAction(request);
  } catch {
    // Finalize is idempotent in Main. Retrying the exact same outcome closes a
    // lost-response window without authorizing or repeating the host effect.
    return host.finalizeAction(request);
  }
}

function readActionId(params: Record<string, unknown>): string {
  const value = params[INTERNAL_ACTION_ID];
  if (typeof value !== 'string' || !value) throw new Error('Typed UI action identity is missing.');
  return value;
}

function withoutInternalParams(params: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(params).filter(([key]) => key !== INTERNAL_ACTION_ID && key !== INTERNAL_UNAVAILABLE_ACTIONS)
  );
}

function readString(params: Record<string, unknown>, key: string): string | undefined {
  const value = params[key];
  return typeof value === 'string' && value ? value : undefined;
}

function canonicalJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalJson);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(
    Object.keys(value as Record<string, unknown>)
      .toSorted()
      .map((key) => [key, canonicalJson((value as Record<string, unknown>)[key])])
  );
}

function sameActionParams(left: Record<string, unknown>, right: Record<string, unknown>): boolean {
  return JSON.stringify(canonicalJson(left)) === JSON.stringify(canonicalJson(right));
}

function buildStateReply(store: StateStore, params: Record<string, unknown>): string {
  const message = readString(params, 'message');
  const requestedPaths = Array.isArray(params.state_paths)
    ? params.state_paths.filter((path): path is string => typeof path === 'string')
    : [];
  const state = store.getSnapshot();
  const selected =
    requestedPaths.length > 0 ? Object.fromEntries(requestedPaths.map((path) => [path, store.get(path)])) : state;
  const serialized = JSON.stringify(selected, null, 2);
  const bounded = serialized.length > 8000 ? `${serialized.slice(0, 8000)}\n…` : serialized;
  return [message, bounded].filter(Boolean).join('\n\n');
}

function authorizeRequest(
  options: TypedUIActionHandlersOptions,
  actionId: string,
  actionType: TypedUIActionType,
  params: TypedUIActionAuthorizeRequest['params']
): TypedUIActionAuthorizeRequest {
  return {
    version: TYPED_UI_ACTION_AUTHORIZATION_VERSION,
    phase: 'authorize',
    request_id: options.envelope.provenance.request_id,
    artifact_id: options.receiptContext.artifactId,
    conversation_id: options.receiptContext.conversationId,
    attestation_id: options.attestation.attestation_id,
    content_sha256: options.attestation.content_sha256,
    source_message_id: options.receiptContext.sourceMessageId,
    action_id: actionId,
    action_type: actionType,
    params,
  };
}

async function executeAllowedAction(
  actionId: string,
  actionType: TypedUIActionType,
  params: Record<string, unknown>,
  options: TypedUIActionHandlersOptions
): Promise<void> {
  const declared = options.envelope.actions[actionId];
  if (!declared || declared.type !== actionType) {
    throw new Error('Typed UI action does not match its validated declaration.');
  }
  const cleanParams = withoutInternalParams(params);
  if (!sameActionParams(cleanParams, declared.params)) {
    throw new Error('Typed UI action params do not match their validated declaration.');
  }
  // The Durable-Work UI branch has no committed Main transport yet. Keep the
  // typed contract visible but impossible to activate through a renderer host:
  // no authority call, intent receipt or state mutation may occur here.
  if (actionType === 'goal_control' || actionType === 'worker_control') {
    throw new Error('durable_transport_unavailable');
  }
  const availability = options.host.getActionAvailability(actionType, cleanParams);
  if (!availability.available) throw new Error(availability.reason || 'Typed UI action is unavailable.');

  // Main revalidates the attested action binding, evaluates the live EVE
  // authority mode and durably claims the intent before any host/state effect.
  const authorization = await options.host.authorizeAction(
    authorizeRequest(options, actionId, actionType, declared.params)
  );
  if (authorization.status !== 'authorized') {
    options.onReceipt(authorization);
    return;
  }
  if (!authorization.receipt_id || !authorization.intent_claim_id) {
    throw new Error('Typed UI authorization did not return a durable intent identity.');
  }

  try {
    if (actionType === 'reply_with_state') {
      await options.host.replyWithState(buildStateReply(options.store, cleanParams));
    } else if (actionType === 'open_artifact') {
      const artifactId = readString(cleanParams, 'artifact_id');
      const artifactKind = readString(cleanParams, 'artifact_kind') as TypedUIArtifactKind | undefined;
      if (!artifactId || !artifactKind) throw new Error('Artifact identity is missing.');
      await options.host.openArtifact(artifactKind, artifactId);
    } else if (actionType === 'open_url') {
      const url = readString(cleanParams, 'url');
      if (!url || !isHttpUrl(url)) throw new Error('Only credential-free HTTP(S) URLs are allowed.');
      await options.host.openUrl(url);
    } else if (actionType === 'select_option') {
      const statePath = readString(cleanParams, 'state_path');
      if (!statePath) throw new Error('State path is missing.');
      options.store.set(statePath, cleanParams.value);
    }
  } catch (error) {
    try {
      const failed = await finalizeTypedUIActionWithRetry(options.host, {
        version: TYPED_UI_ACTION_AUTHORIZATION_VERSION,
        phase: 'finalize',
        intent_receipt_id: authorization.receipt_id,
        intent_claim_id: authorization.intent_claim_id,
        outcome: 'failed',
        reason: 'Host action or receipt persistence failed.',
      });
      options.onReceipt(failed);
    } catch {
      // The Main intent remains fail-closed and outstanding if no terminal
      // record could be persisted. Never synthesize a renderer-only receipt.
    }
    throw error;
  }

  // Once the host effect succeeded, never rewrite it as failed merely because
  // completion persistence is temporarily unavailable. Main keeps the claim
  // outstanding, so the same effect cannot be authorized twice.
  const completed = await finalizeTypedUIActionWithRetry(options.host, {
    version: TYPED_UI_ACTION_AUTHORIZATION_VERSION,
    phase: 'finalize',
    intent_receipt_id: authorization.receipt_id,
    intent_claim_id: authorization.intent_claim_id,
    outcome: 'completed',
  });
  options.onReceipt(completed);
}

export function createTypedUIActionHandlers(
  options: TypedUIActionHandlersOptions
): Record<TypedUIActionType, (params: Record<string, unknown>) => Promise<void>> {
  const handler =
    (actionType: TypedUIActionType) =>
    async (params: Record<string, unknown>): Promise<void> => {
      try {
        await executeAllowedAction(readActionId(params), actionType, params, options);
      } catch {
        // The handler already attempted a failed receipt when authority had
        // granted an intent. Consume the rejection so a renderer-owned event
        // can never become an unhandled promise.
      }
    };
  return {
    reply_with_state: handler('reply_with_state'),
    open_artifact: handler('open_artifact'),
    open_url: handler('open_url'),
    select_option: handler('select_option'),
    request_approval: handler('request_approval'),
    goal_control: handler('goal_control'),
    worker_control: handler('worker_control'),
  };
}

export function createDefaultTypedUIActionHost(options: {
  provenanceArtifact: TypedUIProvenanceArtifactRef;
  openArtifact?(kind: TypedUIArtifactKind, artifactId: string): Promise<void> | void;
  replyWithState(text: string): Promise<void> | void;
}): TypedUIActionHost {
  return {
    async attestProvenance(envelope) {
      const response = await ipcBridge.commandEve.typedUIProvenanceAttestation.invoke({
        request: {
          version: TYPED_UI_PROVENANCE_ATTESTATION_VERSION,
          envelope,
          artifact: options.provenanceArtifact,
        },
      });
      if (!response?.success || !response.data) {
        throw new Error(response?.msg || 'Typed UI provenance attestation is unavailable.');
      }
      return response.data;
    },
    getActionAvailability(action) {
      if (action === 'open_artifact' && !options.openArtifact) {
        return { available: false, reason: 'artifact_resolver_unavailable' };
      }
      if (action === 'goal_control' || action === 'worker_control') {
        return { available: false, reason: 'durable_transport_unavailable' };
      }
      return { available: true };
    },
    async authorizeAction(request) {
      const response = await ipcBridge.commandEve.typedUIActionReceipt.invoke({ request });
      if (!response?.success || !response.data) {
        throw new Error(response?.msg || 'Typed UI authorization is unavailable.');
      }
      return response.data;
    },
    async finalizeAction(request) {
      const response = await ipcBridge.commandEve.typedUIActionReceipt.invoke({ request });
      if (!response?.success || !response.data) {
        throw new Error(response?.msg || 'Typed UI receipt finalization is unavailable.');
      }
      return response.data;
    },
    openArtifact(kind, artifactId) {
      if (!options.openArtifact) throw new Error('Artifact resolution is unavailable in this host surface.');
      return options.openArtifact(kind, artifactId);
    },
    async openUrl(url) {
      if (!isHttpUrl(url)) throw new Error('Only credential-free HTTP(S) URLs are allowed.');
      await ipcBridge.shell.openExternal.invoke(url);
    },
    replyWithState: options.replyWithState,
  };
}

export const TYPED_UI_INTERNAL_ACTION_ID = INTERNAL_ACTION_ID;
export const TYPED_UI_INTERNAL_UNAVAILABLE_ACTIONS = INTERNAL_UNAVAILABLE_ACTIONS;

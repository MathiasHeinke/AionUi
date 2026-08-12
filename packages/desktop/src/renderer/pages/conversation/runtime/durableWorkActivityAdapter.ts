/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import type { DelegatedTaskProjection } from '@/common/chat/delegationActivity';
import {
  DURABLE_WORK_ACTIVITY_VERSION,
  normalizeDurableWorkSnapshot,
  projectLegacyDelegation,
  type DurableWorkAction,
  type DurableWorkActionAckV1,
  type DurableWorkActionRequestV1,
  type DurableWorkItemV1,
  type DurableWorkSnapshotV1,
} from '@/common/runtime/durableWorkActivity';
import {
  getCurrentLiveDelegationObservation,
  type CurrentLiveDelegationObservation,
} from './conversationDelegationActivityStore';
import { useMemo, useSyncExternalStore } from 'react';

export type DurableWorkActivityAdapterV1 = {
  version: typeof DURABLE_WORK_ACTIVITY_VERSION;
  /** Must return a referentially stable snapshot until subscribe emits. */
  getSnapshot: (conversationId: string) => unknown;
  subscribe: (conversationId: string, listener: () => void) => () => void;
  requestAction: (request: DurableWorkActionRequestV1) => Promise<DurableWorkActionAckV1>;
};

type SnapshotCacheEntry = {
  adapter: DurableWorkActivityAdapterV1;
  raw: unknown;
  normalized: DurableWorkSnapshotV1 | null;
};

let activeAdapter: DurableWorkActivityAdapterV1 | null = null;
const registryListeners = new Set<() => void>();
const snapshotCache = new Map<string, SnapshotCacheEntry>();

const notifyRegistry = () => {
  snapshotCache.clear();
  for (const listener of registryListeners) listener();
};

/**
 * Integration seam for the main Hermes↔AionCore transport. Installing an
 * adapter is intentionally explicit; importing this UI never invents or polls
 * a transport.
 */
export function installDurableWorkActivityAdapter(adapter: DurableWorkActivityAdapterV1): () => void {
  if (adapter.version !== DURABLE_WORK_ACTIVITY_VERSION) {
    throw new Error(`Unsupported durable work adapter: ${adapter.version}`);
  }
  activeAdapter = adapter;
  notifyRegistry();
  return () => {
    if (activeAdapter !== adapter) return;
    activeAdapter = null;
    notifyRegistry();
  };
}

const readSnapshot = (conversationId: string): DurableWorkSnapshotV1 | null => {
  if (!activeAdapter || !conversationId) return null;
  const raw = activeAdapter.getSnapshot(conversationId);
  const cached = snapshotCache.get(conversationId);
  if (cached?.adapter === activeAdapter && Object.is(cached.raw, raw)) return cached.normalized;
  let normalized = normalizeDurableWorkSnapshot(raw, conversationId);
  if (normalized && cached?.adapter === activeAdapter && cached.normalized) {
    if (normalized.revision <= cached.normalized.revision) {
      normalized = cached.normalized;
    } else {
      const previousItems = new Map(cached.normalized.items.map((item) => [item.id, item]));
      normalized = {
        ...normalized,
        items: normalized.items.map((item) => {
          const previous = previousItems.get(item.id);
          return previous && item.sequence < previous.sequence ? previous : item;
        }),
      };
    }
  }
  snapshotCache.set(conversationId, { adapter: activeAdapter, raw, normalized });
  return normalized;
};

const subscribe = (conversationId: string, listener: () => void): (() => void) => {
  let unsubscribeAdapter = activeAdapter?.subscribe(conversationId, listener) ?? (() => {});
  const reconnect = () => {
    unsubscribeAdapter();
    unsubscribeAdapter = activeAdapter?.subscribe(conversationId, listener) ?? (() => {});
    listener();
  };
  registryListeners.add(reconnect);
  return () => {
    registryListeners.delete(reconnect);
    unsubscribeAdapter();
  };
};

export type DurableWorkActivityView = {
  connected: boolean;
  revision: number;
  items: DurableWorkItemV1[];
};

type ProjectedLegacyItem = {
  fallbackItem: DurableWorkItemV1;
  metadataItem: DurableWorkItemV1;
  receiptItemId: string;
  observation: CurrentLiveDelegationObservation | null;
};

const foldLegacyMetadata = (entries: readonly ProjectedLegacyItem[]) => {
  const first = entries[0].metadataItem;
  const goals = Array.from(new Set(entries.map(({ metadataItem }) => metadataItem.goal)));
  const roles = Array.from(new Set(entries.map(({ metadataItem }) => metadataItem.role)));
  const queuedAt = entries
    .map(({ metadataItem }) => metadataItem.queuedAt)
    .filter((value): value is number => value !== undefined)
    .reduce<number | undefined>(
      (earliest, value) => (earliest === undefined ? value : Math.min(earliest, value)),
      undefined
    );

  return {
    kind: entries.length > 1 ? ('subagent' as const) : first.kind,
    goal: goals.join(' · '),
    role: roles.join(' · '),
    queuedAt,
  };
};

export function useDurableWorkActivity(
  conversationId: string,
  legacyTasks: readonly DelegatedTaskProjection[] = []
): DurableWorkActivityView {
  const snapshot = useSyncExternalStore(
    (listener) => subscribe(conversationId, listener),
    () => readSnapshot(conversationId),
    (): DurableWorkSnapshotV1 | null => null
  );

  return useMemo(() => {
    const projectedLegacy: ProjectedLegacyItem[] = conversationId
      ? legacyTasks.map((task) => {
          const observation = getCurrentLiveDelegationObservation(conversationId, task.id);
          const fallbackItem = projectLegacyDelegation(task, conversationId);
          const metadataItem = projectLegacyDelegation(task, conversationId, observation);
          return {
            fallbackItem,
            metadataItem,
            observation,
            receiptItemId: task.delegationId ? `hermes:execution:${task.delegationId}` : fallbackItem.id,
          };
        })
      : [];
    const legacyItems = projectedLegacy.map(({ metadataItem }) => metadataItem);
    if (snapshot) {
      const legacyByReceiptId = new Map<string, ProjectedLegacyItem[]>();
      for (const entry of projectedLegacy) {
        const receipt = snapshot.items.find((item) => item.id === entry.receiptItemId);
        if (!receipt || receipt.origin.sessionId !== entry.observation?.acpSessionId) continue;
        const group = legacyByReceiptId.get(entry.receiptItemId) ?? [];
        group.push(entry);
        legacyByReceiptId.set(entry.receiptItemId, group);
      }
      const coreIds = new Set(snapshot.items.map((item) => item.id));
      return {
        connected: true,
        revision: snapshot.revision,
        items: [
          ...snapshot.items.map((item) => {
            const metadata = legacyByReceiptId.get(item.id);
            const folded = metadata?.length ? foldLegacyMetadata(metadata) : null;
            return folded
              ? {
                  ...item,
                  kind: folded.kind,
                  goal: folded.goal,
                  role: folded.role,
                  queuedAt: folded.queuedAt ?? item.queuedAt,
                }
              : item;
          }),
          ...projectedLegacy
            .filter(({ receiptItemId }) => !coreIds.has(receiptItemId))
            .map(({ fallbackItem }) => fallbackItem),
        ],
      };
    }
    return {
      connected: false,
      revision: 0,
      items: legacyItems,
    };
  }, [conversationId, legacyTasks, snapshot]);
}

const unavailableAck = (
  conversationId: string,
  workItemId: string,
  action: DurableWorkAction,
  expectedRevision: number,
  expectedSequence: number,
  reason: string
): DurableWorkActionAckV1 => {
  const request: DurableWorkActionRequestV1 = {
    version: DURABLE_WORK_ACTIVITY_VERSION,
    conversationId,
    workItemId,
    action,
    expectedRevision,
    expectedSequence,
  };
  return {
    version: DURABLE_WORK_ACTIVITY_VERSION,
    request,
    state: 'unavailable',
    reason,
  };
};

const isActionAckForRequest = (
  value: unknown,
  request: DurableWorkActionRequestV1
): value is DurableWorkActionAckV1 => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const ack = value as Partial<DurableWorkActionAckV1>;
  const echoed = ack.request;
  const stateValid =
    ack.state === 'accepted' ||
    ack.state === 'needs_approval' ||
    ack.state === 'rejected' ||
    ack.state === 'unavailable';
  const receiptRequired = ack.state === 'accepted' || ack.state === 'needs_approval';
  return (
    ack.version === DURABLE_WORK_ACTIVITY_VERSION &&
    stateValid &&
    (!receiptRequired || (typeof ack.receiptId === 'string' && ack.receiptId.length > 0)) &&
    (ack.receiptId === undefined || typeof ack.receiptId === 'string') &&
    (ack.reason === undefined || typeof ack.reason === 'string') &&
    echoed?.version === request.version &&
    echoed.conversationId === request.conversationId &&
    echoed.workItemId === request.workItemId &&
    echoed.action === request.action &&
    echoed.expectedRevision === request.expectedRevision &&
    echoed.expectedSequence === request.expectedSequence
  );
};

export async function requestDurableWorkAction(
  conversationId: string,
  item: DurableWorkItemV1,
  action: DurableWorkAction,
  expectedRevision: number
): Promise<DurableWorkActionAckV1> {
  const capability = item.actions[action];
  if (!activeAdapter || item.origin.conversationId !== conversationId || !capability?.available) {
    return unavailableAck(
      conversationId,
      item.id,
      action,
      expectedRevision,
      item.sequence,
      capability?.reason ||
        (item.origin.conversationId !== conversationId
          ? 'conversation_binding_mismatch'
          : 'durable_adapter_unavailable')
    );
  }

  const adapter = activeAdapter;
  const request: DurableWorkActionRequestV1 = {
    version: DURABLE_WORK_ACTIVITY_VERSION,
    conversationId,
    workItemId: item.id,
    action,
    expectedRevision,
    expectedSequence: item.sequence,
  };
  const ack = await adapter.requestAction(request);
  if (activeAdapter !== adapter || !isActionAckForRequest(ack, request)) {
    return unavailableAck(
      conversationId,
      item.id,
      action,
      expectedRevision,
      item.sequence,
      activeAdapter !== adapter ? 'durable_adapter_changed' : 'invalid_action_ack'
    );
  }
  return ack;
}

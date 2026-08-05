/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import { ipcBridge } from '@/common';
import type { IConversationArtifact, IConversationArtifactStatus, IResponseMessage } from '@/common/adapter/ipcBridge';
import {
  isVideoArtifactEditable,
  type CommandEveVideoConversationArtifactPayload,
} from '@/common/config/videoGenerationRequestCore';
import { addEventListener } from '@/renderer/utils/emitter';

import React, { createContext, useCallback, useContext, useMemo, useSyncExternalStore } from 'react';

type ConversationArtifactContextValue = {
  artifacts: IConversationArtifact[];
  upsertArtifact: (artifact: IConversationArtifact) => void;
  updateArtifactStatus: (artifact_id: string, status: IConversationArtifactStatus) => void;
};

const ConversationArtifactContext = createContext<ConversationArtifactContextValue>({
  artifacts: [],
  upsertArtifact: () => {},
  updateArtifactStatus: () => {},
});

function upsertArtifacts(
  current: IConversationArtifact[],
  next: IConversationArtifact | IConversationArtifact[]
): IConversationArtifact[] {
  const incoming = Array.isArray(next) ? next : [next];
  if (!incoming.length) return current;

  const artifactById = new Map(current.map((artifact) => [artifact.id, artifact]));
  for (const artifact of incoming) {
    artifactById.set(artifact.id, artifact);
  }

  return Array.from(artifactById.values()).toSorted((a, b) => a.created_at - b.created_at);
}

export const useConversationArtifacts = (): IConversationArtifact[] =>
  useContext(ConversationArtifactContext).artifacts;

/**
 * THE shared visibility predicate for conversation artifacts (1.820.3).
 * Extracted from MessageList so the render surface and the contextual media
 * gate in AcpSendBox judge "visible" identically — a dismissed artifact can
 * never activate anything, anywhere. The predicate itself is UNCHANGED from
 * the one MessageList always used; the rendering contract is preserved by
 * moving it, not altering it.
 */
export const isVisibleConversationArtifact = (artifact: IConversationArtifact): boolean => {
  if (artifact.kind === 'cron_trigger') return artifact.status === 'active';
  if (artifact.kind === 'skill_suggest') return artifact.status === 'pending';
  return artifact.status !== 'dismissed';
};

/**
 * The media type of an artifact's payload, narrowed across the union: cron
 * and skill-suggest artifacts have no media payload and answer null.
 */
export const mediaArtifactTypeOf = (artifact: IConversationArtifact): 'image' | 'video' | null => {
  if (artifact.kind === 'cron_trigger' || artifact.kind === 'skill_suggest') return null;
  const type = artifact.payload.artifact_type;
  return type === 'image' || type === 'video' ? type : null;
};

/**
 * Whether a visible artifact is a usable EDIT SOURCE for its medium
 * (1.820.3, Founder blocker 7):
 *
 *   - VIDEO: the canonical hydration/editability core decides — the SAME
 *     `isVideoArtifactEditable` the Hermes envelope and the paid handler
 *     use. An HD/1080p clip, an over-ceiling clip (> 8.7s), one without a
 *     usable local path, or a legacy payload that cannot hydrate is visible
 *     in chat but is NOT an edit source, and must never light an edit
 *     affordance.
 *   - IMAGE: an image artifact is an edit source when it is complete and
 *     carries a usable local path (the managed image lane reads sources at
 *     rest; references ride the same lane) — OR when it is a MANAGED
 *     GENERATED image, which is id-based by contract and qualifies through
 *     its `managed_image` marker instead.
 *
 * Dismissed and pending artifacts are excluded upstream by the visibility
 * predicate plus this status filter — they are never a source.
 */
export const isUsableMediaEditSource = (artifact: IConversationArtifact): boolean => {
  if (!isVisibleConversationArtifact(artifact)) return false;
  if (artifact.status !== 'active' && artifact.status !== 'saved') return false;
  const type = mediaArtifactTypeOf(artifact);
  if (type === 'video') {
    try {
      return isVideoArtifactEditable(artifact.payload as CommandEveVideoConversationArtifactPayload);
    } catch {
      return false;
    }
  }
  if (type === 'image') {
    const payload = artifact.payload as { path?: unknown; data_url?: unknown; url?: unknown; managed_image?: unknown };
    // 1.820.3 — a MANAGED GENERATED image is id-based by contract: its bytes
    // live in Main's private store and the record carries NO path. The marker
    // is the whole qualification — the durable capability grant behind it is
    // what the edit lane resolves, exactly as the video contract's hydration
    // gate qualifies a clip. Byte-compatible with the video edit-source rule.
    if (payload.managed_image === true) return true;
    return (
      (typeof payload.path === 'string' && payload.path.length > 0) ||
      (typeof payload.data_url === 'string' && payload.data_url.length > 0) ||
      (typeof payload.url === 'string' && payload.url.length > 0)
    );
  }
  return false;
};

/**
 * The latest VISIBLE, usable EDIT SOURCE for ONE medium, or null (1.820.3).
 * Per medium by design: "Bearbeite das Bild" must bind to a visible IMAGE
 * even when the newest artifact overall is a video (and vice versa).
 */
export const selectLatestVisibleMediaSourceArtifact = (
  artifacts: readonly IConversationArtifact[],
  medium: 'image' | 'video'
): IConversationArtifact | null => {
  let latest: IConversationArtifact | null = null;
  for (const artifact of artifacts) {
    if (mediaArtifactTypeOf(artifact) !== medium) continue;
    if (!isUsableMediaEditSource(artifact)) continue;
    if (!latest || artifact.created_at > latest.created_at) latest = artifact;
  }
  return latest;
};

export const useUpsertConversationArtifact = (): ((artifact: IConversationArtifact) => void) =>
  useContext(ConversationArtifactContext).upsertArtifact;

export const useUpdateConversationArtifactStatus = (): ((
  artifact_id: string,
  status: IConversationArtifactStatus
) => void) => useContext(ConversationArtifactContext).updateArtifactStatus;

/**
 * MAT-1773 — THE shared conversation artifact store. The state used to live in
 * `ConversationArtifactProvider`'s React state, which made it reachable ONLY
 * inside the chat column the provider wraps: the titlebar elements rail
 * (`ShellElementsRail`) renders OUTSIDE that provider and could never see the
 * managed artifacts the chat was already showing. The store is module-level
 * and keyed by conversation id, so every surface — chat tray, send box, rail —
 * reads the SAME artifacts through one subscription.
 *
 * Lifecycle is reference-counted by subscribers: the first subscriber starts
 * the durable load and the event listeners, the last unsubscribe tears them
 * down and drops the entry, so behavior for the provider alone is unchanged.
 */
type ConversationArtifactStoreEntry = {
  artifacts: IConversationArtifact[];
  listeners: Set<() => void>;
  stop: () => void;
};

const EMPTY_ARTIFACTS: IConversationArtifact[] = [];
const conversationArtifactStores = new Map<string, ConversationArtifactStoreEntry>();

const notifyArtifactListeners = (entry: ConversationArtifactStoreEntry): void => {
  for (const listener of [...entry.listeners]) listener();
};

const replaceStoreArtifacts = (entry: ConversationArtifactStoreEntry, next: IConversationArtifact[]): void => {
  entry.artifacts = next;
  notifyArtifactListeners(entry);
};

const startArtifactStoreLifecycle = (conversation_id: string, entry: ConversationArtifactStoreEntry): (() => void) => {
  let alive = true;

  // AionCore's own artifacts (`listArtifacts`), the desktop's local durable
  // video store (`videoArtifactsList`) and the managed generated-image store
  // (`imageArtifactsList`, 1.820.3) are three independent sources: AionCore
  // never learns about media produced through the direct Main -> gateway
  // calls, so it cannot return them. Fetching all three on every load —
  // including switching back to this conversation — is what makes generated
  // media survive a reload instead of only existing until the last subscriber
  // unsubscribes.
  let loadSeq = 0;
  const loadArtifacts = () => {
    // Generation guard (Grok review MINOR): overlapping refreshes finish
    // out of order — a stale full-replace never lands over a newer one.
    const seq = ++loadSeq;
    return Promise.all([
      ipcBridge.conversation.listArtifacts.invoke({ conversation_id }).catch((error): IConversationArtifact[] => {
        console.error('[ConversationArtifactStore] Failed to load artifacts:', error);
        return [];
      }),
      ipcBridge.commandEve.videoArtifactsList
        .invoke({ conversationId: conversation_id })
        .then((response) => response?.data ?? [])
        .catch((error): IConversationArtifact[] => {
          console.error('[ConversationArtifactStore] Failed to load local video artifacts:', error);
          return [];
        }),
      ipcBridge.commandEve.imageArtifactsList
        .invoke({ conversationId: conversation_id })
        .then((response) => (response?.data ?? []) as IConversationArtifact[])
        .catch((error): IConversationArtifact[] => {
          console.error('[ConversationArtifactStore] Failed to load local image artifacts:', error);
          return [];
        }),
    ]).then(([remoteArtifacts, localVideoArtifacts, localImageArtifacts]) => {
      if (!alive || seq !== loadSeq) return;
      replaceStoreArtifacts(
        entry,
        upsertArtifacts([], [...remoteArtifacts, ...localVideoArtifacts, ...localImageArtifacts])
      );
    });
  };

  void loadArtifacts();

  // 1.820.3 — the MCP/agent-lane edit display gap, closed with CORRECT
  // timing. A video EDIT produced inside an agent turn (the MCP
  // `eve_video_edit` lane or the loopback) persists its child artifact in
  // Main's durable store but fires no renderer-local event the way the
  // direct generation lane does. Two complementary triggers, both
  // generation-guarded above:
  //   - `commandEve.artifacts.refresh`: emitted by useAcpMessage's terminal
  //     `finish` case — the REAL turn completion, by which time the child
  //     exists on disk. This is the agent-lane fix.
  //   - `chat.history.refresh`: the generic surface refresh other flows
  //     already rely on (cheap; the seq guard makes it harmless).
  // The durable store is the authority; both are refreshes, never guesses.
  const unsubscribeFinishRefresh = addEventListener(
    'commandEve.artifacts.refresh',
    (event: { conversation_id: string }) => {
      if (event.conversation_id !== conversation_id) return;
      void loadArtifacts();
    }
  );
  const unsubscribeRefresh = addEventListener('chat.history.refresh', () => {
    void loadArtifacts();
  });
  // 1.820.3 same-turn insertion, the lane-independent trigger: Main emits
  // this after ANY fresh bind (finish fast path, reconcile, list recovery)
  // because renderer-side turn events proved unreliable on this lane.
  const unsubscribeImageChanged = ipcBridge.commandEve.imageArtifactsChanged.on((event) => {
    if (event.conversation_id !== conversation_id) return;
    void loadArtifacts();
  });

  // Immediate feedback for the send that just finished: the durable save
  // above already happened in Main (this artifact is the one Main returned
  // after writing it to disk), so upserting it here is not a "toast" — it is
  // the SAME artifact the next load will also find via videoArtifactsList.
  const unsubscribeVideoGenerated = addEventListener('acp.video.generated', (event) => {
    if (event.conversation_id !== conversation_id) return;
    replaceStoreArtifacts(entry, upsertArtifacts(entry.artifacts, event.artifact));
  });

  const unsubscribeArtifactStream = ipcBridge.conversation.artifactStream.on((artifact: IConversationArtifact) => {
    if (artifact.conversation_id !== conversation_id) return;
    replaceStoreArtifacts(entry, upsertArtifacts(entry.artifacts, artifact));
  });

  return () => {
    alive = false;
    unsubscribeFinishRefresh();
    unsubscribeRefresh();
    unsubscribeImageChanged();
    unsubscribeVideoGenerated();
    unsubscribeArtifactStream();
  };
};

const getOrCreateArtifactStore = (conversation_id: string): ConversationArtifactStoreEntry => {
  let entry = conversationArtifactStores.get(conversation_id);
  if (!entry) {
    entry = { artifacts: EMPTY_ARTIFACTS, listeners: new Set(), stop: () => {} };
    entry.stop = startArtifactStoreLifecycle(conversation_id, entry);
    conversationArtifactStores.set(conversation_id, entry);
  }
  return entry;
};

const subscribeConversationArtifactStore = (conversation_id: string, listener: () => void): (() => void) => {
  const entry = getOrCreateArtifactStore(conversation_id);
  entry.listeners.add(listener);
  return () => {
    entry.listeners.delete(listener);
    if (entry.listeners.size === 0) {
      entry.stop();
      conversationArtifactStores.delete(conversation_id);
    }
  };
};

/**
 * Stage an artifact into the SHARED store for a conversation — the imperative
 * counterpart to the provider's context `upsertArtifact`, for callers that
 * run OUTSIDE the provider tree (useAcpMessage's stream handler, MAT-1773).
 * A no-op when nothing is showing the conversation: with no subscriber there
 * is no surface to update, and the next mount re-reads the durable sources.
 */
export const stageConversationArtifact = (conversation_id: string, artifact: IConversationArtifact): void => {
  const entry = conversationArtifactStores.get(conversation_id);
  if (!entry) return;
  replaceStoreArtifacts(entry, upsertArtifacts(entry.artifacts, artifact));
};

const updateStoreArtifactStatus = (
  conversation_id: string,
  artifact_id: string,
  status: IConversationArtifactStatus
): void => {
  const entry = conversationArtifactStores.get(conversation_id);
  if (!entry) return;
  replaceStoreArtifacts(
    entry,
    entry.artifacts.map((artifact) =>
      artifact.id === artifact_id ? { ...artifact, status, updated_at: Date.now() } : artifact
    )
  );
};

/**
 * Read the shared artifact store for ANY conversation, inside or outside the
 * provider tree. This is the hook the elements rail uses: it lists exactly
 * the artifacts the chat renders, and re-renders on every store change
 * (managed-lane bind, staged report, stream push).
 */
export const useConversationArtifactsById = (conversation_id?: string): IConversationArtifact[] => {
  const subscribe = useCallback(
    (listener: () => void) =>
      conversation_id ? subscribeConversationArtifactStore(conversation_id, listener) : () => {},
    [conversation_id]
  );
  const getSnapshot = useCallback(
    () =>
      conversation_id
        ? (conversationArtifactStores.get(conversation_id)?.artifacts ?? EMPTY_ARTIFACTS)
        : EMPTY_ARTIFACTS,
    [conversation_id]
  );
  return useSyncExternalStore(subscribe, getSnapshot);
};

/**
 * MAT-1773 — build a store artifact from an IN-SESSION self-report. AionCore
 * streams `skill_suggest`/`cron_trigger` response messages the moment EVE
 * reports them, but they are not chat messages — they are ARTIFACTS, and
 * without staging they only appear after a full reload re-reads
 * `listArtifacts`. Accepts both a full artifact payload and a bare payload.
 */
export const buildReportedConversationArtifact = (message: IResponseMessage): IConversationArtifact | null => {
  if (message.type !== 'skill_suggest' && message.type !== 'cron_trigger') return null;
  const data = message.data;
  if (!data || typeof data !== 'object' || Array.isArray(data)) return null;
  const record = data as Record<string, unknown>;
  const payload = (
    record.payload && typeof record.payload === 'object' && !Array.isArray(record.payload) ? record.payload : record
  ) as Record<string, unknown>;
  const id =
    typeof record.id === 'string' && record.id
      ? record.id
      : `${message.conversation_id}-${message.type}-${message.msg_id}`;
  const createdAt =
    typeof record.created_at === 'number' && Number.isFinite(record.created_at)
      ? record.created_at
      : (message.created_at ?? Date.now());
  const status: IConversationArtifactStatus =
    record.status === 'active' ||
    record.status === 'pending' ||
    record.status === 'dismissed' ||
    record.status === 'saved'
      ? record.status
      : message.type === 'skill_suggest'
        ? 'pending'
        : 'active';
  const base = {
    id,
    conversation_id: message.conversation_id,
    status,
    created_at: createdAt,
    updated_at:
      typeof record.updated_at === 'number' && Number.isFinite(record.updated_at) ? record.updated_at : createdAt,
  };
  if (message.type === 'skill_suggest') {
    if (typeof payload.name !== 'string' || !payload.name) return null;
    return {
      ...base,
      kind: 'skill_suggest',
      payload: {
        cron_job_id: typeof payload.cron_job_id === 'string' ? payload.cron_job_id : '',
        name: payload.name,
        description: typeof payload.description === 'string' ? payload.description : '',
        ...(typeof payload.skillContent === 'string' ? { skillContent: payload.skillContent } : {}),
        ...(typeof payload.skill_content === 'string' ? { skill_content: payload.skill_content } : {}),
      },
    };
  }
  if (typeof payload.cron_job_name !== 'string' || !payload.cron_job_name) return null;
  return {
    ...base,
    kind: 'cron_trigger',
    payload: {
      cron_job_id: typeof payload.cron_job_id === 'string' ? payload.cron_job_id : '',
      cron_job_name: payload.cron_job_name,
      triggered_at:
        typeof payload.triggered_at === 'number' && Number.isFinite(payload.triggered_at)
          ? payload.triggered_at
          : createdAt,
    },
  };
};

export const ConversationArtifactProvider: React.FC<React.PropsWithChildren<{ conversation_id: string }>> = ({
  conversation_id,
  children,
}) => {
  const artifacts = useConversationArtifactsById(conversation_id);

  const upsertArtifact = useCallback(
    (artifact: IConversationArtifact) => {
      stageConversationArtifact(conversation_id, artifact);
    },
    [conversation_id]
  );

  const updateArtifactStatus = useCallback(
    (artifact_id: string, status: IConversationArtifactStatus) => {
      updateStoreArtifactStatus(conversation_id, artifact_id, status);
    },
    [conversation_id]
  );

  const value = useMemo<ConversationArtifactContextValue>(
    () => ({
      artifacts,
      upsertArtifact,
      updateArtifactStatus,
    }),
    [artifacts, upsertArtifact, updateArtifactStatus]
  );

  return <ConversationArtifactContext.Provider value={value}>{children}</ConversationArtifactContext.Provider>;
};

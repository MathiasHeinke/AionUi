/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import { ipcBridge } from '@/common';
import type { IConversationArtifact, IConversationArtifactStatus } from '@/common/adapter/ipcBridge';
import {
  isVideoArtifactEditable,
  type CommandEveVideoConversationArtifactPayload,
} from '@/common/config/videoGenerationRequestCore';
import { addEventListener, useAddEventListener } from '@/renderer/utils/emitter';

import React, { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';

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

export const ConversationArtifactProvider: React.FC<React.PropsWithChildren<{ conversation_id: string }>> = ({
  conversation_id,
  children,
}) => {
  const [artifacts, setArtifacts] = useState<IConversationArtifact[]>([]);

  const upsertArtifact = useCallback((artifact: IConversationArtifact) => {
    setArtifacts((current) => upsertArtifacts(current, artifact));
  }, []);

  const updateArtifactStatus = useCallback((artifact_id: string, status: IConversationArtifactStatus) => {
    setArtifacts((current) =>
      current.map((artifact) =>
        artifact.id === artifact_id ? { ...artifact, status, updated_at: Date.now() } : artifact
      )
    );
  }, []);

  useEffect(() => {
    let alive = true;
    setArtifacts([]);

    // AionCore's own artifacts (`listArtifacts`), the desktop's local durable
    // video store (`videoArtifactsList`) and the managed generated-image store
    // (`imageArtifactsList`, 1.820.3) are three independent sources: AionCore
    // never learns about media produced through the direct Main -> gateway
    // calls, so it cannot return them. Fetching all three on every load —
    // including switching back to this conversation — is what makes generated
    // media survive a reload instead of only existing until this provider
    // unmounts.
    let loadSeq = 0;
    const loadArtifacts = () => {
      // Generation guard (Grok review MINOR): overlapping refreshes finish
      // out of order — a stale full-replace never lands over a newer one.
      const seq = ++loadSeq;
      return Promise.all([
        ipcBridge.conversation.listArtifacts.invoke({ conversation_id }).catch((error): IConversationArtifact[] => {
          console.error('[ConversationArtifactProvider] Failed to load artifacts:', error);
          return [];
        }),
        ipcBridge.commandEve.videoArtifactsList
          .invoke({ conversationId: conversation_id })
          .then((response) => response?.data ?? [])
          .catch((error): IConversationArtifact[] => {
            console.error('[ConversationArtifactProvider] Failed to load local video artifacts:', error);
            return [];
          }),
        ipcBridge.commandEve.imageArtifactsList
          .invoke({ conversationId: conversation_id })
          .then((response) => (response?.data ?? []) as IConversationArtifact[])
          .catch((error): IConversationArtifact[] => {
            console.error('[ConversationArtifactProvider] Failed to load local image artifacts:', error);
            return [];
          }),
      ]).then(([remoteArtifacts, localVideoArtifacts, localImageArtifacts]) => {
        if (!alive || seq !== loadSeq) return;
        setArtifacts(upsertArtifacts([], [...remoteArtifacts, ...localVideoArtifacts, ...localImageArtifacts]));
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

    return () => {
      alive = false;
      unsubscribeFinishRefresh();
      unsubscribeRefresh();
    };
  }, [conversation_id]);

  // Immediate feedback for the send that just finished: the durable save
  // above already happened in Main (this artifact is the one Main returned
  // after writing it to disk), so upserting it here is not a "toast" — it is
  // the SAME artifact the next load will also find via videoArtifactsList.
  useAddEventListener(
    'acp.video.generated',
    (event) => {
      if (event.conversation_id !== conversation_id) return;
      upsertArtifact(event.artifact);
    },
    [conversation_id, upsertArtifact]
  );

  useEffect(() => {
    if (!conversation_id) return;

    return ipcBridge.conversation.artifactStream.on((artifact: IConversationArtifact) => {
      if (artifact.conversation_id !== conversation_id) return;
      upsertArtifact(artifact);
    });
  }, [conversation_id, upsertArtifact]);

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

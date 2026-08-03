/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import { ipcBridge } from '@/common';
import type { IConversationArtifact, IConversationArtifactStatus } from '@/common/adapter/ipcBridge';
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
 * The latest VISIBLE, SOURCE-CAPABLE media artifact, or null (1.820.3).
 *
 * Stricter than mere visibility on purpose: a dismissed artifact is not
 * visible at all, a pending one is not a source yet (it is still being
 * produced), and a payload without a media `artifact_type` ('image' |
 * 'video') is not a media source either — so dismissed, failed/pending or
 * non-source media can never activate contextual controls downstream.
 */
export const selectLatestVisibleMediaSourceArtifact = (
  artifacts: readonly IConversationArtifact[]
): IConversationArtifact | null => {
  let latest: IConversationArtifact | null = null;
  for (const artifact of artifacts) {
    if (!isVisibleConversationArtifact(artifact)) continue;
    if (artifact.status !== 'active' && artifact.status !== 'saved') continue;
    if (mediaArtifactTypeOf(artifact) === null) continue;
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

    // AionCore's own artifacts (`listArtifacts`) and the desktop's local durable
    // store (`videoArtifactsList`) are two independent sources: AionCore never
    // learns about a video generated through the direct Main -> gateway call, so
    // it cannot return it. Fetching both on every load — including switching
    // back to this conversation — is what makes a generated video survive a
    // reload instead of only existing until this provider unmounts.
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
      ]).then(([remoteArtifacts, localVideoArtifacts]) => {
        if (!alive || seq !== loadSeq) return;
        setArtifacts(upsertArtifacts([], [...remoteArtifacts, ...localVideoArtifacts]));
      });
    };

    void loadArtifacts();

    // 1.820.3 — the MCP/agent-lane edit display gap, closed. A video EDIT
    // produced inside an agent turn (the MCP `eve_video_edit` lane or the
    // loopback) persists its child artifact in Main's durable store but fires
    // no renderer-local event the way the direct generation lane does. The
    // turn's own completion signal is `chat.history.refresh` — the same event
    // every other surface already refetches on — so we reload both artifact
    // sources on it: the edited clip becomes visible WITH the agent's answer,
    // not after a manual conversation reload. The durable store is the
    // authority; this is a refresh, never a guess.
    const unsubscribeRefresh = addEventListener('chat.history.refresh', () => {
      void loadArtifacts();
    });

    return () => {
      alive = false;
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

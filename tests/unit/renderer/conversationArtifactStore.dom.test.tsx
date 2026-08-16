/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * MAT-1773 — the shared conversation artifact store behind
 * `ConversationArtifactContext`. The provider (chat tray) and any consumer
 * OUTSIDE the provider tree (the titlebar elements rail) must read the SAME
 * per-conversation artifacts, reactively — that sharing is what lets the
 * rail list managed artifacts the chat already shows.
 */

import { act, render, renderHook, screen, waitFor } from '@testing-library/react';
import React from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { IConversationArtifact } from '@/common/adapter/ipcBridge';
import {
  buildReportedConversationArtifact,
  ConversationArtifactProvider,
  stageConversationArtifact,
  useConversationArtifacts,
  useConversationArtifactsById,
} from '@/renderer/pages/conversation/Messages/artifacts';
import { emitter } from '@/renderer/utils/emitter';

const {
  listArtifactsInvokeMock,
  videoArtifactsListInvokeMock,
  imageArtifactsListInvokeMock,
  artifactStreamOnMock,
  imageArtifactsChangedUnsubscribeMock,
} = vi.hoisted(() => ({
  listArtifactsInvokeMock: vi.fn(),
  videoArtifactsListInvokeMock: vi.fn(),
  imageArtifactsListInvokeMock: vi.fn(),
  artifactStreamOnMock: vi.fn(() => () => {}),
  imageArtifactsChangedUnsubscribeMock: vi.fn(),
}));

vi.mock('@/common', () => ({
  ipcBridge: {
    conversation: {
      listArtifacts: { invoke: listArtifactsInvokeMock },
      artifactStream: { on: artifactStreamOnMock },
    },
    commandEve: {
      videoArtifactsList: { invoke: videoArtifactsListInvokeMock },
      imageArtifactsList: { invoke: imageArtifactsListInvokeMock },
      imageArtifactsChanged: { on: vi.fn(() => imageArtifactsChangedUnsubscribeMock) },
    },
  },
}));

const imageArtifact: IConversationArtifact = {
  id: 'img-1',
  conversation_id: 'conv-1',
  kind: 'image',
  status: 'active',
  payload: { artifact_type: 'image', title: 'Chart.png', managed_image: true },
  created_at: 1000,
  updated_at: 1000,
};

const editedVideoChild: IConversationArtifact = {
  id: 'video-edit-child',
  conversation_id: 'conv-1',
  kind: 'video',
  status: 'active',
  payload: {
    artifact_type: 'video',
    title: 'Edited video',
    description: '720p · 5s',
    path: '/private/videos/conv-1/video-edit-child.mp4',
    mime_type: 'video/mp4',
    hash: 'e'.repeat(64),
    size: 24,
    duration_seconds: 5,
    origin_capability: 'video_edit',
    parent_artifact_id: 'video-source',
    tier_id: 'fast',
  },
  created_at: 2000,
  updated_at: 2000,
};

const ArtifactIds: React.FC = () => {
  const artifacts = useConversationArtifacts();
  return <div data-testid='provider-ids'>{artifacts.map((a) => a.id).join(',')}</div>;
};

beforeEach(() => {
  vi.clearAllMocks();
  listArtifactsInvokeMock.mockResolvedValue([]);
  videoArtifactsListInvokeMock.mockResolvedValue({ success: true, data: [] });
  imageArtifactsListInvokeMock.mockResolvedValue({ success: true, data: [] });
});

describe('shared conversation artifact store (MAT-1773)', () => {
  it('serves the provider tree and an outside-tree consumer from ONE store with ONE load', async () => {
    listArtifactsInvokeMock.mockResolvedValue([imageArtifact]);

    const outside = renderHook(() => useConversationArtifactsById('conv-1'));
    render(
      <ConversationArtifactProvider conversation_id='conv-1'>
        <ArtifactIds />
      </ConversationArtifactProvider>
    );

    await waitFor(() => expect(screen.getByTestId('provider-ids').textContent).toBe('img-1'));
    expect(outside.result.current.map((a) => a.id)).toEqual(['img-1']);
    // Two subscribers, one lifecycle: the durable sources are read ONCE.
    expect(listArtifactsInvokeMock).toHaveBeenCalledTimes(1);
    expect(imageArtifactsListInvokeMock).toHaveBeenCalledTimes(1);
  });

  it('registers one durable edit child with provenance in both chat and the right-rail store', async () => {
    videoArtifactsListInvokeMock.mockResolvedValue({ success: true, data: [editedVideoChild] });

    const rightRail = renderHook(() => useConversationArtifactsById('conv-1'));
    render(
      <ConversationArtifactProvider conversation_id='conv-1'>
        <ArtifactIds />
      </ConversationArtifactProvider>
    );

    await waitFor(() => expect(screen.getByTestId('provider-ids').textContent).toBe('video-edit-child'));
    expect(rightRail.result.current).toHaveLength(1);
    expect(rightRail.result.current[0]).toMatchObject({
      id: 'video-edit-child',
      conversation_id: 'conv-1',
      payload: {
        hash: 'e'.repeat(64),
        origin_capability: 'video_edit',
        parent_artifact_id: 'video-source',
      },
    });
    expect(videoArtifactsListInvokeMock).toHaveBeenCalledTimes(1);
  });

  it('notifies every subscriber reactively when an artifact is staged outside React', async () => {
    const outside = renderHook(() => useConversationArtifactsById('conv-1'));
    render(
      <ConversationArtifactProvider conversation_id='conv-1'>
        <ArtifactIds />
      </ConversationArtifactProvider>
    );
    await waitFor(() => expect(listArtifactsInvokeMock).toHaveBeenCalled());

    act(() => {
      stageConversationArtifact('conv-1', imageArtifact);
    });

    expect(screen.getByTestId('provider-ids').textContent).toBe('img-1');
    expect(outside.result.current.map((a) => a.id)).toEqual(['img-1']);
  });

  it('stages nothing when nobody subscribes, and loads durable truth on the next mount', async () => {
    act(() => {
      stageConversationArtifact('conv-1', imageArtifact);
    });
    expect(listArtifactsInvokeMock).not.toHaveBeenCalled();

    const outside = renderHook(() => useConversationArtifactsById('conv-1'));
    await waitFor(() => expect(listArtifactsInvokeMock).toHaveBeenCalledWith({ conversation_id: 'conv-1' }));
    // The durable list is empty, so the never-persisted staged artifact is gone.
    await waitFor(() => expect(outside.result.current).toEqual([]));
  });

  it('refreshes from the durable stores when the managed-lane refresh event fires', async () => {
    const outside = renderHook(() => useConversationArtifactsById('conv-1'));
    await waitFor(() => expect(listArtifactsInvokeMock).toHaveBeenCalledTimes(1));

    imageArtifactsListInvokeMock.mockResolvedValue({ success: true, data: [imageArtifact] });
    act(() => {
      emitter.emit('commandEve.artifacts.refresh', { conversation_id: 'conv-1' });
    });

    await waitFor(() => expect(outside.result.current.map((a) => a.id)).toEqual(['img-1']));
    expect(imageArtifactsListInvokeMock).toHaveBeenCalledTimes(2);
  });

  it('tears the lifecycle down with the last subscriber and starts fresh on remount', async () => {
    const first = renderHook(() => useConversationArtifactsById('conv-1'));
    await waitFor(() => expect(listArtifactsInvokeMock).toHaveBeenCalledTimes(1));

    first.unmount();
    expect(imageArtifactsChangedUnsubscribeMock).toHaveBeenCalledTimes(1);

    const second = renderHook(() => useConversationArtifactsById('conv-1'));
    await waitFor(() => expect(listArtifactsInvokeMock).toHaveBeenCalledTimes(2));
    second.unmount();
  });
});

describe('buildReportedConversationArtifact', () => {
  const baseMessage = {
    msg_id: 'msg-1',
    turn_id: 'turn-1',
    conversation_id: 'conv-1',
    created_at: 5000,
  };

  it('builds a pending skill_suggest artifact from a bare payload report', () => {
    const artifact = buildReportedConversationArtifact({
      ...baseMessage,
      type: 'skill_suggest',
      data: { cron_job_id: 'job-1', name: 'Wochenbericht', description: 'Erstellt den Bericht' },
    });
    expect(artifact).toMatchObject({
      conversation_id: 'conv-1',
      kind: 'skill_suggest',
      status: 'pending',
      created_at: 5000,
      payload: { cron_job_id: 'job-1', name: 'Wochenbericht', description: 'Erstellt den Bericht' },
    });
  });

  it('keeps id, status and payload of a full-artifact report', () => {
    const artifact = buildReportedConversationArtifact({
      ...baseMessage,
      type: 'skill_suggest',
      data: {
        id: 'artifact-9',
        status: 'dismissed',
        created_at: 4000,
        updated_at: 4500,
        payload: { cron_job_id: 'job-1', name: 'Wochenbericht', description: 'Erstellt den Bericht' },
      },
    });
    expect(artifact).toMatchObject({
      id: 'artifact-9',
      kind: 'skill_suggest',
      status: 'dismissed',
      created_at: 4000,
      updated_at: 4500,
    });
  });

  it('builds an active cron_trigger artifact and rejects reports without their core payload', () => {
    const cron = buildReportedConversationArtifact({
      ...baseMessage,
      type: 'cron_trigger',
      data: { cron_job_id: 'job-9', cron_job_name: 'Tagessync', triggered_at: 123 },
    });
    expect(cron).toMatchObject({
      kind: 'cron_trigger',
      status: 'active',
      payload: { cron_job_id: 'job-9', cron_job_name: 'Tagessync', triggered_at: 123 },
    });

    expect(
      buildReportedConversationArtifact({ ...baseMessage, type: 'skill_suggest', data: { description: 'namelos' } })
    ).toBeNull();
    expect(
      buildReportedConversationArtifact({ ...baseMessage, type: 'cron_trigger', data: { cron_job_id: 'job-9' } })
    ).toBeNull();
    expect(buildReportedConversationArtifact({ ...baseMessage, type: 'skill_suggest', data: null })).toBeNull();
    expect(buildReportedConversationArtifact({ ...baseMessage, type: 'text', data: 'hello' })).toBeNull();
  });
});

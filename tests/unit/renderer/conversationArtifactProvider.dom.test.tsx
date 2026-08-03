/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * `ConversationArtifactProvider` is the merge point for two independent
 * artifact sources: AionCore's own `listArtifacts`/`artifactStream`, and this
 * desktop's local durable store for managed video (`videoArtifactsList` +
 * `acp.video.generated`). AionCore never learns about a video generated
 * through the direct Main -> gateway call, so without this merge a generated
 * video would exist only until the provider unmounts — exactly the
 * "does not survive a reload" failure the video lane must not repeat.
 */

import { act, render, screen, waitFor } from '@testing-library/react';
import React from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  ConversationArtifactProvider,
  useConversationArtifacts,
} from '@/renderer/pages/conversation/Messages/artifacts';
import { emitter } from '@/renderer/utils/emitter';

const { listArtifactsInvokeMock, videoArtifactsListInvokeMock, artifactStreamOnMock } = vi.hoisted(() => ({
  listArtifactsInvokeMock: vi.fn(),
  videoArtifactsListInvokeMock: vi.fn(),
  artifactStreamOnMock: vi.fn(() => () => {}),
}));

vi.mock('@/common', () => ({
  ipcBridge: {
    conversation: {
      listArtifacts: { invoke: listArtifactsInvokeMock },
      artifactStream: { on: artifactStreamOnMock },
    },
    commandEve: {
      videoArtifactsList: { invoke: videoArtifactsListInvokeMock },
    },
  },
}));

const videoArtifact = {
  id: 'video-1',
  conversation_id: 'conv-1',
  kind: 'video',
  status: 'active',
  payload: {
    artifact_type: 'video',
    title: 'Video 720p',
    description: '720p · 5s · ca. 700 Credits · grok-imagine-video',
    path: '/tmp/Downloads/Command EVE Videos/conv-1/video-1.mp4',
    mime_type: 'video/mp4',
    hash: 'a'.repeat(64),
    size: 3,
  },
  created_at: 1000,
  updated_at: 1000,
};

const ArtifactIds: React.FC = () => {
  const artifacts = useConversationArtifacts();
  return <div data-testid='artifact-ids'>{artifacts.map((a) => a.id).join(',')}</div>;
};

beforeEach(() => {
  listArtifactsInvokeMock.mockReset();
  videoArtifactsListInvokeMock.mockReset();
  listArtifactsInvokeMock.mockResolvedValue([]);
  videoArtifactsListInvokeMock.mockResolvedValue({ success: true, data: [] });
});

describe('ConversationArtifactProvider', () => {
  it('merges AionCore artifacts with the local durable video-artifact store on load', async () => {
    listArtifactsInvokeMock.mockResolvedValue([
      {
        id: 'remote-1',
        conversation_id: 'conv-1',
        kind: 'image',
        status: 'active',
        payload: {},
        created_at: 500,
        updated_at: 500,
      },
    ]);
    videoArtifactsListInvokeMock.mockResolvedValue({ success: true, data: [videoArtifact] });

    render(
      <ConversationArtifactProvider conversation_id='conv-1'>
        <ArtifactIds />
      </ConversationArtifactProvider>
    );

    await waitFor(() => expect(screen.getByTestId('artifact-ids').textContent).toContain('video-1'));
    expect(screen.getByTestId('artifact-ids').textContent).toContain('remote-1');
    expect(videoArtifactsListInvokeMock).toHaveBeenCalledWith({ conversationId: 'conv-1' });
  });

  it('survives a reload: unmounting and remounting the provider re-finds the video artifact', async () => {
    videoArtifactsListInvokeMock.mockResolvedValue({ success: true, data: [videoArtifact] });

    const { unmount } = render(
      <ConversationArtifactProvider conversation_id='conv-1'>
        <ArtifactIds />
      </ConversationArtifactProvider>
    );
    await waitFor(() => expect(screen.getByTestId('artifact-ids').textContent).toContain('video-1'));

    // Simulates leaving and returning to the conversation (or an app restart):
    // a FRESH provider instance, with nothing carried over in memory, must
    // still find the video — because it was saved to disk, not just upserted
    // into this instance's React state.
    unmount();
    render(
      <ConversationArtifactProvider conversation_id='conv-1'>
        <ArtifactIds />
      </ConversationArtifactProvider>
    );

    await waitFor(() => expect(screen.getByTestId('artifact-ids').textContent).toContain('video-1'));
    expect(videoArtifactsListInvokeMock).toHaveBeenCalledTimes(2);
  });

  it('upserts immediately on acp.video.generated for its own conversation', async () => {
    render(
      <ConversationArtifactProvider conversation_id='conv-1'>
        <ArtifactIds />
      </ConversationArtifactProvider>
    );
    await waitFor(() => expect(videoArtifactsListInvokeMock).toHaveBeenCalled());
    expect(screen.getByTestId('artifact-ids').textContent).toBe('');

    act(() => {
      emitter.emit('acp.video.generated', { conversation_id: 'conv-1', artifact: videoArtifact as never });
    });

    expect(screen.getByTestId('artifact-ids').textContent).toBe('video-1');
  });

  it('ignores acp.video.generated for a different conversation', async () => {
    render(
      <ConversationArtifactProvider conversation_id='conv-1'>
        <ArtifactIds />
      </ConversationArtifactProvider>
    );
    await waitFor(() => expect(videoArtifactsListInvokeMock).toHaveBeenCalled());

    act(() => {
      emitter.emit('acp.video.generated', { conversation_id: 'conv-2', artifact: videoArtifact as never });
    });

    expect(screen.getByTestId('artifact-ids').textContent).toBe('');
  });

  it('1.820.3 display gap closed: a chat.history.refresh reloads both sources, so an agent-lane edit child becomes visible', async () => {
    // The MCP/loopback `eve_video_edit` lane persists the edited child in
    // Main's durable store but fires no renderer-local event. The turn's own
    // completion signal must be enough: on chat.history.refresh the provider
    // re-fetches and the child appears WITH the answer, not after a manual
    // conversation reload.
    render(
      <ConversationArtifactProvider conversation_id='conv-1'>
        <ArtifactIds />
      </ConversationArtifactProvider>
    );
    await waitFor(() => expect(videoArtifactsListInvokeMock).toHaveBeenCalledTimes(1));
    expect(screen.getByTestId('artifact-ids').textContent).toBe('');

    // The edit completes in Main: the durable store now holds source + child.
    const editChild = {
      ...videoArtifact,
      id: 'video-1-edit-1',
      payload: { ...videoArtifact.payload, parent_artifact_id: 'video-1' },
      created_at: 2000,
      updated_at: 2000,
    };
    videoArtifactsListInvokeMock.mockResolvedValue({ success: true, data: [videoArtifact, editChild] });

    act(() => {
      emitter.emit('chat.history.refresh');
    });

    await waitFor(() => expect(videoArtifactsListInvokeMock).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(screen.getByTestId('artifact-ids').textContent).toContain('video-1-edit-1'));
    expect(screen.getByTestId('artifact-ids').textContent).toContain('video-1');
  });
});

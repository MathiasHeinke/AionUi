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
  selectLatestVisibleMediaSourceArtifact,
  useConversationArtifacts,
} from '@/renderer/pages/conversation/Messages/artifacts';
import { emitter } from '@/renderer/utils/emitter';

const {
  listArtifactsInvokeMock,
  videoArtifactsListInvokeMock,
  imageArtifactsListInvokeMock,
  artifactStreamOnMock,
  imageArtifactsChangedCallback,
  imageArtifactsChangedUnsubscribeMock,
} = vi.hoisted(() => {
  const callbackHolder: { current: undefined | ((event: { conversation_id: string }) => void) } = { current: undefined };
  // The unsubscribe mirrors the REAL emitter contract: it detaches the
  // listener, so a post-unmount event never reaches the callback at all.
  const unsubscribeMock = vi.fn(() => {
    callbackHolder.current = undefined;
  });
  return {
    listArtifactsInvokeMock: vi.fn(),
    videoArtifactsListInvokeMock: vi.fn(),
    imageArtifactsListInvokeMock: vi.fn(),
    artifactStreamOnMock: vi.fn(() => () => {}),
    imageArtifactsChangedCallback: callbackHolder,
    imageArtifactsChangedUnsubscribeMock: unsubscribeMock,
  };
});

vi.mock('@/common', () => ({
  ipcBridge: {
    conversation: {
      listArtifacts: { invoke: listArtifactsInvokeMock },
      artifactStream: { on: artifactStreamOnMock },
    },
    commandEve: {
      videoArtifactsList: { invoke: videoArtifactsListInvokeMock },
      imageArtifactsList: { invoke: imageArtifactsListInvokeMock },
      imageArtifactsChanged: {
        on: (callback: (event: { conversation_id: string }) => void) => {
          imageArtifactsChangedCallback.current = callback;
          return imageArtifactsChangedUnsubscribeMock;
        },
      },
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
  imageArtifactsListInvokeMock.mockReset();
  imageArtifactsChangedCallback.current = undefined;
  imageArtifactsChangedUnsubscribeMock.mockReset();
  listArtifactsInvokeMock.mockResolvedValue([]);
  videoArtifactsListInvokeMock.mockResolvedValue({ success: true, data: [] });
  imageArtifactsListInvokeMock.mockResolvedValue({ success: true, data: [] });
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

  it('1.820.3: the finish-scoped event refreshes for the matching conversation and ignores others', async () => {
    render(
      <ConversationArtifactProvider conversation_id='conv-1'>
        <ArtifactIds />
      </ConversationArtifactProvider>
    );
    await waitFor(() => expect(videoArtifactsListInvokeMock).toHaveBeenCalledTimes(1));

    // Another conversation's completion must not refetch here.
    act(() => {
      emitter.emit('commandEve.artifacts.refresh', { conversation_id: 'conv-2' });
    });
    expect(videoArtifactsListInvokeMock).toHaveBeenCalledTimes(1);

    // The REAL terminal event (emitted by useAcpMessage's finish case):
    // refetch, and the edit child persisted by then becomes visible.
    const editChild = {
      ...videoArtifact,
      id: 'video-1-edit-1',
      payload: { ...videoArtifact.payload, parent_artifact_id: 'video-1' },
      created_at: 2000,
      updated_at: 2000,
    };
    videoArtifactsListInvokeMock.mockResolvedValue({ success: true, data: [videoArtifact, editChild] });
    act(() => {
      emitter.emit('commandEve.artifacts.refresh', { conversation_id: 'conv-1' });
    });

    await waitFor(() => expect(videoArtifactsListInvokeMock).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(screen.getByTestId('artifact-ids').textContent).toContain('video-1-edit-1'));
  });

  it('1.820.3 same-turn trigger: imageArtifactsChanged reloads ONLY the matching conversation, exactly once per event', async () => {
    videoArtifactsListInvokeMock.mockResolvedValue({ success: true, data: [videoArtifact] });
    render(
      <ConversationArtifactProvider conversation_id='conv-1'>
        <ArtifactIds />
      </ConversationArtifactProvider>
    );
    await waitFor(() => expect(screen.getByTestId('artifact-ids').textContent).toContain('video-1'));
    expect(typeof imageArtifactsChangedCallback.current).toBe('function');
    const listCallsBefore = videoArtifactsListInvokeMock.mock.calls.length;

    imageArtifactsChangedCallback.current!({ conversation_id: 'conv-2' });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(videoArtifactsListInvokeMock.mock.calls.length).toBe(listCallsBefore);

    imageArtifactsChangedCallback.current!({ conversation_id: 'conv-1' });
    await waitFor(() => expect(videoArtifactsListInvokeMock.mock.calls.length).toBe(listCallsBefore + 1));
    expect(videoArtifactsListInvokeMock).toHaveBeenLastCalledWith({ conversationId: 'conv-1' });
  });

  it('1.820.3 same-turn trigger: unmount unsubscribes the imageArtifactsChanged listener, a later event reloads nothing', async () => {
    videoArtifactsListInvokeMock.mockResolvedValue({ success: true, data: [videoArtifact] });
    const { unmount } = render(
      <ConversationArtifactProvider conversation_id='conv-1'>
        <ArtifactIds />
      </ConversationArtifactProvider>
    );
    await waitFor(() => expect(screen.getByTestId('artifact-ids').textContent).toContain('video-1'));
    const listCallsBefore = videoArtifactsListInvokeMock.mock.calls.length;
    const unsubscribeCallsBefore = imageArtifactsChangedUnsubscribeMock.mock.calls.length;

    unmount();
    expect(imageArtifactsChangedUnsubscribeMock.mock.calls.length).toBe(unsubscribeCallsBefore + 1);
    expect(imageArtifactsChangedCallback.current).toBeUndefined();

    // Production semantics: a post-unmount event reaches no listener, so no
    // reload (and no IPC) can happen.
    imageArtifactsChangedCallback.current?.({ conversation_id: 'conv-1' });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(videoArtifactsListInvokeMock.mock.calls.length).toBe(listCallsBefore);
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

  describe('1.820.3 media edit source truth (Founder blocker 7)', () => {
    const baseVideo = (overrides: Record<string, unknown> = {}) => ({
      id: 'v-1',
      conversation_id: 'conv-1',
      kind: 'video' as const,
      status: 'active' as const,
      created_at: 1000,
      updated_at: 1000,
      payload: {
        artifact_type: 'video' as const,
        title: 'Video 720p',
        description: '720p · 5s · ca. 700 Credits · grok-imagine-video',
        path: '/tmp/v-1.mp4',
        mime_type: 'video/mp4',
        hash: 'a'.repeat(64),
        size: 598145,
        duration_seconds: 5,
        origin_capability: 'video_generation',
        tier_id: 'fast',
        ...overrides,
      },
    });

    it('an eligible 720p/5s clip WITH a local path IS a source', () => {
      expect(selectLatestVisibleMediaSourceArtifact([baseVideo()], 'video')?.id).toBe('v-1');
    });

    it('an HD/1080p clip is visible in chat but NOT an edit source (edit is capped at 720p)', () => {
      const hd = baseVideo({
        title: 'Video 1080p',
        description: '1080p · 5s · ca. 1250 Credits · grok-imagine-video-1.5',
        tier_id: 'hd',
      });
      expect(selectLatestVisibleMediaSourceArtifact([hd], 'video')).toBeNull();
    });

    it('an over-ceiling clip (> 8.7s) is NOT an edit source', () => {
      const long = baseVideo({
        duration_seconds: 12,
        description: '720p · 12s · ca. 1500 Credits · grok-imagine-video',
      });
      expect(selectLatestVisibleMediaSourceArtifact([long], 'video')).toBeNull();
    });

    it('a clip without a usable local path is NOT an edit source', () => {
      const noPath = baseVideo({ path: '' });
      expect(selectLatestVisibleMediaSourceArtifact([noPath], 'video')).toBeNull();
    });

    it('dismissed and pending clips are NOT sources', () => {
      expect(
        selectLatestVisibleMediaSourceArtifact([{ ...baseVideo(), status: 'dismissed' as const }], 'video')
      ).toBeNull();
      expect(
        selectLatestVisibleMediaSourceArtifact([{ ...baseVideo(), status: 'pending' as const }], 'video')
      ).toBeNull();
    });

    it('per-medium binding: a newer video never shadows the matching image source, and vice versa', () => {
      const image = {
        id: 'img-1',
        conversation_id: 'conv-1',
        kind: 'image' as const,
        status: 'active' as const,
        created_at: 900,
        updated_at: 900,
        payload: { artifact_type: 'image' as const, title: 'Bild', path: '/tmp/img-1.jpg', mime_type: 'image/jpeg' },
      };
      const newerVideo = { ...baseVideo(), created_at: 2000, updated_at: 2000 };
      expect(selectLatestVisibleMediaSourceArtifact([image, newerVideo], 'image')?.id).toBe('img-1');
      expect(selectLatestVisibleMediaSourceArtifact([image, newerVideo], 'video')?.id).toBe('v-1');
    });
  });
});

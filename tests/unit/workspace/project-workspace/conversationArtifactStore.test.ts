import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ProjectWorkspaceConversationArtifactStore } from '@/process/services/project-workspace/storage/conversationArtifactStore';

const roots: string[] = [];
const payload = {
  artifact_id: 'artifact-alpha',
  state: 'preview' as const,
  intent_summary: 'Create a project for this conversation',
  target_label: 'Business · Managed',
  project_title: 'Launch',
  delta_summary: ['Project index', '.command-eve/project.json'],
  safe_follow_ups: [],
};

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

function setup() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'eve-project-artifact-'));
  roots.push(root);
  const changed = vi.fn();
  const store = new ProjectWorkspaceConversationArtifactStore({ state_root: root, now: () => 42, on_changed: changed });
  return { store, changed };
}

describe('ProjectWorkspaceConversationArtifactStore', () => {
  it('persists before emitting and lists only the requested seat and conversation', () => {
    const { store, changed } = setup();
    store.create({
      seat_id: 'seat-alpha',
      conversation_id: 'conversation-alpha',
      artifact_id: payload.artifact_id,
      payload,
    });
    expect(changed).toHaveBeenCalledOnce();
    expect(store.list('seat-alpha', 'conversation-alpha')).toHaveLength(1);
    expect(store.list('seat-beta', 'conversation-alpha')).toEqual([]);
  });

  it('keeps timestamps monotone when multiple states share one clock tick', () => {
    const { store } = setup();
    const created = store.create({
      seat_id: 'seat-alpha',
      conversation_id: 'conversation-alpha',
      artifact_id: payload.artifact_id,
      payload,
    });
    const committed = store.transition({
      seat_id: 'seat-alpha',
      conversation_id: 'conversation-alpha',
      artifact_id: payload.artifact_id,
      expected_state: 'preview',
      payload: {
        ...payload,
        state: 'completed',
        receipt: { receipt_id: 'receipt-alpha', outcome: 'completed', completed_at: 42 },
      },
    });
    expect(committed.updated_at).toBeGreaterThan(created.updated_at);
  });

  it('rejects path-valued payloads before persistence or emission', () => {
    const { store, changed } = setup();
    expect(() =>
      store.create({
        seat_id: 'seat-alpha',
        conversation_id: 'conversation-alpha',
        artifact_id: payload.artifact_id,
        payload: { ...payload, target_label: '/Users/person/Private' },
      })
    ).toThrow();
    expect(changed).not.toHaveBeenCalled();
  });

  it('does not permit a terminal lifecycle downgrade', () => {
    const { store } = setup();
    store.create({
      seat_id: 'seat-alpha',
      conversation_id: 'conversation-alpha',
      artifact_id: payload.artifact_id,
      payload,
    });
    store.transition({
      seat_id: 'seat-alpha',
      conversation_id: 'conversation-alpha',
      artifact_id: payload.artifact_id,
      expected_state: 'preview',
      payload: { ...payload, state: 'completed' },
    });
    expect(() =>
      store.transition({
        seat_id: 'seat-alpha',
        conversation_id: 'conversation-alpha',
        artifact_id: payload.artifact_id,
        expected_state: 'completed',
        payload,
      })
    ).toThrow();
  });
});

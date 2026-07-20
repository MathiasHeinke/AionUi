import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import SiderProjectsEntry from '@/renderer/components/layout/Sider/SiderNav/SiderProjectsEntry';
import ProjectWorkspaceCard from '@/renderer/pages/conversation/Messages/components/ProjectWorkspaceCard';
import {
  ProjectWorkspaceClientProvider,
  useProjectWorkspaceConversationArtifacts,
  type RawProjectWorkspaceClient,
} from '@/renderer/pages/projects/client';
import ProjectsPage from '@/renderer/pages/projects';
import type { ProjectWorkspaceConversationArtifactDTO } from '@/renderer/pages/projects/types';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, options?: Record<string, unknown>) =>
      typeof options?.receipt === 'string' ? `${key}:${options.receipt}` : key,
    i18n: { language: 'en-US' },
  }),
}));

const listResponse = {
  seat_label: 'Founder',
  seat_context_revision: 4,
  automatic_creation_enabled: false,
  placements: [
    {
      placement_id: 'placement-1',
      realm_kind: 'business',
      realm_label: 'Business',
      root_label: 'Operations',
      writable: true,
    },
  ],
  projects: [
    {
      project_id: 'project-1',
      title: 'Market launch',
      realm_kind: 'business',
      realm_label: 'Business',
      root_label: 'Operations',
      status: 'active',
      last_safe_update: 42,
      conversation_count: 2,
      recovery_state: 'none',
      revision: 3,
      allowed_actions: ['edit', 'archive', 'reveal'],
    },
  ],
};

const receiptResponse = {
  receipt_id: 'receipt-1',
  outcome: 'completed',
  completed_at: 100,
  safe_follow_ups: [],
};

const artifact = (updatedAt: number, state: 'preview' | 'completed'): ProjectWorkspaceConversationArtifactDTO => ({
  id: 'artifact-1',
  conversation_id: 'conversation-1',
  kind: 'project_workspace',
  status: 'active',
  created_at: 10,
  updated_at: updatedAt,
  payload: {
    artifact_id: 'artifact-1',
    state,
    intent_summary: 'Create a launch project',
    target_label: 'Business · Operations',
    project_title: 'Market launch',
    delta_summary: ['Create the project index'],
    safe_follow_ups: state === 'completed' ? ['reveal'] : [],
  },
});

const rawClient = (overrides: Partial<RawProjectWorkspaceClient> = {}): RawProjectWorkspaceClient => ({
  list: async () => listResponse,
  listConversationArtifacts: async () => [],
  subscribeConversationArtifacts: () => () => {},
  previewCreate: async () => ({
    preview_id: 'preview-1',
    preview_revision: 1,
    destination_label: 'Business · Operations',
    project_title: 'Market launch',
    scaffold_summary: ['Project index'],
    semantic_writes: ['Company Brain entry'],
    conversation_effect: 'No write before confirmation',
    warnings: [],
    expires_at: 100,
  }),
  create: async () => receiptResponse,
  previewAdopt: async () => null,
  adopt: async () => receiptResponse,
  updateMetadata: async () => receiptResponse,
  archive: async () => receiptResponse,
  restore: async () => receiptResponse,
  reveal: async () => undefined,
  recover: async () => receiptResponse,
  undo: async () => receiptResponse,
  bindConversation: async () => receiptResponse,
  unbindConversation: async () => receiptResponse,
  ...overrides,
});

afterEach(() => {
  document.body.innerHTML = '';
  vi.clearAllMocks();
});

describe('Projects page and navigation', () => {
  it('renders the accessible responsive project surface and manual lifecycle entry points', async () => {
    render(
      <ProjectWorkspaceClientProvider client={rawClient()}>
        <ProjectsPage />
      </ProjectWorkspaceClientProvider>
    );
    expect(screen.getByRole('main').getAttribute('aria-labelledby')).toBe('projects-page-title');
    await screen.findByText('Market launch');
    expect(screen.getByRole('button', { name: 'common.projects.create.action' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'common.projects.adopt.action' })).toBeTruthy();
    expect(screen.getByRole('status')).toHaveTextContent('common.projects.automaticDisabled');
    expect(screen.getByLabelText('common.projects.filter.label')).toBeTruthy();
  });

  it('exposes one keyboard-focusable Projects navigation entry with current-page state', () => {
    const onClick = vi.fn();
    render(<SiderProjectsEntry isMobile={false} isActive collapsed={false} siderTooltipProps={{}} onClick={onClick} />);
    const entry = screen.getByTestId('sider-projects-entry');
    expect(entry.getAttribute('aria-current')).toBe('page');
    entry.focus();
    fireEvent.keyDown(entry, { key: 'Enter' });
    fireEvent.click(entry);
    expect(onClick).toHaveBeenCalled();
  });

  it('traps the create dialog and restores focus to its opener after cancellation', async () => {
    const user = userEvent.setup();
    render(
      <ProjectWorkspaceClientProvider client={rawClient()}>
        <ProjectsPage />
      </ProjectWorkspaceClientProvider>
    );
    const opener = await screen.findByRole('button', { name: 'common.projects.create.action' });
    opener.focus();
    await user.click(opener);
    expect(await screen.findByRole('dialog')).toBeTruthy();
    await user.click(screen.getByRole('button', { name: 'common.cancel' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(document.activeElement).toBe(opener);
  });
});

describe('Project workspace chat card', () => {
  it('renders the lifecycle state, safe delta, receipt, and bounded follow-ups', () => {
    render(
      <ProjectWorkspaceCard
        payload={{
          ...artifact(20, 'completed').payload,
          receipt: { receipt_id: 'receipt-1', outcome: 'completed', completed_at: 20 },
        }}
      />
    );
    expect(screen.getByTestId('project-workspace-card')).toHaveTextContent('Market launch');
    expect(screen.getByTestId('project-workspace-card')).toHaveTextContent('Create the project index');
    expect(screen.getByText('common.projects.artifact.receipt:receipt-1')).toBeTruthy();
    expect(screen.getByLabelText('common.projects.artifact.followUps')).toBeTruthy();
  });

  it('announces and hides an artifact with a path-valued safe-looking field', () => {
    render(
      <ProjectWorkspaceCard payload={{ ...artifact(20, 'completed').payload, target_label: '/Users/person/Work' }} />
    );
    expect(screen.getByRole('alert')).toHaveTextContent('common.projects.artifact.invalidTitle');
    expect(screen.queryByText('/Users/person/Work')).toBeNull();
  });
});

describe('Project workspace leaf subscription', () => {
  it('subscribes before list and keeps an early live completion over the delayed stale list', async () => {
    const calls: string[] = [];
    let resolveList: ((value: unknown) => void) | undefined;
    let listener: ((candidate: ProjectWorkspaceConversationArtifactDTO) => void) | undefined;
    const listPromise = new Promise<unknown>((resolve) => {
      resolveList = resolve;
    });
    const client = rawClient({
      listConversationArtifacts: async () => {
        calls.push('list');
        return listPromise;
      },
      subscribeConversationArtifacts: (_request, next) => {
        calls.push('subscribe');
        listener = next;
        return () => calls.push('unsubscribe');
      },
    });

    const Probe = () => {
      const items = useProjectWorkspaceConversationArtifacts('conversation-1');
      return <output>{items[0]?.payload.state ?? 'empty'}</output>;
    };

    render(
      <ProjectWorkspaceClientProvider client={client}>
        <Probe />
      </ProjectWorkspaceClientProvider>
    );
    expect(calls.slice(0, 2)).toEqual(['subscribe', 'list']);
    await act(async () => listener?.(artifact(20, 'completed')));
    await screen.findByText('completed');
    await act(async () => resolveList?.([artifact(10, 'preview')]));
    await waitFor(() => expect(screen.getByText('completed')).toBeTruthy());
  });
});

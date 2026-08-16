import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import SiderProjectsEntry from '@/renderer/components/layout/Sider/SiderNav/SiderProjectsEntry';
import ProjectWorkspaceCard from '@/renderer/pages/conversation/Messages/components/ProjectWorkspaceCard';
import {
  ProjectWorkspaceClientError,
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

vi.mock('@/renderer/hooks/context/ThemeContext', () => ({
  useThemeContext: () => ({ fontScale: 1 }),
}));

const listResponse = {
  seat_label: 'Founder',
  seat_context_revision: 4,
  catalog_revision: 3,
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
    project_id: 'project-1',
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
  previewAssignment: async () => ({
    ok: true,
    preview: {
      preview_id: 'assignment-preview-1',
      preview_revision: 1,
      conversation_id: 'conversation-1',
      artifact_id: 'artifact-1',
      artifact_updated_at: 20,
      catalog_revision: 3,
      binding_revision: 1,
      choice: { kind: 'keep' },
      current_project: listResponse.projects[0],
      target_project: listResponse.projects[0],
      will_change: false,
      expires_at: 1_000,
    },
  }),
  commitAssignment: async () => ({
    receipt_id: 'assignment-receipt-1',
    outcome: 'completed',
    completed_at: 30,
    assignment: 'keep',
    project: listResponse.projects[0],
    artifact: {
      ...artifact(30, 'completed'),
      payload: {
        ...artifact(30, 'completed').payload,
        assignment_finalized_at: 30,
        receipt: { receipt_id: 'assignment-receipt-1', outcome: 'completed', completed_at: 30 },
      },
    },
    safe_follow_ups: ['reveal', 'edit'],
  }),
  ...overrides,
});

afterEach(() => {
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
  it('renders a compact localized assignment card and keeps technical receipt data collapsed', async () => {
    render(
      <ProjectWorkspaceClientProvider client={rawClient()}>
        <ProjectWorkspaceCard
          artifact={{
            ...artifact(20, 'completed'),
            payload: {
              ...artifact(20, 'completed').payload,
              receipt: { receipt_id: 'receipt-1', outcome: 'completed', completed_at: 20 },
            },
          }}
        />
      </ProjectWorkspaceClientProvider>
    );
    expect(screen.getByTestId('project-workspace-card')).toHaveTextContent('Market launch');
    expect(screen.getByTestId('project-workspace-card')).toHaveTextContent('common.projects.artifact.autoAssigned');
    const disclosure = screen.getByRole('button', { name: 'common.projects.artifact.technicalDetails' });
    expect(disclosure).toHaveAttribute('aria-expanded', 'false');
    await userEvent.click(disclosure);
    expect(disclosure).toHaveAttribute('aria-expanded', 'true');
    expect(screen.getByText('Create the project index')).toBeTruthy();
    expect(screen.getByText('common.projects.artifact.receipt:receipt-1')).toBeTruthy();
  });

  it('announces and hides an artifact with a path-valued safe-looking field', () => {
    render(
      <ProjectWorkspaceCard
        artifact={{
          ...artifact(20, 'completed'),
          payload: { ...artifact(20, 'completed').payload, target_label: '/Users/person/Work' },
        }}
      />
    );
    expect(screen.getByRole('alert')).toHaveTextContent('common.projects.artifact.invalidTitle');
    expect(screen.queryByText('/Users/person/Work')).toBeNull();
  });

  it('previews and commits one durable keep decision, then renders the finalized state', async () => {
    const user = userEvent.setup();
    const defaults = rawClient();
    const previewAssignment = vi.fn(defaults.previewAssignment);
    const commitAssignment = vi.fn(defaults.commitAssignment);
    render(
      <ProjectWorkspaceClientProvider client={rawClient({ previewAssignment, commitAssignment })}>
        <ProjectWorkspaceCard artifact={artifact(20, 'completed')} />
      </ProjectWorkspaceClientProvider>
    );

    const opener = screen.getByRole('button', { name: 'common.projects.artifact.review' });
    await user.click(opener);
    expect(await screen.findByRole('dialog', { name: 'common.projects.assignment.title' })).toBeTruthy();
    expect(screen.getByRole('radio', { name: /common.projects.assignment.keep.title/ })).toHaveAttribute(
      'aria-checked',
      'true'
    );
    await user.click(screen.getByRole('button', { name: 'common.projects.assignment.preview' }));
    await waitFor(() => expect(previewAssignment).toHaveBeenCalledTimes(1));
    expect(previewAssignment.mock.calls[0][0]).toMatchObject({
      conversation_id: 'conversation-1',
      artifact_id: 'artifact-1',
      expected_artifact_updated_at: 20,
      expected_catalog_revision: 3,
      choice: { kind: 'keep' },
    });

    await user.click(screen.getByRole('button', { name: 'common.projects.assignment.commit' }));
    await waitFor(() => expect(commitAssignment).toHaveBeenCalledTimes(1));
    await waitFor(() =>
      expect(screen.getByTestId('project-workspace-card')).toHaveTextContent('common.projects.artifact.finalized')
    );
    expect(screen.getByTestId('project-workspace-card')).toHaveTextContent(
      'common.projects.artifact.assignmentFinalized'
    );
    expect(screen.getByTestId('project-workspace-card')).toHaveTextContent('common.projects.artifact.changeAssignment');
    expect(screen.getAllByText('Market launch')).toHaveLength(1);
    expect(screen.queryByRole('dialog')).toBeNull();
    await waitFor(() => expect(document.activeElement).toBe(opener));
  });

  it('supports complete roving keyboard selection and rebases filtered project options', async () => {
    const user = userEvent.setup();
    const projects = [
      listResponse.projects[0],
      { ...listResponse.projects[0], project_id: 'project-2', title: 'Website relaunch' },
      { ...listResponse.projects[0], project_id: 'project-3', title: 'Product launch' },
    ];
    render(
      <ProjectWorkspaceClientProvider client={rawClient({ list: async () => ({ ...listResponse, projects }) })}>
        <ProjectWorkspaceCard artifact={artifact(20, 'completed')} />
      </ProjectWorkspaceClientProvider>
    );

    await user.click(screen.getByRole('button', { name: 'common.projects.artifact.review' }));
    const keep = await screen.findByRole('radio', { name: /common.projects.assignment.keep.title/ });
    keep.focus();
    const chooseProject = screen.getByRole('radio', { name: /common.projects.assignment.project.title/ });
    const temporary = screen.getByRole('radio', { name: /common.projects.assignment.temporary.title/ });
    const oneTabStop = (items: HTMLElement[]) => items.filter((item) => item.tabIndex === 0);

    await user.keyboard('{ArrowRight}');
    expect(chooseProject).toHaveAttribute('aria-checked', 'true');
    expect(document.activeElement).toBe(chooseProject);
    await user.keyboard('{ArrowLeft}');
    expect(document.activeElement).toBe(keep);
    await user.keyboard('{End}');
    expect(document.activeElement).toBe(temporary);
    await user.keyboard('{Home}');
    expect(document.activeElement).toBe(keep);
    await user.keyboard('{ArrowUp}');
    expect(document.activeElement).toBe(temporary);
    await user.keyboard('{ArrowDown}');
    expect(document.activeElement).toBe(keep);
    expect(oneTabStop([keep, chooseProject, temporary])).toEqual([keep]);
    await user.keyboard('{ArrowRight}');

    const visibleOptions = () => screen.getAllByRole('option');
    const initialOptions = await screen.findAllByRole('option');
    expect(oneTabStop(initialOptions)).toEqual([initialOptions[0]]);
    initialOptions[0].focus();
    await user.keyboard('{ArrowRight}');
    expect(visibleOptions()[1]).toHaveAttribute('aria-selected', 'true');
    expect(document.activeElement).toBe(visibleOptions()[1]);
    await user.keyboard('{ArrowLeft}');
    expect(document.activeElement).toBe(visibleOptions()[0]);
    await user.keyboard('{End}');
    expect(document.activeElement).toBe(visibleOptions()[1]);
    await user.keyboard('{Home}');
    expect(visibleOptions()[0]).toHaveAttribute('aria-selected', 'true');
    expect(document.activeElement).toBe(visibleOptions()[0]);
    await user.keyboard('{ArrowUp}');
    expect(document.activeElement).toBe(visibleOptions()[1]);
    await user.keyboard('{ArrowDown}');
    expect(document.activeElement).toBe(visibleOptions()[0]);

    await user.click(visibleOptions()[1]);
    await user.type(screen.getByRole('textbox', { name: 'common.projects.assignment.search' }), 'Website');
    const filteredOptions = await screen.findAllByRole('option');
    expect(filteredOptions).toHaveLength(1);
    expect(filteredOptions[0]).toHaveAttribute('tabindex', '0');
    expect(filteredOptions[0]).toHaveAttribute('aria-selected', 'false');
    expect(screen.getByRole('button', { name: 'common.projects.assignment.preview' })).toBeDisabled();
  });

  it('restores focus to the review action after cancelling the assignment dialog', async () => {
    const user = userEvent.setup();
    render(
      <ProjectWorkspaceClientProvider client={rawClient()}>
        <ProjectWorkspaceCard artifact={artifact(20, 'completed')} />
      </ProjectWorkspaceClientProvider>
    );
    const opener = screen.getByRole('button', { name: 'common.projects.artifact.review' });
    await user.click(opener);
    await user.click(await screen.findByRole('button', { name: 'common.projects.assignment.later' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    await waitFor(() => expect(document.activeElement).toBe(opener));
  });

  it('renders a temporary assignment label exactly once', () => {
    render(
      <ProjectWorkspaceClientProvider client={rawClient()}>
        <ProjectWorkspaceCard
          artifact={{
            ...artifact(30, 'completed'),
            payload: {
              ...artifact(30, 'completed').payload,
              project_id: undefined,
              project_title: 'Temp',
              target_label: 'Temporary Space',
              assignment_finalized_at: 30,
            },
          }}
        />
      </ProjectWorkspaceClientProvider>
    );
    expect(screen.getAllByText('common.projects.assignment.temporaryTarget')).toHaveLength(1);
    expect(screen.queryByText('Temp')).toBeNull();
  });

  it('surfaces a catalog notice, blocks preview, and offers a real reload action', async () => {
    const user = userEvent.setup();
    const list = vi
      .fn()
      .mockResolvedValueOnce({ ...listResponse, projects: [], notice_reason: 'service_unavailable' })
      .mockResolvedValueOnce(listResponse);
    render(
      <ProjectWorkspaceClientProvider client={rawClient({ list })}>
        <ProjectWorkspaceCard artifact={artifact(20, 'completed')} />
      </ProjectWorkspaceClientProvider>
    );

    await user.click(screen.getByRole('button', { name: 'common.projects.artifact.review' }));
    expect(await screen.findByRole('alert')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'common.projects.assignment.preview' })).toBeDisabled();
    await user.click(screen.getByRole('button', { name: 'common.retry' }));
    await waitFor(() => expect(list).toHaveBeenCalledTimes(2));
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'common.projects.assignment.preview' })).toBeEnabled()
    );
  });

  it('recovers from a thrown catalog failure through the same reload action', async () => {
    const user = userEvent.setup();
    const list = vi
      .fn()
      .mockRejectedValueOnce(new ProjectWorkspaceClientError('service_unavailable'))
      .mockResolvedValueOnce(listResponse);
    render(
      <ProjectWorkspaceClientProvider client={rawClient({ list })}>
        <ProjectWorkspaceCard artifact={artifact(20, 'completed')} />
      </ProjectWorkspaceClientProvider>
    );

    await user.click(screen.getByRole('button', { name: 'common.projects.artifact.review' }));
    expect(await screen.findByRole('alert')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'common.projects.assignment.preview' })).toBeDisabled();
    await user.click(screen.getByRole('button', { name: 'common.retry' }));
    await waitFor(() => expect(list).toHaveBeenCalledTimes(2));
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'common.projects.assignment.preview' })).toBeEnabled()
    );
  });

  it('replaces a rejected commit with fresh recovery instead of a stale preview action', async () => {
    const user = userEvent.setup();
    const list = vi.fn(async () => listResponse);
    const listConversationArtifacts = vi.fn(async () => [artifact(21, 'completed')]);
    const commitAssignment = vi.fn(async () => ({
      receipt_id: 'assignment-receipt-rejected',
      outcome: 'rejected' as const,
      completed_at: 31,
      assignment: 'keep' as const,
      reason_code: 'stale_snapshot' as const,
      safe_follow_ups: [],
    }));
    render(
      <ProjectWorkspaceClientProvider client={rawClient({ list, listConversationArtifacts, commitAssignment })}>
        <ProjectWorkspaceCard artifact={artifact(20, 'completed')} />
      </ProjectWorkspaceClientProvider>
    );

    await user.click(screen.getByRole('button', { name: 'common.projects.artifact.review' }));
    await user.click(await screen.findByRole('button', { name: 'common.projects.assignment.preview' }));
    await user.click(await screen.findByRole('button', { name: 'common.projects.assignment.commit' }));
    await waitFor(() => expect(commitAssignment).toHaveBeenCalledTimes(1));
    expect(screen.queryByRole('button', { name: 'common.projects.assignment.preview' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'common.projects.assignment.commit' })).toBeNull();
    expect(await screen.findByRole('alert')).toBeTruthy();
    expect(screen.getByRole('status')).toHaveTextContent('common.projects.assignment.recovery.title');
    expect(list).toHaveBeenCalledTimes(1);

    await user.click(screen.getByRole('button', { name: 'common.projects.assignment.reloadCurrent' }));
    await waitFor(() => expect(listConversationArtifacts).toHaveBeenCalledTimes(1));
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'common.projects.assignment.preview' })).toBeEnabled()
    );
    expect(list.mock.calls.length).toBeGreaterThanOrEqual(2);
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

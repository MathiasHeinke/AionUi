/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * v1.4 T8 — Settings → Company Brain is a BLUEPRINT OUTLINE, not a flat list.
 *
 * Drives the rewritten CompanyBrainModalContent against a mocked commandEve bridge +
 * a notify-capable configService mini-store. Asserts:
 *  - the fixed blueprint outline renders all 10 sections in order, with a
 *    leer/ausgefüllt fill indicator per section;
 *  - blueprint sections are NEVER deletable (no Löschen; a "Leeren" reset instead);
 *  - the "Notizen & Gelerntes" section lists the FREE entries below the outline,
 *    with the classic add / edit / delete flow, and session_digest is hidden;
 *  - opening a section/note lazily reads its body; saving persists with the id;
 *  - a failed IPC → Message.error (never a silent bounce).
 * The Day-Zero seed modal is stubbed inert (its own suites cover it).
 */

import React from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

// ── Arco: capture Message.error / .success; keep everything else real. ──────────
const { messageErrorMock, messageSuccessMock } = vi.hoisted(() => ({
  messageErrorMock: vi.fn(),
  messageSuccessMock: vi.fn(),
}));
vi.mock('@arco-design/web-react', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@arco-design/web-react')>();
  return {
    ...actual,
    Message: { ...actual.Message, error: messageErrorMock, success: messageSuccessMock },
  };
});

// ── i18n: render the German defaultValue so assertions are deterministic. ───────
vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (_key: string, opts?: { defaultValue?: string; code?: string; filled?: number; total?: number }) => {
      let dv = opts?.defaultValue ?? _key;
      if (opts?.code) dv = dv.replace('{{code}}', opts.code);
      if (opts?.filled !== undefined) dv = dv.replace('{{filled}}', String(opts.filled));
      if (opts?.total !== undefined) dv = dv.replace('{{total}}', String(opts.total));
      return dv;
    },
    i18n: { language: 'de' },
  }),
}));

// ── configService: notify-capable mini-store + stable seat. ─────────────────────
const { configGetMock, configSetMock, configSubscribeMock } = vi.hoisted(() => {
  const store = new Map<string, unknown>();
  const subscribers = new Map<string, Set<() => void>>();
  return {
    configGetMock: vi.fn((key: string) => store.get(key)),
    configSetMock: vi.fn((key: string, value: unknown) => {
      store.set(key, value);
      for (const cb of subscribers.get(key) ?? []) cb();
      return Promise.resolve();
    }),
    configSubscribeMock: vi.fn((key: string, cb: () => void) => {
      if (!subscribers.has(key)) subscribers.set(key, new Set());
      subscribers.get(key)!.add(cb);
      return () => subscribers.get(key)?.delete(cb);
    }),
  };
});
vi.mock('@/common/config/configService', () => ({
  configService: {
    get: configGetMock,
    set: configSetMock,
    subscribe: configSubscribeMock,
    whenReady: vi.fn(() => Promise.resolve()),
    getCurrentSeatId: vi.fn(() => 'seat-1'),
    onSeatRebind: vi.fn(() => () => {}),
  },
}));

// ── commandEve bridge: an in-memory brain the handlers mutate. ──────────────────
type Entry = {
  id: string;
  kind: string;
  title: string;
  updated_at: string;
  author: 'user' | 'eve';
  source: string;
  body_file: string;
};
const brain: { entries: Entry[]; bodies: Record<string, string> } = { entries: [], bodies: {} };
const listMock = vi.fn(async () => ({ success: true, data: { ok: true, entries: brain.entries } }));
const readMock = vi.fn(async ({ id }: { id: string }) => ({
  success: true,
  data: { ok: true, body: brain.bodies[id] ?? null },
}));
const writeMock = vi.fn(async (req: { id?: string; kind: string; title: string; body: string }) => {
  const id = req.id ?? `${req.kind}-${req.title.toLowerCase().replace(/\s+/g, '-')}-x`;
  const existing = brain.entries.find((e) => e.id === id);
  const entry: Entry = {
    id,
    kind: req.kind,
    title: req.title,
    updated_at: new Date().toISOString(),
    author: 'user',
    source: 'settings',
    body_file: `entries/${id}.md`,
  };
  if (existing) Object.assign(existing, entry);
  else brain.entries.push(entry);
  brain.bodies[id] = req.body;
  return { success: true, data: { ok: true, entry, created: !existing } };
});
const removeMock = vi.fn(async ({ id }: { id: string }) => {
  const before = brain.entries.length;
  brain.entries = brain.entries.filter((e) => e.id !== id);
  delete brain.bodies[id];
  return { success: true, data: { ok: true, removed: brain.entries.length !== before } };
});
vi.mock('@/common/adapter/ipcBridge', () => ({
  commandEve: {
    companyBrainStatus: {
      invoke: vi.fn(async () => ({ success: true, data: { seeded: brain.entries.length > 0, record: null } })),
    },
    companyBrainSeed: { invoke: vi.fn(async () => ({ success: true, data: { ok: true } })) },
    companyBrainList: { invoke: (...a: unknown[]) => listMock(...(a as [])) },
    companyBrainRead: { invoke: (req: { id: string }) => readMock(req) },
    companyBrainWrite: { invoke: (req: { id?: string; kind: string; title: string; body: string }) => writeMock(req) },
    companyBrainRemove: { invoke: (req: { id: string }) => removeMock(req) },
  },
}));

// Keep the Day-0 modal inert (its own suites cover the seed path).
vi.mock('@renderer/components/billing/DayZeroOnboardingModal', () => ({ default: () => null }));

import CompanyBrainModalContent from '@renderer/components/settings/SettingsModal/contents/CompanyBrainModalContent';

const seed = (entries: Array<Partial<Entry> & { id: string; title: string }>, bodies: Record<string, string> = {}) => {
  brain.entries = entries.map((e) => ({
    kind: e.kind ?? 'note',
    updated_at: e.updated_at ?? new Date().toISOString(),
    author: e.author ?? 'user',
    source: e.source ?? 'settings',
    body_file: `entries/${e.id}.md`,
    ...e,
  })) as Entry[];
  brain.bodies = bodies;
};

const BLUEPRINT_IDS = [
  'bp-company',
  'bp-team',
  'bp-offer',
  'bp-audience',
  'bp-projects',
  'bp-goals',
  'bp-focus',
  'bp-tone',
  'bp-dos-donts',
  'brief-day-0',
];

beforeEach(() => {
  cleanup();
  vi.clearAllMocks();
  brain.entries = [];
  brain.bodies = {};
});

describe('CompanyBrainModalContent — T8 blueprint outline', () => {
  it('renders the fixed 10-section blueprint outline in order, each with a leer/ausgefüllt indicator', async () => {
    render(<CompanyBrainModalContent />);
    await screen.findByTestId('company-brain-outline');
    const sections = screen.getAllByTestId('company-brain-section');
    expect(sections).toHaveLength(10);
    // Order + stable ids preserved.
    expect(sections.map((s) => s.getAttribute('data-section-id'))).toEqual(BLUEPRINT_IDS);
    // Section titles render.
    expect(screen.getByText('Unternehmen')).toBeInTheDocument();
    expect(screen.getByText('Team')).toBeInTheDocument();
    expect(screen.getByText('Briefing')).toBeInTheDocument();
    // Untouched seat: every section reads "leer".
    for (const s of sections) expect(s.getAttribute('data-filled')).toBe('false');
    // N/M summary reflects 0 filled.
    expect(screen.getByTestId('company-brain-blueprint-count')).toHaveTextContent(
      'Blaupause: 0/10 Sektionen ausgefüllt'
    );
  });

  it('opening a section reads its body; a filled body flips the indicator to ausgefüllt on save', async () => {
    // Seed the section as still-empty (bare placeholder line) so the indicator starts "leer".
    seed([{ id: 'bp-company', kind: 'company', title: 'Unternehmen', author: 'user' }], { 'bp-company': '- Name: …' });
    const user = userEvent.setup();
    render(<CompanyBrainModalContent />);
    const section = (await screen.findAllByTestId('company-brain-section')).find(
      (s) => s.getAttribute('data-section-id') === 'bp-company'
    )!;
    expect(section.getAttribute('data-filled')).toBe('false');
    await user.click(within(section).getByTestId('company-brain-section-open'));

    // Body fetched lazily.
    await waitFor(() => expect(readMock).toHaveBeenCalledWith({ id: 'bp-company' }));
    const editor = await screen.findByTestId('company-brain-section-editor');
    // Arco Input.TextArea does not forward data-testid to the inner field; grab the
    // textarea by its current display value (the fetched body, single line).
    const bodyInput = within(editor).getByDisplayValue('- Name: …');
    await user.clear(bodyInput);
    await user.type(bodyInput, '- Name: Bäckerei Müller GmbH');
    await user.click(within(editor).getByTestId('company-brain-section-save'));

    // Saved with the FIXED section id + kind (edit-in-place, blueprint-locked).
    await waitFor(() => expect(writeMock).toHaveBeenCalled());
    expect(writeMock.mock.calls[0][0]).toMatchObject({ id: 'bp-company', kind: 'company', title: 'Unternehmen' });
    // The indicator now reads "ausgefüllt".
    await waitFor(() => {
      const s = screen
        .getAllByTestId('company-brain-section')
        .find((x) => x.getAttribute('data-section-id') === 'bp-company')!;
      expect(s.getAttribute('data-filled')).toBe('true');
    });
  });

  it('blueprint sections are NOT deletable — a "Leeren" reset writes the placeholder back (no remove IPC)', async () => {
    const user = userEvent.setup();
    render(<CompanyBrainModalContent />);
    const section = (await screen.findAllByTestId('company-brain-section')).find(
      (s) => s.getAttribute('data-section-id') === 'bp-offer'
    )!;
    // No delete control on a blueprint section.
    expect(within(section).queryByTestId('company-brain-item-delete')).toBeNull();
    // A "Leeren" control exists instead.
    const clear = within(section).getByTestId('company-brain-section-clear');
    await user.click(clear);
    // Confirm the Popconfirm.
    await waitFor(() => expect(screen.getAllByText('Leeren').length).toBeGreaterThan(1));
    const leerenSpans = screen.getAllByText('Leeren');
    const okButton = leerenSpans[leerenSpans.length - 1].closest('button');
    fireEvent.click(okButton as HTMLButtonElement);

    // "Leeren" writes the placeholder back — it NEVER calls remove.
    await waitFor(() => expect(writeMock).toHaveBeenCalled());
    expect(writeMock.mock.calls[0][0]).toMatchObject({ id: 'bp-offer', kind: 'offer' });
    expect(removeMock).not.toHaveBeenCalled();
  });
});

describe('CompanyBrainModalContent — T8 Notizen & Gelerntes (free entries)', () => {
  it('lists free notes below the outline (NOT blueprint sections, NOT session_digest)', async () => {
    seed([
      { id: 'note-b', kind: 'note', title: 'EVE hat gelernt', author: 'eve' },
      { id: 'bp-company', kind: 'company', title: 'Unternehmen', author: 'user' },
      { id: 'sd-conv1', kind: 'session_digest', title: 'Session Digest', author: 'eve' },
    ]);
    render(<CompanyBrainModalContent />);
    await screen.findByTestId('company-brain-notes');
    const items = await screen.findAllByTestId('company-brain-item');
    // Only the free note shows in the notes list — bp-company is in the outline, the
    // session_digest is hidden entirely.
    expect(items).toHaveLength(1);
    expect(items[0].getAttribute('data-entry-id')).toBe('note-b');
    expect(screen.getByText('EVE hat gelernt')).toBeInTheDocument();
    expect(screen.getByText('von EVE')).toBeInTheDocument();
    expect(screen.queryByText('Session Digest')).toBeNull();
  });

  it('honest empty-state when there are no free notes (the outline still renders)', async () => {
    seed([{ id: 'bp-company', kind: 'company', title: 'Unternehmen', author: 'user' }]);
    render(<CompanyBrainModalContent />);
    const empty = await screen.findByTestId('company-brain-empty');
    expect(empty).toHaveTextContent('Noch keine Notizen');
    // The outline is still present.
    expect(screen.getByTestId('company-brain-outline')).toBeInTheDocument();
  });

  it('Add → write is called with kind:note, title and body (a fresh note, not a section)', async () => {
    const user = userEvent.setup();
    render(<CompanyBrainModalContent />);
    await screen.findByTestId('company-brain-notes');

    await user.click(screen.getByTestId('company-brain-add'));
    const editor = await screen.findByTestId('company-brain-editor-new');
    await user.type(within(editor).getByPlaceholderText('Titel'), 'Zufalls-Notiz');
    await user.type(within(editor).getByPlaceholderText('Inhalt (Markdown)'), 'etwas Gelerntes');
    await user.click(within(editor).getByTestId('company-brain-save'));

    await waitFor(() => expect(writeMock).toHaveBeenCalledTimes(1));
    const arg = writeMock.mock.calls[0][0];
    expect(arg).toMatchObject({ kind: 'note', title: 'Zufalls-Notiz', body: 'etwas Gelerntes' });
    expect(arg.id).toBeUndefined(); // create, not edit
    expect(messageSuccessMock).toHaveBeenCalled();
  });

  it('opening a note lazily reads its body; editing saves with the id (edit-in-place)', async () => {
    seed([{ id: 'note-a', kind: 'note', title: 'Merkzettel', author: 'user' }], { 'note-a': 'original body' });
    const user = userEvent.setup();
    render(<CompanyBrainModalContent />);

    const item = await screen.findByTestId('company-brain-item');
    await user.click(within(item).getByTestId('company-brain-item-open'));
    await waitFor(() => expect(readMock).toHaveBeenCalledWith({ id: 'note-a' }));
    const editEditor = await screen.findByTestId('company-brain-editor-edit');
    const bodyInput = within(editEditor).getByDisplayValue('original body');
    await user.clear(bodyInput);
    await user.type(bodyInput, 'edited body');
    await user.click(within(editEditor).getByTestId('company-brain-edit-save'));

    await waitFor(() => expect(writeMock).toHaveBeenCalledTimes(1));
    expect(writeMock.mock.calls[0][0]).toMatchObject({ id: 'note-a', title: 'Merkzettel', body: 'edited body' });
  });

  it('Delete → confirm → remove is called with the id (free notes only)', async () => {
    seed([{ id: 'note-x', kind: 'note', title: 'Wegwerf', author: 'user' }], { 'note-x': 'x' });
    const user = userEvent.setup();
    render(<CompanyBrainModalContent />);

    const item = await screen.findByTestId('company-brain-item');
    await user.click(within(item).getByTestId('company-brain-item-delete'));
    await waitFor(() => expect(screen.getAllByText('Löschen').length).toBeGreaterThan(1));
    const loeschenSpans = screen.getAllByText('Löschen');
    const okButton = loeschenSpans[loeschenSpans.length - 1].closest('button');
    fireEvent.click(okButton as HTMLButtonElement);

    await waitFor(() => expect(removeMock).toHaveBeenCalledWith({ id: 'note-x' }));
    expect(messageSuccessMock).toHaveBeenCalled();
  });

  it('a failed list IPC surfaces Message.error with the reason_code (never a silent bounce)', async () => {
    listMock.mockResolvedValueOnce({
      success: false,
      data: { ok: false, reason_code: 'COMPANY_BRAIN_LIST_FAILED', entries: [] },
    } as never);
    render(<CompanyBrainModalContent />);
    await waitFor(() => expect(messageErrorMock).toHaveBeenCalled());
    expect(messageErrorMock.mock.calls[0][0]).toContain('COMPANY_BRAIN_LIST_FAILED');
  });

  it('a blank note title is refused BEFORE any write IPC (loud Message.error)', async () => {
    const user = userEvent.setup();
    render(<CompanyBrainModalContent />);
    await screen.findByTestId('company-brain-notes');

    await user.click(screen.getByTestId('company-brain-add'));
    const editor = await screen.findByTestId('company-brain-editor-new');
    await user.click(within(editor).getByTestId('company-brain-save')); // title empty
    expect(writeMock).not.toHaveBeenCalled();
    expect(messageErrorMock).toHaveBeenCalled();
  });
});

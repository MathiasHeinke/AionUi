/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * v1.4 T3 — Settings → Company Brain is the REAL entry-management surface.
 *
 * Drives the rewritten CompanyBrainModalContent against a mocked commandEve
 * bridge + a notify-capable configService mini-store (the SystemModalContent
 * pattern). Asserts the founder-facing behaviour: the list renders entries with
 * author badges (von dir / von EVE), Add calls write with kind/title/body, opening
 * an entry lazily reads its body, editing saves with the id, Delete confirm →
 * remove, the honest empty-state, and a failed IPC → Message.error (never a silent
 * bounce). The Day-Zero seed modal is stubbed inert (its own suite covers it).
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
    t: (_key: string, opts?: { defaultValue?: string; code?: string }) => {
      const dv = opts?.defaultValue ?? _key;
      return opts?.code ? dv.replace('{{code}}', opts.code) : dv;
    },
    i18n: { language: 'de' },
  }),
}));

// ── configService: notify-capable mini-store + stable seat (SystemModalContent). ─
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
type Entry = { id: string; kind: string; title: string; updated_at: string; author: 'user' | 'eve'; source: string; body_file: string };
const brain: { entries: Entry[]; bodies: Record<string, string> } = { entries: [], bodies: {} };
const listMock = vi.fn(async () => ({ success: true, data: { ok: true, entries: brain.entries } }));
const readMock = vi.fn(async ({ id }: { id: string }) => ({ success: true, data: { ok: true, body: brain.bodies[id] ?? null } }));
const writeMock = vi.fn(async (req: { id?: string; kind: string; title: string; body: string }) => {
  const id = req.id ?? `${req.kind}-${req.title.toLowerCase().replace(/\s+/g, '-')}-x`;
  const existing = brain.entries.find((e) => e.id === id);
  const entry: Entry = { id, kind: req.kind, title: req.title, updated_at: new Date().toISOString(), author: 'user', source: 'settings', body_file: `entries/${id}.md` };
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
    companyBrainStatus: { invoke: vi.fn(async () => ({ success: true, data: { seeded: brain.entries.length > 0, record: null } })) },
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

beforeEach(() => {
  cleanup();
  vi.clearAllMocks();
  brain.entries = [];
  brain.bodies = {};
});

describe('CompanyBrainModalContent — T3 entry management', () => {
  it('renders the honest empty-state when the seat brain is empty', async () => {
    render(<CompanyBrainModalContent />);
    const empty = await screen.findByTestId('company-brain-empty');
    expect(empty).toHaveTextContent('Noch nichts im Company Brain dieses Seats');
    // Seat-scope note is visible.
    expect(screen.getByText('Gilt nur für diesen Seat.')).toBeInTheDocument();
  });

  it('renders entries with kind label + author badges (von dir / von EVE)', async () => {
    seed([
      { id: 'offer-a', kind: 'offer', title: 'Website Relaunch', author: 'user' },
      { id: 'note-b', kind: 'note', title: 'EVE hat gelernt', author: 'eve' },
    ]);
    render(<CompanyBrainModalContent />);

    const items = await screen.findAllByTestId('company-brain-item');
    expect(items).toHaveLength(2);
    expect(screen.getByText('Website Relaunch')).toBeInTheDocument();
    expect(screen.getByText('Angebot')).toBeInTheDocument(); // offer label
    expect(screen.getByText('von dir')).toBeInTheDocument();
    expect(screen.getByText('von EVE')).toBeInTheDocument();
    // The EVE-authored item is visually marked (data-author).
    const eveItem = items.find((i) => i.getAttribute('data-entry-id') === 'note-b');
    expect(eveItem?.getAttribute('data-author')).toBe('eve');
  });

  it('Add → write is called with kind, title and body', async () => {
    const user = userEvent.setup();
    render(<CompanyBrainModalContent />);
    await screen.findByTestId('company-brain-empty');

    await user.click(screen.getByTestId('company-brain-add'));
    // Arco Input/TextArea do not forward data-testid to the inner field; query the
    // real field by its (deterministic, i18n-defaultValue) placeholder.
    const editor = await screen.findByTestId('company-brain-editor-new');
    await user.type(within(editor).getByPlaceholderText('Titel'), 'Zielgruppen-Brief');
    await user.type(within(editor).getByPlaceholderText('Inhalt (Markdown)'), 'Handwerker, 30-55, regional');
    await user.click(within(editor).getByText('Speichern'));

    await waitFor(() => expect(writeMock).toHaveBeenCalledTimes(1));
    const arg = writeMock.mock.calls[0][0];
    expect(arg).toMatchObject({ kind: 'note', title: 'Zielgruppen-Brief', body: 'Handwerker, 30-55, regional' });
    expect(arg.id).toBeUndefined(); // create, not edit
    expect(messageSuccessMock).toHaveBeenCalled();
  });

  it('opening an entry lazily reads its body; editing saves with the id (edit-in-place)', async () => {
    seed([{ id: 'offer-a', kind: 'offer', title: 'Website Relaunch', author: 'user' }], { 'offer-a': 'original body' });
    const user = userEvent.setup();
    render(<CompanyBrainModalContent />);

    const item = await screen.findByTestId('company-brain-item');
    await user.click(within(item).getByTestId('company-brain-item-open'));

    // Body was fetched lazily (not in the list payload).
    await waitFor(() => expect(readMock).toHaveBeenCalledWith({ id: 'offer-a' }));
    const editEditor = await screen.findByTestId('company-brain-editor-edit');
    const bodyInput = within(editEditor).getByDisplayValue('original body');

    await user.clear(bodyInput);
    await user.type(bodyInput, 'edited body');
    await user.click(within(editEditor).getByText('Speichern'));

    await waitFor(() => expect(writeMock).toHaveBeenCalledTimes(1));
    expect(writeMock.mock.calls[0][0]).toMatchObject({ id: 'offer-a', title: 'Website Relaunch', body: 'edited body' });
  });

  it('Delete → confirm → remove is called with the id', async () => {
    seed([{ id: 'note-x', kind: 'note', title: 'Wegwerf', author: 'user' }], { 'note-x': 'x' });
    const user = userEvent.setup();
    render(<CompanyBrainModalContent />);

    const item = await screen.findByTestId('company-brain-item');
    await user.click(within(item).getByTestId('company-brain-item-delete'));

    // Arco Popconfirm renders its confirm popup on trigger click. The OK button
    // reads the same "Löschen" as the row trigger, so after the popup opens there
    // are TWO — the LAST one is the popup's confirm. Its wrapping button carries
    // Arco's pointer-events styling, so fireEvent.click (not user.click) drives it.
    await waitFor(() => expect(screen.getAllByText('Löschen').length).toBeGreaterThan(1));
    const loeschenSpans = screen.getAllByText('Löschen');
    const okButton = loeschenSpans[loeschenSpans.length - 1].closest('button');
    expect(okButton).not.toBeNull();
    fireEvent.click(okButton as HTMLButtonElement);

    await waitFor(() => expect(removeMock).toHaveBeenCalledWith({ id: 'note-x' }));
    expect(messageSuccessMock).toHaveBeenCalled();
  });

  it('a failed list IPC surfaces Message.error with the reason_code (never a silent bounce)', async () => {
    listMock.mockResolvedValueOnce({ success: false, data: { ok: false, reason_code: 'COMPANY_BRAIN_LIST_FAILED', entries: [] } } as never);
    render(<CompanyBrainModalContent />);
    await waitFor(() => expect(messageErrorMock).toHaveBeenCalled());
    expect(messageErrorMock.mock.calls[0][0]).toContain('COMPANY_BRAIN_LIST_FAILED');
  });

  it('a blank title is refused BEFORE any write IPC (loud Message.error)', async () => {
    const user = userEvent.setup();
    render(<CompanyBrainModalContent />);
    await screen.findByTestId('company-brain-empty');

    await user.click(screen.getByTestId('company-brain-add'));
    const editor = await screen.findByTestId('company-brain-editor-new');
    await user.click(within(editor).getByText('Speichern')); // title is empty

    expect(writeMock).not.toHaveBeenCalled();
    expect(messageErrorMock).toHaveBeenCalled();
  });
});

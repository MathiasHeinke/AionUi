/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Company Brain settings tab — v1.4 T3: the REAL per-seat read/write surface.
 *
 * BEFORE (T2 and earlier) this tab only showed a seeded ✓/✗ Tag + a button that
 * force-opened the Day-Zero seed modal — the operator could NOT see, edit or
 * delete what was in the brain. This panel now lists every entry in the ACTIVE
 * seat's Company-Brain (title + kind label + author badge + relative updated_at),
 * lets the operator ADD / EDIT / DELETE entries, lazily loads a body only when an
 * entry is opened, and shows an honest empty-state. The Day-Zero seed modal stays
 * as an honest quick-start ("Briefing einfügen") — it now APPENDS a brief entry
 * (T1/T2 seed-migration), it no longer clobbers.
 *
 * SEAT DISCIPLINE. The list is scoped to the ACTIVE seat and re-loads on a seat
 * switch — we depend on `useActiveSeatId()` (the configService.onSeatRebind
 * signal, the same precedent as useDayZeroOnboarding) so a switch re-homes the
 * view WITHOUT a remount. NO mount-once read (the known fault class). A stale-seat
 * guard drops any list/read result whose seat moved on while the IPC was in flight.
 *
 * ERRORS ARE LOUD. Every failed IPC surfaces Message.error with the reason_code —
 * never a silent bounce (the PII-toggle lesson). Bodies live in entries/<id>.md and
 * are fetched on demand; the list payload never carries them.
 */

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Button, Card, Input, Message, Popconfirm, Select, Space, Tag } from '@arco-design/web-react';
import { useTranslation } from 'react-i18next';
import { commandEve, type ICommandEveCompanyBrainEntry } from '@/common/adapter/ipcBridge';
import { configService } from '@/common/config/configService';
import { useActiveSeatId } from '@renderer/hooks/useActiveSeatId';
import { persistCompanyBrainSeed, useDayZeroOnboarding } from '@renderer/hooks/useDayZeroOnboarding';
import DayZeroOnboardingModal from '@renderer/components/billing/DayZeroOnboardingModal';

/** The seven writable kinds (T2 allowlist) + their German labels. */
const KIND_ORDER = ['company', 'offer', 'audience', 'tone', 'dos_donts', 'brief', 'note'] as const;
type WriteKind = (typeof KIND_ORDER)[number];

const kindLabel = (t: ReturnType<typeof useTranslation>['t'], kind: string): string => {
  const map: Record<string, [string, string]> = {
    company: ['credits.companyBrain.kind.company', 'Unternehmen'],
    offer: ['credits.companyBrain.kind.offer', 'Angebot'],
    audience: ['credits.companyBrain.kind.audience', 'Zielgruppe'],
    tone: ['credits.companyBrain.kind.tone', 'Tonalität'],
    dos_donts: ['credits.companyBrain.kind.dosDonts', "Dos & Don'ts"],
    brief: ['credits.companyBrain.kind.brief', 'Briefing'],
    note: ['credits.companyBrain.kind.note', 'Notiz'],
  };
  const entry = map[kind];
  // A foreign/future kind (e.g. 'project') the store tolerates on read: show it raw.
  if (!entry) return kind;
  return t(entry[0], { defaultValue: entry[1] });
};

/**
 * Small, dependency-free relative-time formatter (German). Avoids pulling a dayjs
 * plugin just for "vor 3 Min." — an empty/invalid timestamp degrades to "".
 */
const relativeTime = (iso: string): string => {
  if (!iso) return '';
  const then = Date.parse(iso);
  if (Number.isNaN(then)) return '';
  const diffMs = Date.now() - then;
  const sec = Math.max(0, Math.floor(diffMs / 1000));
  if (sec < 60) return 'gerade eben';
  const min = Math.floor(sec / 60);
  if (min < 60) return `vor ${min} Min.`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `vor ${hr} Std.`;
  const day = Math.floor(hr / 24);
  if (day < 30) return `vor ${day} T.`;
  const mon = Math.floor(day / 30);
  if (mon < 12) return `vor ${mon} Mon.`;
  return `vor ${Math.floor(mon / 12)} J.`;
};

interface EditorState {
  /** undefined = a NEW entry (create); a string = editing that entry id. */
  id?: string;
  kind: WriteKind;
  title: string;
  body: string;
}

const emptyEditor = (): EditorState => ({ kind: 'note', title: '', body: '' });

const CompanyBrainModalContent: React.FC = () => {
  const { t } = useTranslation();
  // Stable handle to the latest `t` for use inside callbacks. `t`'s identity is
  // NOT guaranteed stable across renders (some i18n setups mint a fresh fn), so we
  // must NOT put `t` in a callback's dep array — that would rebuild loadEntries
  // every render and re-fire the mount effect forever. Reading via the ref keeps
  // translations current without destabilizing the memoized callbacks.
  const tRef = useRef(t);
  tRef.current = t;

  // Re-home the whole view on a seat switch (no mount-once read). Same precedent
  // as useDayZeroOnboarding — depend on the reactive active-seat id.
  const activeSeatId = useActiveSeatId();

  // Keep the seeded Tag + the seed quick-start (Day-Zero modal) — enabled:false so
  // it NEVER force-pops here; we only use its `seeded` status + `recordSeed` action.
  const { seeded, recordSeed } = useDayZeroOnboarding({ enabled: false, onSeedRecorded: persistCompanyBrainSeed });
  const [seedOpen, setSeedOpen] = useState(false);

  const [entries, setEntries] = useState<ICommandEveCompanyBrainEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [editor, setEditor] = useState<EditorState | null>(null);
  const [saving, setSaving] = useState(false);
  const [busyRemoveId, setBusyRemoveId] = useState<string | null>(null);

  const kindOptions = useMemo(
    () => KIND_ORDER.map((k) => ({ label: kindLabel(t, k), value: k })),
    [t]
  );

  // LIST loader — re-runs on seat change. Stale-seat guard: a result resolved for a
  // seat that is no longer active (a fast A→B switch raced ahead) is dropped.
  const loadEntries = useCallback(async () => {
    const loadForSeat = activeSeatId;
    setLoading(true);
    try {
      const res = await commandEve.companyBrainList.invoke();
      if (loadForSeat !== configService.getCurrentSeatId()) return; // stale-seat guard
      if (res?.success && res.data?.ok) {
        setEntries(res.data.entries ?? []);
      } else {
        setEntries([]);
        Message.error(
          tRef.current('credits.companyBrain.listFailed', {
            defaultValue: 'Company Brain konnte nicht geladen werden ({{code}}).',
            code: res?.data?.reason_code ?? res?.msg ?? 'UNKNOWN',
          })
        );
      }
    } catch (error) {
      if (loadForSeat !== configService.getCurrentSeatId()) return;
      setEntries([]);
      Message.error(
        tRef.current('credits.companyBrain.listFailed', {
          defaultValue: 'Company Brain konnte nicht geladen werden ({{code}}).',
          code: error instanceof Error ? error.message : 'UNKNOWN',
        })
      );
    } finally {
      if (loadForSeat === configService.getCurrentSeatId()) setLoading(false);
    }
  }, [activeSeatId]);

  useEffect(() => {
    // Reset per-seat view state on switch, then reload for the new seat.
    setExpandedId(null);
    setEditor(null);
    void loadEntries();
  }, [loadEntries]);

  // Open an entry: lazily fetch its body (never in the list payload), fill the
  // editor, expand it. A missing body reads as "" (empty, still editable).
  const openEntry = useCallback(
    async (entry: ICommandEveCompanyBrainEntry) => {
      if (expandedId === entry.id) {
        setExpandedId(null);
        setEditor(null);
        return;
      }
      const loadForSeat = activeSeatId;
      try {
        const res = await commandEve.companyBrainRead.invoke({ id: entry.id });
        if (loadForSeat !== configService.getCurrentSeatId()) return;
        if (!res?.success || !res.data?.ok) {
          Message.error(
            tRef.current('credits.companyBrain.readFailed', {
              defaultValue: 'Eintrag konnte nicht geladen werden ({{code}}).',
              code: res?.data?.reason_code ?? res?.msg ?? 'UNKNOWN',
            })
          );
          return;
        }
        // A foreign kind (not in the write allowlist) is read-only-ish; still allow
        // editing but keep its kind (upsert would reject a non-writable kind, so we
        // clamp the editor kind to 'note' only when the stored kind isn't writable).
        const writable = (KIND_ORDER as readonly string[]).includes(entry.kind);
        setEditor({
          id: entry.id,
          kind: (writable ? entry.kind : 'note') as WriteKind,
          title: entry.title,
          body: res.data.body ?? '',
        });
        setExpandedId(entry.id);
      } catch (error) {
        if (loadForSeat !== configService.getCurrentSeatId()) return;
        Message.error(
          tRef.current('credits.companyBrain.readFailed', {
            defaultValue: 'Eintrag konnte nicht geladen werden ({{code}}).',
            code: error instanceof Error ? error.message : 'UNKNOWN',
          })
        );
      }
    },
    [activeSeatId, expandedId]
  );

  const startAdd = useCallback(() => {
    setExpandedId(null);
    setEditor(emptyEditor());
  }, []);

  const cancelEditor = useCallback(() => {
    setEditor(null);
    setExpandedId(null);
  }, []);

  const saveEditor = useCallback(async () => {
    if (!editor) return;
    const title = editor.title.trim();
    if (title.length === 0) {
      Message.error(tRef.current('credits.companyBrain.titleRequired', { defaultValue: 'Bitte gib dem Eintrag einen Titel.' }));
      return;
    }
    setSaving(true);
    try {
      const res = await commandEve.companyBrainWrite.invoke({
        id: editor.id,
        kind: editor.kind,
        title,
        body: editor.body,
      });
      if (!res?.success || !res.data?.ok) {
        Message.error(
          tRef.current('credits.companyBrain.writeFailed', {
            defaultValue: 'Eintrag konnte nicht gespeichert werden ({{code}}).',
            code: res?.data?.reason_code ?? res?.msg ?? 'UNKNOWN',
          })
        );
        return;
      }
      Message.success(tRef.current('credits.companyBrain.saved', { defaultValue: 'Eintrag gespeichert.' }));
      setEditor(null);
      setExpandedId(null);
      await loadEntries();
    } catch (error) {
      Message.error(
        tRef.current('credits.companyBrain.writeFailed', {
          defaultValue: 'Eintrag konnte nicht gespeichert werden ({{code}}).',
          code: error instanceof Error ? error.message : 'UNKNOWN',
        })
      );
    } finally {
      setSaving(false);
    }
  }, [editor, loadEntries]);

  const removeEntry = useCallback(
    async (id: string) => {
      setBusyRemoveId(id);
      try {
        const res = await commandEve.companyBrainRemove.invoke({ id });
        if (!res?.success || !res.data?.ok) {
          Message.error(
            tRef.current('credits.companyBrain.deleteFailed', {
              defaultValue: 'Eintrag konnte nicht gelöscht werden ({{code}}).',
              code: res?.data?.reason_code ?? res?.msg ?? 'UNKNOWN',
            })
          );
          return;
        }
        Message.success(tRef.current('credits.companyBrain.deleted', { defaultValue: 'Eintrag gelöscht.' }));
        if (expandedId === id) {
          setExpandedId(null);
          setEditor(null);
        }
        await loadEntries();
      } catch (error) {
        Message.error(
          tRef.current('credits.companyBrain.deleteFailed', {
            defaultValue: 'Eintrag konnte nicht gelöscht werden ({{code}}).',
            code: error instanceof Error ? error.message : 'UNKNOWN',
          })
        );
      } finally {
        setBusyRemoveId(null);
      }
    },
    [expandedId, loadEntries]
  );

  const handleSeed = async (seed: Parameters<typeof recordSeed>[0]) => {
    await recordSeed(seed);
    setSeedOpen(false);
    await loadEntries(); // the seed appends a brief entry — reflect it immediately
  };

  const isCreating = editor !== null && editor.id === undefined;

  return (
    <div className='company-brain-settings' data-testid='company-brain-settings'>
      <Card
        className='company-brain-settings__status'
        title={t('credits.companyBrain.title', { defaultValue: 'Company Brain' })}
      >
        <div className='company-brain-settings__status-row' data-testid='company-brain-status'>
          {seeded ? (
            <Tag color='green' data-seeded='true'>
              {t('credits.companyBrain.seeded', { defaultValue: 'Company Brain: geseedet ✓' })}
            </Tag>
          ) : (
            <Tag color='gray' data-seeded='false'>
              {t('credits.companyBrain.notSeeded', { defaultValue: 'Company Brain: noch nicht geseedet' })}
            </Tag>
          )}
        </div>

        <p className='company-brain-settings__seat-note'>
          {t('credits.companyBrain.seatNote', { defaultValue: 'Gilt nur für diesen Seat.' })}
        </p>

        <Space className='company-brain-settings__actions'>
          <Button
            type='primary'
            shape='round'
            onClick={startAdd}
            disabled={isCreating}
            data-testid='company-brain-add'
          >
            {t('credits.companyBrain.addEntry', { defaultValue: 'Eintrag hinzufügen' })}
          </Button>
          {/* Honest quick-start: the Day-Zero modal now APPENDS a brief entry. */}
          <Button
            shape='round'
            onClick={() => setSeedOpen(true)}
            data-testid='company-brain-seed-open'
          >
            {t('credits.companyBrain.insertBriefing', { defaultValue: 'Briefing einfügen' })}
          </Button>
        </Space>

        {/* NEW-entry editor (create). Edit uses the inline expanded editor below. */}
        {isCreating && editor && (
          <div className='company-brain-settings__editor' data-testid='company-brain-editor-new'>
            <Select
              value={editor.kind}
              onChange={(v) => setEditor((e) => (e ? { ...e, kind: v as WriteKind } : e))}
              options={kindOptions}
              data-testid='company-brain-kind-select'
              style={{ width: 200 }}
            />
            <Input
              value={editor.title}
              onChange={(v) => setEditor((e) => (e ? { ...e, title: v } : e))}
              placeholder={t('credits.companyBrain.titlePlaceholder', { defaultValue: 'Titel' })}
              data-testid='company-brain-title-input'
            />
            <Input.TextArea
              value={editor.body}
              onChange={(v) => setEditor((e) => (e ? { ...e, body: v } : e))}
              placeholder={t('credits.companyBrain.bodyPlaceholder', { defaultValue: 'Inhalt (Markdown)' })}
              autoSize={{ minRows: 4, maxRows: 12 }}
              data-testid='company-brain-body-input'
            />
            <Space>
              <Button type='primary' loading={saving} onClick={saveEditor} data-testid='company-brain-save'>
                {t('credits.companyBrain.save', { defaultValue: 'Speichern' })}
              </Button>
              <Button onClick={cancelEditor}>{t('credits.companyBrain.cancel', { defaultValue: 'Abbrechen' })}</Button>
            </Space>
          </div>
        )}

        {/* LIST */}
        {loading ? (
          <p className='company-brain-settings__loading' data-testid='company-brain-loading'>
            {t('credits.companyBrain.loading', { defaultValue: 'Lade Company Brain …' })}
          </p>
        ) : entries.length === 0 ? (
          <p className='company-brain-settings__empty' data-testid='company-brain-empty'>
            {t('credits.companyBrain.empty', {
              defaultValue:
                'Noch nichts im Company Brain dieses Seats — füge Wissen hinzu oder erzähl es EVE im Chat.',
            })}
          </p>
        ) : (
          <ul className='company-brain-settings__list' data-testid='company-brain-list'>
            {entries.map((entry) => {
              const isOpen = expandedId === entry.id;
              const isEve = entry.author === 'eve';
              return (
                <li
                  key={entry.id}
                  className='company-brain-settings__item'
                  data-testid='company-brain-item'
                  data-entry-id={entry.id}
                  data-author={entry.author}
                >
                  <div className='company-brain-settings__item-head'>
                    <button
                      type='button'
                      className='company-brain-settings__item-title'
                      onClick={() => openEntry(entry)}
                      data-testid='company-brain-item-open'
                    >
                      <span className='company-brain-settings__item-title-text'>{entry.title}</span>
                      <Tag size='small' color='arcoblue'>
                        {kindLabel(t, entry.kind)}
                      </Tag>
                      <Tag size='small' color={isEve ? 'purple' : 'gray'} data-author-badge={entry.author}>
                        {isEve
                          ? t('credits.companyBrain.authorEve', { defaultValue: 'von EVE' })
                          : t('credits.companyBrain.authorUser', { defaultValue: 'von dir' })}
                      </Tag>
                      <span className='company-brain-settings__item-time'>{relativeTime(entry.updated_at)}</span>
                    </button>
                    <Popconfirm
                      title={t('credits.companyBrain.deleteConfirm', {
                        defaultValue: 'Diesen Eintrag wirklich löschen?',
                      })}
                      okText={t('credits.companyBrain.deleteOk', { defaultValue: 'Löschen' })}
                      cancelText={t('credits.companyBrain.cancel', { defaultValue: 'Abbrechen' })}
                      onOk={() => removeEntry(entry.id)}
                    >
                      <Button
                        size='small'
                        status='danger'
                        type='text'
                        loading={busyRemoveId === entry.id}
                        data-testid='company-brain-item-delete'
                      >
                        {t('credits.companyBrain.delete', { defaultValue: 'Löschen' })}
                      </Button>
                    </Popconfirm>
                  </div>

                  {/* Inline EDIT editor for the opened entry. */}
                  {isOpen && editor && editor.id === entry.id && (
                    <div className='company-brain-settings__editor' data-testid='company-brain-editor-edit'>
                      <Select
                        value={editor.kind}
                        onChange={(v) => setEditor((e) => (e ? { ...e, kind: v as WriteKind } : e))}
                        options={kindOptions}
                        style={{ width: 200 }}
                      />
                      <Input
                        value={editor.title}
                        onChange={(v) => setEditor((e) => (e ? { ...e, title: v } : e))}
                        placeholder={t('credits.companyBrain.titlePlaceholder', { defaultValue: 'Titel' })}
                        data-testid='company-brain-edit-title-input'
                      />
                      <Input.TextArea
                        value={editor.body}
                        onChange={(v) => setEditor((e) => (e ? { ...e, body: v } : e))}
                        autoSize={{ minRows: 4, maxRows: 12 }}
                        data-testid='company-brain-edit-body-input'
                      />
                      <Space>
                        <Button
                          type='primary'
                          loading={saving}
                          onClick={saveEditor}
                          data-testid='company-brain-edit-save'
                        >
                          {t('credits.companyBrain.save', { defaultValue: 'Speichern' })}
                        </Button>
                        <Button onClick={cancelEditor}>
                          {t('credits.companyBrain.cancel', { defaultValue: 'Abbrechen' })}
                        </Button>
                      </Space>
                    </div>
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </Card>

      {/* Same seed UI as the Day-0 modal, opened on demand — never forced. It now
          APPENDS a brief entry (T1/T2 seed-migration), it no longer clobbers. */}
      <DayZeroOnboardingModal open={seedOpen} onSeed={handleSeed} onSkip={() => setSeedOpen(false)} />
    </div>
  );
};

export default CompanyBrainModalContent;

/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Company Brain settings tab — v1.4 T8: a BLUEPRINT OUTLINE, not a flat notepad.
 *
 * FOUNDER DESIGN (wörtlich): "Systematik wie ein Markdown-File: H1 Company, H2/H3-
 * Unterteilung, Stichpunkte drin; EVE weiß exakt, WO sich was geändert hat." The
 * panel now renders a FIXED section outline in BLUEPRINT_SECTIONS order (Unternehmen,
 * Team, Angebot, Zielgruppe, Aktuelle Projekte, Ziele & Zukunft, Fokus, Tonalität,
 * Dos & Don'ts, Briefing) — each with a fill indicator (leer / ausgefüllt) and an
 * expand-to-edit body. Blueprint sections are NEVER deletable (only "Leeren" resets
 * a section to its placeholder). Below the outline, a "Notizen & Gelerntes" section
 * lists the FREE entries (notes, EVE-Notizen, brief additions) with the classic
 * add / edit / delete flow. session_digest entries are NOT shown (system L3 memory).
 *
 * SEAT DISCIPLINE. Scoped to the ACTIVE seat, re-loads on a switch via
 * useActiveSeatId() (the configService.onSeatRebind signal). NO mount-once read. A
 * stale-seat guard drops any list/read result whose seat moved on while in flight.
 *
 * ERRORS ARE LOUD. Every failed IPC surfaces Message.error with the reason_code —
 * never a silent bounce. Bodies live in entries/<id>.md and are fetched on demand.
 */

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Button, Card, Input, Message, Popconfirm, Select, Space, Tag } from '@arco-design/web-react';
import { useTranslation } from 'react-i18next';
import { commandEve, type ICommandEveCompanyBrainEntry } from '@/common/adapter/ipcBridge';
import { configService } from '@/common/config/configService';
import { useActiveSeatId } from '@renderer/hooks/useActiveSeatId';
import { persistCompanyBrainSeed, useDayZeroOnboarding } from '@renderer/hooks/useDayZeroOnboarding';
import DayZeroOnboardingModal from '@renderer/components/billing/DayZeroOnboardingModal';

/**
 * The writable kinds + German labels (T8 widened by team/projects/goals/focus). Kept
 * as a small renderer mirror; the process-side allowlist (COMPANY_BRAIN_WRITE_KINDS)
 * is the SoT — a note's kind picker only offers 'note'.
 */
const KIND_ORDER = ['company', 'team', 'offer', 'audience', 'projects', 'goals', 'focus', 'tone', 'dos_donts', 'brief', 'note'] as const;
type WriteKind = (typeof KIND_ORDER)[number];

/**
 * T8 — the fixed blueprint sections, MIRRORING the process-side BLUEPRINT_SECTIONS
 * (companyBrainStoreCore.ts) in id / kind / title / DISPLAY ORDER / placeholder. The
 * process side is the source of truth (it scaffolds these on Day-Zero); this mirror
 * lets the renderer draw the outline + a "Leeren" reset without importing fs-bound
 * process code. Keep in lockstep with BLUEPRINT_SECTIONS. The Briefing section reuses
 * the stable day-0 brief id so seed↔blueprint converge.
 */
const BLUEPRINT_DAY_ZERO_BRIEF_ID = 'brief-day-0';
interface BlueprintSectionView {
  id: string;
  kind: WriteKind;
  title: string;
  placeholder: string;
}
const BLUEPRINT_SECTIONS: readonly BlueprintSectionView[] = [
  { id: 'bp-company', kind: 'company', title: 'Unternehmen', placeholder: ['### Unternehmen', '- Name: …', '- Größe / Mitarbeiter: …', '- Branche: …', '- Standort: …'].join('\n') },
  { id: 'bp-team', kind: 'team', title: 'Team', placeholder: ['### Team', '- Wer gehört zum Team (Rollen)?', '- Ansprechpartner: …', '- Externe Partner: …'].join('\n') },
  { id: 'bp-offer', kind: 'offer', title: 'Angebot', placeholder: ['### Angebot', '- Was wird verkauft?', '- Preis / Pakete: …', '- Nutzenversprechen: …'].join('\n') },
  { id: 'bp-audience', kind: 'audience', title: 'Zielgruppe', placeholder: ['### Zielgruppe', '- Wer ist der ideale Kunde?', '- Probleme / Bedürfnisse: …', '- Kanäle, wo sie sind: …'].join('\n') },
  { id: 'bp-projects', kind: 'projects', title: 'Aktuelle Projekte', placeholder: ['### Aktuelle Projekte', '- Woran wird gerade gearbeitet?', '- Status / Deadline: …'].join('\n') },
  { id: 'bp-goals', kind: 'goals', title: 'Ziele & Zukunft', placeholder: ['### Ziele & Zukunft', '- Ziel für die nächsten 3–12 Monate?', '- Vision / wohin soll es gehen?'].join('\n') },
  { id: 'bp-focus', kind: 'focus', title: 'Fokus', placeholder: ['### Fokus', '- Was ist gerade am wichtigsten?', '- Woran NICHT arbeiten (bewusst weglassen)?'].join('\n') },
  { id: 'bp-tone', kind: 'tone', title: 'Tonalität', placeholder: ['### Tonalität', '- Wie klingt die Marke (Stil, Ansprache)?', '- Lieblingsphrasen / was NIE gesagt wird: …'].join('\n') },
  { id: 'bp-dos-donts', kind: 'dos_donts', title: "Dos & Don'ts", placeholder: ['### Dos & Don\'ts', '- Dos: …', '- Don\'ts: …'].join('\n') },
  { id: BLUEPRINT_DAY_ZERO_BRIEF_ID, kind: 'brief', title: 'Briefing', placeholder: ['### Briefing', '- Kurzbriefing / Kontext für EVE: …'].join('\n') },
];
const BLUEPRINT_SECTION_IDS = new Set(BLUEPRINT_SECTIONS.map((s) => s.id));
const placeholderById = new Map(BLUEPRINT_SECTIONS.map((s) => [s.id, s.placeholder]));

/**
 * A blueprint body counts as "filled" iff it has real content beyond the scaffolded
 * placeholder — mirrors the process-side isBlueprintBodyFilled so the indicator agrees
 * with the hint's N/M count. Empty / equal-to-placeholder / only Leitfragen = leer.
 */
const isBlueprintFilled = (body: string | null | undefined, placeholder: string): boolean => {
  const trimmed = (body ?? '').trim();
  if (trimmed.length === 0) return false;
  if (trimmed === placeholder.trim()) return false;
  for (const raw of trimmed.split('\n')) {
    const line = raw.trim();
    if (line.length === 0) continue;
    if (line.startsWith('#')) continue;
    if (/^[-*]\s.*:\s*…\s*$/.test(line)) continue;
    if (/^[-*]\s.*\?\s*$/.test(line)) continue;
    return true;
  }
  return false;
};

const kindLabel = (t: ReturnType<typeof useTranslation>['t'], kind: string): string => {
  const map: Record<string, [string, string]> = {
    company: ['credits.companyBrain.kind.company', 'Unternehmen'],
    team: ['credits.companyBrain.kind.team', 'Team'],
    offer: ['credits.companyBrain.kind.offer', 'Angebot'],
    audience: ['credits.companyBrain.kind.audience', 'Zielgruppe'],
    projects: ['credits.companyBrain.kind.projects', 'Aktuelle Projekte'],
    goals: ['credits.companyBrain.kind.goals', 'Ziele & Zukunft'],
    focus: ['credits.companyBrain.kind.focus', 'Fokus'],
    tone: ['credits.companyBrain.kind.tone', 'Tonalität'],
    dos_donts: ['credits.companyBrain.kind.dosDonts', "Dos & Don'ts"],
    brief: ['credits.companyBrain.kind.brief', 'Briefing'],
    note: ['credits.companyBrain.kind.note', 'Notiz'],
  };
  const entry = map[kind];
  if (!entry) return kind; // a foreign/future kind the store tolerates: show raw.
  return t(entry[0], { defaultValue: entry[1] });
};

/**
 * Small, dependency-free relative-time formatter (German). An empty/invalid
 * timestamp degrades to "".
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
  /** undefined = a NEW note (create); a string = editing that entry id. */
  id?: string;
  kind: WriteKind;
  title: string;
  body: string;
  /** True when this editor is a fixed blueprint section (kind/title locked). */
  blueprint?: boolean;
}

const emptyNoteEditor = (): EditorState => ({ kind: 'note', title: '', body: '' });

const CompanyBrainModalContent: React.FC = () => {
  const { t } = useTranslation();
  // Stable handle to the latest `t` for use inside callbacks (t's identity may not
  // be stable across renders — reading via ref keeps translations current without
  // destabilizing the memoized callbacks).
  const tRef = useRef(t);
  tRef.current = t;

  const activeSeatId = useActiveSeatId();

  const { seeded, recordSeed } = useDayZeroOnboarding({ enabled: false, onSeedRecorded: persistCompanyBrainSeed });
  const [seedOpen, setSeedOpen] = useState(false);

  const [entries, setEntries] = useState<ICommandEveCompanyBrainEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [editor, setEditor] = useState<EditorState | null>(null);
  const [saving, setSaving] = useState(false);
  const [busyRemoveId, setBusyRemoveId] = useState<string | null>(null);

  const noteKindOptions = useMemo(() => [{ label: kindLabel(t, 'note'), value: 'note' as WriteKind }], [t]);

  // Partition the index by id: the blueprint entries (by fixed id) vs. the free
  // notes. session_digest entries (system L3) are NOT shown here.
  const entryById = useMemo(() => {
    const m = new Map<string, ICommandEveCompanyBrainEntry>();
    for (const e of entries) m.set(e.id, e);
    return m;
  }, [entries]);
  const noteEntries = useMemo(
    () => entries.filter((e) => !BLUEPRINT_SECTION_IDS.has(e.id) && e.kind !== 'session_digest'),
    [entries]
  );

  // Bodies are lazily fetched; cache them so the fill indicator can reflect the
  // opened body without a re-fetch. Keyed by id.
  const [bodyCache, setBodyCache] = useState<Record<string, string>>({});

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
    setExpandedId(null);
    setEditor(null);
    setBodyCache({});
    void loadEntries();
  }, [loadEntries]);

  // Lazily fetch a body (never in the list payload). Returns the body ('' when
  // missing). Caches it so the fill indicator + re-open are instant.
  const fetchBody = useCallback(
    async (id: string): Promise<string | null> => {
      const loadForSeat = activeSeatId;
      try {
        const res = await commandEve.companyBrainRead.invoke({ id });
        if (loadForSeat !== configService.getCurrentSeatId()) return null;
        if (!res?.success || !res.data?.ok) {
          Message.error(
            tRef.current('credits.companyBrain.readFailed', {
              defaultValue: 'Eintrag konnte nicht geladen werden ({{code}}).',
              code: res?.data?.reason_code ?? res?.msg ?? 'UNKNOWN',
            })
          );
          return null;
        }
        const body = res.data.body ?? '';
        setBodyCache((c) => ({ ...c, [id]: body }));
        return body;
      } catch (error) {
        if (loadForSeat !== configService.getCurrentSeatId()) return null;
        Message.error(
          tRef.current('credits.companyBrain.readFailed', {
            defaultValue: 'Eintrag konnte nicht geladen werden ({{code}}).',
            code: error instanceof Error ? error.message : 'UNKNOWN',
          })
        );
        return null;
      }
    },
    [activeSeatId]
  );

  // Open a blueprint SECTION: fetch its body (or start from placeholder), open a
  // locked-kind editor. Toggling the same section closes it.
  const openSection = useCallback(
    async (section: BlueprintSectionView) => {
      if (expandedId === section.id) {
        setExpandedId(null);
        setEditor(null);
        return;
      }
      const existing = entryById.get(section.id);
      const body = existing ? (await fetchBody(section.id)) ?? '' : section.placeholder;
      setEditor({ id: section.id, kind: section.kind, title: section.title, body, blueprint: true });
      setExpandedId(section.id);
    },
    [expandedId, entryById, fetchBody]
  );

  // Open a free NOTE: fetch its body, open an editor.
  const openNote = useCallback(
    async (entry: ICommandEveCompanyBrainEntry) => {
      if (expandedId === entry.id) {
        setExpandedId(null);
        setEditor(null);
        return;
      }
      const body = (await fetchBody(entry.id)) ?? '';
      const writable = (KIND_ORDER as readonly string[]).includes(entry.kind);
      setEditor({ id: entry.id, kind: (writable ? entry.kind : 'note') as WriteKind, title: entry.title, body });
      setExpandedId(entry.id);
    },
    [expandedId, fetchBody]
  );

  const startAddNote = useCallback(() => {
    setExpandedId(null);
    setEditor(emptyNoteEditor());
  }, []);

  const cancelEditor = useCallback(() => {
    setEditor(null);
    setExpandedId(null);
  }, []);

  // Persist the editor (create/edit). Used by both the note editor and the section
  // editor — the section editor carries the fixed id/kind/title.
  const saveEditor = useCallback(async () => {
    if (!editor) return;
    const title = editor.title.trim();
    if (title.length === 0) {
      Message.error(tRef.current('credits.companyBrain.titleRequired', { defaultValue: 'Bitte gib dem Eintrag einen Titel.' }));
      return;
    }
    setSaving(true);
    try {
      const res = await commandEve.companyBrainWrite.invoke({ id: editor.id, kind: editor.kind, title, body: editor.body });
      if (!res?.success || !res.data?.ok) {
        Message.error(
          tRef.current('credits.companyBrain.writeFailed', {
            defaultValue: 'Eintrag konnte nicht gespeichert werden ({{code}}).',
            code: res?.data?.reason_code ?? res?.msg ?? 'UNKNOWN',
          })
        );
        return;
      }
      if (editor.id) setBodyCache((c) => ({ ...c, [editor.id as string]: editor.body }));
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

  // "Leeren" a blueprint section: reset its body to the placeholder (NOT a delete —
  // blueprint sections are never removed). Writes the placeholder back via upsert.
  const clearSection = useCallback(
    async (section: BlueprintSectionView) => {
      setBusyRemoveId(section.id);
      try {
        const res = await commandEve.companyBrainWrite.invoke({ id: section.id, kind: section.kind, title: section.title, body: section.placeholder });
        if (!res?.success || !res.data?.ok) {
          Message.error(
            tRef.current('credits.companyBrain.writeFailed', {
              defaultValue: 'Eintrag konnte nicht gespeichert werden ({{code}}).',
              code: res?.data?.reason_code ?? res?.msg ?? 'UNKNOWN',
            })
          );
          return;
        }
        setBodyCache((c) => ({ ...c, [section.id]: section.placeholder }));
        Message.success(tRef.current('credits.companyBrain.cleared', { defaultValue: 'Sektion geleert.' }));
        if (expandedId === section.id) {
          setExpandedId(null);
          setEditor(null);
        }
        await loadEntries();
      } catch (error) {
        Message.error(
          tRef.current('credits.companyBrain.writeFailed', {
            defaultValue: 'Eintrag konnte nicht gespeichert werden ({{code}}).',
            code: error instanceof Error ? error.message : 'UNKNOWN',
          })
        );
      } finally {
        setBusyRemoveId(null);
      }
    },
    [expandedId, loadEntries]
  );

  // Delete a free note (blueprint sections are NEVER deleted — no delete for them).
  const removeNote = useCallback(
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

  const handleSeed = async (seedInput: Parameters<typeof recordSeed>[0]) => {
    await recordSeed(seedInput);
    setSeedOpen(false);
    await loadEntries();
  };

  const isCreatingNote = editor !== null && editor.id === undefined;

  // The fill decision for ONE section. The session-local bodyCache wins once a
  // body has been opened/edited (live while typing); before that the MAIN-side
  // `filled` flag from the list payload is the truth — it is computed from the
  // files on disk. The old cache-only guess rendered a fully filled brain as
  // "leer / 0 von 10" on every dialog open until each section was clicked
  // (live incident 2026-07-03).
  const isSectionFilled = useCallback(
    (section: (typeof BLUEPRINT_SECTIONS)[number]): boolean => {
      const cached = bodyCache[section.id];
      if (cached !== undefined) return isBlueprintFilled(cached, section.placeholder);
      return entryById.get(section.id)?.filled === true;
    },
    [bodyCache, entryById]
  );

  // The fill count for the outline header (leer/ausgefüllt indicator + N/M summary).
  const filledCount = useMemo(() => {
    let n = 0;
    for (const s of BLUEPRINT_SECTIONS) {
      if (isSectionFilled(s)) n += 1;
    }
    return n;
  }, [isSectionFilled]);

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
          <span className='company-brain-settings__blueprint-count' data-testid='company-brain-blueprint-count'>
            {t('credits.companyBrain.blueprintCount', {
              defaultValue: 'Blaupause: {{filled}}/{{total}} Sektionen ausgefüllt',
              filled: filledCount,
              total: BLUEPRINT_SECTIONS.length,
            })
              .replace('{{filled}}', String(filledCount))
              .replace('{{total}}', String(BLUEPRINT_SECTIONS.length))}
          </span>
        </div>

        <p className='company-brain-settings__seat-note'>
          {t('credits.companyBrain.seatNote', { defaultValue: 'Gilt nur für diesen Seat.' })}
        </p>

        {/* ── BLUEPRINT OUTLINE (fixed sections, never deletable) ──────────────── */}
        <ul className='company-brain-settings__outline' data-testid='company-brain-outline'>
          {BLUEPRINT_SECTIONS.map((section) => {
            const isOpen = expandedId === section.id;
            const entry = entryById.get(section.id);
            const filled = isSectionFilled(section);
            // Freshness: EVE edits section bodies DIRECTLY (index updated_at goes
            // stale the moment she writes) — prefer the body mtime when newer.
            const bodyMtime = typeof entry?.body_mtime_ms === 'number' ? entry.body_mtime_ms : null;
            const indexMs = entry?.updated_at ? Date.parse(entry.updated_at) : NaN;
            const freshestIso =
              bodyMtime !== null && (!Number.isFinite(indexMs) || bodyMtime > indexMs)
                ? new Date(bodyMtime).toISOString()
                : entry?.updated_at;
            return (
              <li
                key={section.id}
                className='company-brain-settings__section'
                data-testid='company-brain-section'
                data-section-id={section.id}
                data-filled={filled ? 'true' : 'false'}
              >
                <div className='company-brain-settings__item-head'>
                  <button
                    type='button'
                    className='company-brain-settings__item-title'
                    onClick={() => openSection(section)}
                    data-testid='company-brain-section-open'
                  >
                    <span className='company-brain-settings__item-title-text'>{section.title}</span>
                    <Tag size='small' color={filled ? 'green' : 'gray'} data-fill-indicator={filled ? 'filled' : 'empty'}>
                      {filled
                        ? t('credits.companyBrain.filled', { defaultValue: 'ausgefüllt' })
                        : t('credits.companyBrain.emptySection', { defaultValue: 'leer' })}
                    </Tag>
                    {entry?.author === 'eve' && (
                      <Tag size='small' color='purple' data-author-badge='eve'>
                        {t('credits.companyBrain.authorEve', { defaultValue: 'von EVE' })}
                      </Tag>
                    )}
                    {freshestIso && (
                      <span className='company-brain-settings__item-time'>{relativeTime(freshestIso)}</span>
                    )}
                  </button>
                  {/* Blueprint sections are NEVER deletable — only "Leeren". */}
                  <Popconfirm
                    title={t('credits.companyBrain.clearConfirm', { defaultValue: 'Diese Sektion wirklich leeren?' })}
                    okText={t('credits.companyBrain.clearOk', { defaultValue: 'Leeren' })}
                    cancelText={t('credits.companyBrain.cancel', { defaultValue: 'Abbrechen' })}
                    onOk={() => clearSection(section)}
                  >
                    <Button
                      size='small'
                      type='text'
                      loading={busyRemoveId === section.id}
                      data-testid='company-brain-section-clear'
                    >
                      {t('credits.companyBrain.clear', { defaultValue: 'Leeren' })}
                    </Button>
                  </Popconfirm>
                </div>

                {isOpen && editor && editor.id === section.id && (
                  <div className='company-brain-settings__editor' data-testid='company-brain-section-editor'>
                    <Input.TextArea
                      value={editor.body}
                      onChange={(v) => setEditor((e) => (e ? { ...e, body: v } : e))}
                      placeholder={t('credits.companyBrain.bodyPlaceholder', { defaultValue: 'Inhalt (Markdown)' })}
                      autoSize={{ minRows: 4, maxRows: 14 }}
                      data-testid='company-brain-section-body-input'
                    />
                    <Space>
                      <Button type='primary' loading={saving} onClick={saveEditor} data-testid='company-brain-section-save'>
                        {t('credits.companyBrain.save', { defaultValue: 'Speichern' })}
                      </Button>
                      <Button onClick={cancelEditor}>{t('credits.companyBrain.cancel', { defaultValue: 'Abbrechen' })}</Button>
                    </Space>
                  </div>
                )}
              </li>
            );
          })}
        </ul>

        {/* ── NOTIZEN & GELERNTES (free entries, add/edit/delete) ──────────────── */}
        <div className='company-brain-settings__notes' data-testid='company-brain-notes'>
          <div className='company-brain-settings__notes-head'>
            <h4 className='company-brain-settings__notes-title'>
              {t('credits.companyBrain.notesTitle', { defaultValue: 'Notizen & Gelerntes' })}
            </h4>
            <Space className='company-brain-settings__actions'>
              <Button
                type='primary'
                shape='round'
                onClick={startAddNote}
                disabled={isCreatingNote}
                data-testid='company-brain-add'
              >
                {t('credits.companyBrain.addEntry', { defaultValue: 'Eintrag hinzufügen' })}
              </Button>
              <Button shape='round' onClick={() => setSeedOpen(true)} data-testid='company-brain-seed-open'>
                {t('credits.companyBrain.insertBriefing', { defaultValue: 'Briefing einfügen' })}
              </Button>
            </Space>
          </div>

          {/* NEW-note editor (create). */}
          {isCreatingNote && editor && (
            <div className='company-brain-settings__editor' data-testid='company-brain-editor-new'>
              <Select
                value={editor.kind}
                onChange={(v) => setEditor((e) => (e ? { ...e, kind: v as WriteKind } : e))}
                options={noteKindOptions}
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

          {loading ? (
            <p className='company-brain-settings__loading' data-testid='company-brain-loading'>
              {t('credits.companyBrain.loading', { defaultValue: 'Lade Company Brain …' })}
            </p>
          ) : noteEntries.length === 0 ? (
            <p className='company-brain-settings__empty' data-testid='company-brain-empty'>
              {t('credits.companyBrain.notesEmpty', {
                defaultValue: 'Noch keine Notizen — füge Wissen hinzu oder erzähl es EVE im Chat.',
              })}
            </p>
          ) : (
            <ul className='company-brain-settings__list' data-testid='company-brain-list'>
              {noteEntries.map((entry) => {
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
                        onClick={() => openNote(entry)}
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
                        title={t('credits.companyBrain.deleteConfirm', { defaultValue: 'Diesen Eintrag wirklich löschen?' })}
                        okText={t('credits.companyBrain.deleteOk', { defaultValue: 'Löschen' })}
                        cancelText={t('credits.companyBrain.cancel', { defaultValue: 'Abbrechen' })}
                        onOk={() => removeNote(entry.id)}
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

                    {isOpen && editor && editor.id === entry.id && (
                      <div className='company-brain-settings__editor' data-testid='company-brain-editor-edit'>
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
                          <Button type='primary' loading={saving} onClick={saveEditor} data-testid='company-brain-edit-save'>
                            {t('credits.companyBrain.save', { defaultValue: 'Speichern' })}
                          </Button>
                          <Button onClick={cancelEditor}>{t('credits.companyBrain.cancel', { defaultValue: 'Abbrechen' })}</Button>
                        </Space>
                      </div>
                    )}
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      </Card>

      <DayZeroOnboardingModal open={seedOpen} onSeed={handleSeed} onSkip={() => setSeedOpen(false)} />
    </div>
  );
};

export default CompanyBrainModalContent;

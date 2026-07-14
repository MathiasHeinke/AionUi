/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Command EVE v1.6 (Slice 2, "Die Hinterlassene Hand") — the pure handover-note
 * core.
 *
 * The start surface never speaks FOR EVE: it renders language she really left
 * behind. At the end of a substantial session EVE herself writes (via her file
 * tools, instructed by a standing SOUL directive) a short handover note to
 * `company-brain/uebergabe/note.md` in the active seat's Hermes home. The SYSTEM
 * owns only the frame: the authoritative timestamp is the file's mtime (never
 * her claim), the age framing, and the degradation to the claim-free system
 * card when the note is missing or unreadable.
 *
 * This module is PURE (no IO, no React): tolerant parsing of the note she wrote
 * (she is a model writing a file — a malformed head must NEVER reject her note;
 * worst case the whole file renders as body text with no chips), the age
 * classification (today · recent · long — the K11 graft: the return after an
 * absence gets an HONEST frame instead of a stale-looking card), and the
 * localized system frame copy.
 */

import { normalizeGreetingLocale } from '@/common/config/onboardingGreetingCore';

export const COMMAND_EVE_STARTSCREEN_NOTE_VERSION = 'command-eve-startscreen-note/v0';

/** Seat-relative path EVE is instructed to write (and the bridge reads). */
export const COMMAND_EVE_HANDOVER_NOTE_RELPATH = 'company-brain/uebergabe/note.md';

/** Bounds: the surface shows a note, not a report. */
export const HANDOVER_NOTE_MAX_RAW_CHARS = 8000;
const NEXT_MAX_ITEMS = 3;
const NEXT_MAX_CHARS = 120;

export interface CommandEveHandoverNote {
  /** Her note body, verbatim (rendered pre-wrap — her words, her formatting). */
  body_md: string;
  /** Her `next:` suggestions (the ONLY source of tap-chips on the surface). */
  next: string[];
}

/**
 * Tolerant parse of the note file EVE wrote. Recognized head (optional):
 *
 *   ---
 *   next:
 *     - Erster Vorschlag
 *     - "Zweiter Vorschlag"
 *   ---
 *   <free text body>
 *
 * Anything else in the head (type/ts claims, unknown keys) is IGNORED — the
 * system's mtime is the only timestamp authority. A malformed head never
 * rejects the note: the whole raw text becomes the body, chips stay empty.
 */
export function parseHandoverNote(raw: string): CommandEveHandoverNote {
  const text = (raw || '').slice(0, HANDOVER_NOTE_MAX_RAW_CHARS);
  // Normalize CRLF/CR → LF: a model authoring note.md may emit Windows line
  // endings, and the `$`-anchored item regex below fails on a trailing \r,
  // which would silently drop EVERY next:-chip (the note body still renders).
  const trimmed = text.replace(/^﻿/, '').replace(/\r\n?/g, '\n');
  if (!trimmed.startsWith('---')) return { body_md: trimmed.trim(), next: [] };

  const end = trimmed.indexOf('\n---', 3);
  if (end < 0) return { body_md: trimmed.trim(), next: [] };

  const head = trimmed.slice(3, end);
  // Body starts after the closing '---' line.
  const afterClose = trimmed.indexOf('\n', end + 1);
  const body = afterClose >= 0 ? trimmed.slice(afterClose + 1) : '';

  const next: string[] = [];
  let inNext = false;
  for (const line of head.split('\n')) {
    if (/^next\s*:\s*$/i.test(line.trim())) {
      inNext = true;
      continue;
    }
    // A new top-level key (no leading whitespace, `key:`) ends the next-list.
    if (inNext && /^\S.*:/.test(line)) inNext = false;
    if (!inNext) continue;
    const m = line.match(/^\s*-\s*(.+)$/);
    if (!m) continue;
    const item = m[1]
      .trim()
      .replace(/^["']|["']$/g, '')
      .trim();
    if (item && next.length < NEXT_MAX_ITEMS) next.push(item.slice(0, NEXT_MAX_CHARS));
  }
  return { body_md: body.trim(), next };
}

/**
 * Age classes for the K11 return framing. Boundaries: same LOCAL calendar day
 * ⇒ 'today'; up to 14 days ⇒ 'recent'; beyond ⇒ 'long' (the 14-day absence is
 * the product's own north-star horizon).
 */
export type CommandEveNoteAgeClass = 'today' | 'recent' | 'long';

export function classifyNoteAge(mtimeMs: number, nowMs: number): CommandEveNoteAgeClass {
  const mtime = new Date(mtimeMs);
  const now = new Date(nowMs);
  if (
    mtime.getFullYear() === now.getFullYear() &&
    mtime.getMonth() === now.getMonth() &&
    mtime.getDate() === now.getDate()
  ) {
    return 'today';
  }
  const days = Math.floor((nowMs - mtimeMs) / 86_400_000);
  return days <= 14 ? 'recent' : 'long';
}

export interface CommandEveNoteFrame {
  /** System title line above her note (never her voice). */
  title: string;
  /** Honest age label, e.g. "geschrieben heute, 18:32" / "vor 16 Tagen — lange nicht gesehen". */
  age_label: string;
  age_class: CommandEveNoteAgeClass;
}

const FRAME_COPY = {
  de: {
    title: 'EVEs Übergabenotiz',
    today: (hhmm: string) => `geschrieben heute, ${hhmm}`,
    days: (n: number) => (n <= 1 ? 'geschrieben gestern' : `geschrieben vor ${n} Tagen`),
    long: (n: number) => `geschrieben vor ${n} Tagen — schön, dass du wieder da bist`,
  },
  en: {
    title: "EVE's handover note",
    today: (hhmm: string) => `written today, ${hhmm}`,
    days: (n: number) => (n <= 1 ? 'written yesterday' : `written ${n} days ago`),
    long: (n: number) => `written ${n} days ago — good to see you back`,
  },
} as const;

/** Build the localized SYSTEM frame around her note. Pure; caller passes now. */
export function buildNoteFrame(mtimeMs: number, nowMs: number, uiLanguage?: string): CommandEveNoteFrame {
  const locale = normalizeGreetingLocale(uiLanguage);
  const copy = FRAME_COPY[locale];
  const ageClass = classifyNoteAge(mtimeMs, nowMs);
  const days = Math.max(1, Math.floor((nowMs - mtimeMs) / 86_400_000));
  let ageLabel: string;
  if (ageClass === 'today') {
    const d = new Date(mtimeMs);
    const hhmm = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
    ageLabel = copy.today(hhmm);
  } else if (ageClass === 'recent') {
    ageLabel = copy.days(days);
  } else {
    ageLabel = copy.long(days);
  }
  return { title: copy.title, age_label: ageLabel, age_class: ageClass };
}

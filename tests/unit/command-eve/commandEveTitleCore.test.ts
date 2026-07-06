/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';

import {
  buildLocalTitlePrompt,
  evaluateLocalTitleSmokeGate,
  pickLocalTitleModel,
  sanitizeGeneratedTitle,
} from '@/process/commandEve/commandEveTitleCore';

describe('commandEveTitleCore — buildLocalTitlePrompt', () => {
  it('builds a German prompt by default and embeds the task', () => {
    const p = buildLocalTitlePrompt('Erstelle eine Landingpage für meinen Kunden', 'de-DE');
    expect(p).toMatch(/Session-Titel/);
    expect(p).toMatch(/3-6 Wörter/);
    expect(p).toContain('Erstelle eine Landingpage');
  });

  it('builds an English prompt for en-US', () => {
    const p = buildLocalTitlePrompt('Build a landing page for my client', 'en-US');
    expect(p).toMatch(/session title/i);
    expect(p).toContain('Build a landing page');
  });

  it('collapses whitespace and clamps very long input', () => {
    const long = 'word '.repeat(1000);
    const p = buildLocalTitlePrompt(long, 'en-US');
    // The task slice is bounded; the prompt should not be unboundedly long.
    expect(p.length).toBeLessThan(1400);
    expect(p).not.toMatch(/ {2,}/); // no double spaces
  });
});

describe('commandEveTitleCore — pickLocalTitleModel', () => {
  it('prefers the bundled e4b model when present', () => {
    const picked = pickLocalTitleModel([
      'llama3:latest',
      'command-eve-gemma4-12b-64k:latest',
      'command-eve-gemma4-e4b-64k:latest',
    ]);
    expect(picked).toBe('command-eve-gemma4-e4b-64k:latest');
  });

  it('falls back to any command-eve managed model when e4b is absent', () => {
    const picked = pickLocalTitleModel(['llama3:latest', 'command-eve-gemma4-12b-64k:latest']);
    expect(picked).toBe('command-eve-gemma4-12b-64k:latest');
  });

  it('returns null when no managed (command-eve-*) model exists', () => {
    expect(pickLocalTitleModel(['llama3:latest', 'mistral:latest'])).toBeNull();
    expect(pickLocalTitleModel([])).toBeNull();
  });
});

describe('commandEveTitleCore — sanitizeGeneratedTitle', () => {
  it('keeps a clean short title verbatim', () => {
    expect(sanitizeGeneratedTitle('Landingpage für Kunden bauen')).toBe('Landingpage für Kunden bauen');
  });

  it('strips wrapping quotes and trailing punctuation', () => {
    expect(sanitizeGeneratedTitle('"Landingpage bauen."')).toBe('Landingpage bauen');
    expect(sanitizeGeneratedTitle('“Kundengewinnung planen!”')).toBe('Kundengewinnung planen');
  });

  it('strips a leading "Titel:" / "Title:" label and markdown markers', () => {
    expect(sanitizeGeneratedTitle('Titel: Angebot challengen')).toBe('Angebot challengen');
    expect(sanitizeGeneratedTitle('Title: Plan erstellen')).toBe('Plan erstellen');
    expect(sanitizeGeneratedTitle('# Roadmap aufsetzen')).toBe('Roadmap aufsetzen');
    expect(sanitizeGeneratedTitle('* Kampagne planen')).toBe('Kampagne planen');
  });

  it('drops <think> blocks and uses the first real line', () => {
    expect(sanitizeGeneratedTitle('<think>hmm let me think</think>\nKampagne starten')).toBe('Kampagne starten');
  });

  it('takes only the first non-empty line', () => {
    expect(sanitizeGeneratedTitle('Erster Titel\nnoch eine Zeile')).toBe('Erster Titel');
  });

  it('clamps an over-long title to a word + char budget', () => {
    const out = sanitizeGeneratedTitle('one two three four five six seven eight nine ten eleven');
    expect(out).not.toBeNull();
    expect((out as string).split(' ').length).toBeLessThanOrEqual(8);
  });

  it('returns null for empty / unusable replies', () => {
    expect(sanitizeGeneratedTitle('')).toBeNull();
    expect(sanitizeGeneratedTitle('   ')).toBeNull();
    expect(sanitizeGeneratedTitle(null)).toBeNull();
    expect(sanitizeGeneratedTitle(undefined)).toBeNull();
    expect(sanitizeGeneratedTitle('"."')).toBeNull();
  });
});

describe('commandEveTitleCore — evaluateLocalTitleSmokeGate', () => {
  it('passes a short on-topic local title', () => {
    expect(evaluateLocalTitleSmokeGate('KI-Automation Landingpage', ['landingpage', 'steuerberater'])).toEqual({
      ok: true,
      title: 'KI-Automation Landingpage',
    });
  });

  it('fails loud on empty or unusable local output', () => {
    expect(evaluateLocalTitleSmokeGate('', ['landingpage'])).toEqual({
      ok: false,
      title: null,
      reason_code: 'TITLE_SMOKE_EMPTY',
    });
  });

  it('fails loud when the model echoes the prompt contract', () => {
    expect(evaluateLocalTitleSmokeGate('Aufgabe: Landingpage bauen', ['landingpage'])).toEqual({
      ok: false,
      title: 'Aufgabe: Landingpage bauen',
      reason_code: 'TITLE_SMOKE_ECHOED_PROMPT',
    });
  });

  it('fails loud when the title misses the expected topic terms', () => {
    expect(evaluateLocalTitleSmokeGate('Allgemeinen Plan erstellen', ['landingpage', 'steuerberater'])).toEqual({
      ok: false,
      title: 'Allgemeinen Plan erstellen',
      reason_code: 'TITLE_SMOKE_OFF_TOPIC',
    });
  });

  it('fails loud when the title is too short for the smoke contract', () => {
    expect(evaluateLocalTitleSmokeGate('Plan', ['plan'])).toEqual({
      ok: false,
      title: 'Plan',
      reason_code: 'TITLE_SMOKE_TOO_SHORT',
    });
  });

  it('fails loud on rambly raw output before sanitizer trimming can hide it', () => {
    const raw =
      'Landingpage für Steuerberater KI Automation mit ausführlicher Erklärung warum diese Überschrift gut funktionieren könnte';
    expect(evaluateLocalTitleSmokeGate(raw, ['landingpage'])).toEqual({
      ok: false,
      title: 'Landingpage für Steuerberater KI Automation mit',
      reason_code: 'TITLE_SMOKE_TOO_LONG',
    });
  });
});

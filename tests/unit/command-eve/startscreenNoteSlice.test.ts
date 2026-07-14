/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * v1.6 Slice 2 ("Die Hinterlassene Hand") — pins the tournament invariant:
 * the start surface renders ONLY language EVE really left behind, framed by
 * the SYSTEM's timestamp authority.
 *
 *  - startscreenNoteCore: tolerant parse (a malformed head must never reject
 *    her note), age classes (today · recent · long — the K11 return framing),
 *    localized system frames.
 *  - SOUL directives: the handover-note ritual + first-brief mirror posture
 *    carry the hard honesty rules (never staged pre-work, claim-free) and are
 *    actually WIRED into the SOUL.md assembly (source tripwire, same pattern
 *    as eveSoulWiring.test.ts — module-private assembly, so we assert source).
 */

import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import {
  buildNoteFrame,
  classifyNoteAge,
  parseHandoverNote,
  COMMAND_EVE_HANDOVER_NOTE_RELPATH,
  HANDOVER_NOTE_MAX_RAW_CHARS,
} from '@/common/config/startscreenNoteCore';
import { eveFirstBriefMirrorDirective, eveHandoverNoteDirective } from '@/process/commandEve/runtimeBootstrapCore';

describe('startscreenNoteCore: tolerant parse of the note EVE wrote', () => {
  it('parses head next: list + body, strips quotes, caps at 3 chips', () => {
    const raw = [
      '---',
      'type: uebergabenotiz',
      'next:',
      '  - Erster Schritt',
      '  - "Zweiter Schritt"',
      "  - 'Dritter Schritt'",
      '  - Vierter wird gekappt',
      '---',
      'Heute haben wir den Brief geschärft.',
      '',
      'Morgen würde ich die zwei Entwürfe reviewen.',
    ].join('\n');
    const note = parseHandoverNote(raw);
    expect(note.next).toEqual(['Erster Schritt', 'Zweiter Schritt', 'Dritter Schritt']);
    expect(note.body_md).toContain('Heute haben wir den Brief geschärft.');
    expect(note.body_md).toContain('Morgen würde ich die zwei Entwürfe reviewen.');
    expect(note.body_md).not.toContain('---');
  });

  it('a note without a head is ALL body, no chips', () => {
    const note = parseHandoverNote('Nur Text, kein Kopf.');
    expect(note.body_md).toBe('Nur Text, kein Kopf.');
    expect(note.next).toEqual([]);
  });

  it('a malformed head never rejects her note (unterminated head ⇒ whole text is body)', () => {
    const raw = '---\nnext:\n  - Verwaist';
    const note = parseHandoverNote(raw);
    expect(note.body_md).toContain('Verwaist');
    expect(note.next).toEqual([]);
  });

  it('a later top-level key ends the next: list; unknown keys are ignored', () => {
    const raw = ['---', 'next:', '  - Echter Chip', 'ts: 2099-01-01', '  - Kein Chip mehr', '---', 'Body.'].join('\n');
    const note = parseHandoverNote(raw);
    expect(note.next).toEqual(['Echter Chip']);
    expect(note.body_md).toBe('Body.');
  });

  it('caps raw input and chip length (surface shows a note, not a report)', () => {
    const long = parseHandoverNote('x'.repeat(HANDOVER_NOTE_MAX_RAW_CHARS + 5000));
    expect(long.body_md.length).toBeLessThanOrEqual(HANDOVER_NOTE_MAX_RAW_CHARS);
    const chip = parseHandoverNote(`---\nnext:\n  - ${'y'.repeat(400)}\n---\nb`);
    expect(chip.next[0].length).toBeLessThanOrEqual(120);
  });

  it('relpath stays inside the company brain (the seat, never global)', () => {
    expect(COMMAND_EVE_HANDOVER_NOTE_RELPATH.startsWith('company-brain/')).toBe(true);
    expect(COMMAND_EVE_HANDOVER_NOTE_RELPATH).not.toContain('..');
  });
});

describe('startscreenNoteCore: age classes + localized system frame (K11 return framing)', () => {
  const noon = new Date(2026, 6, 2, 12, 0, 0).getTime();

  it('same local calendar day ⇒ today (with HH:mm), ≤14 days ⇒ recent, >14 ⇒ long', () => {
    const morning = new Date(2026, 6, 2, 8, 30, 0).getTime();
    expect(classifyNoteAge(morning, noon)).toBe('today');
    expect(classifyNoteAge(noon - 3 * 86_400_000, noon)).toBe('recent');
    expect(classifyNoteAge(noon - 16 * 86_400_000, noon)).toBe('long');
    expect(buildNoteFrame(morning, noon, 'de-DE').age_label).toBe('geschrieben heute, 08:30');
  });

  it('the long-absence frame is a welcome, not an accusation — de and en', () => {
    const old = noon - 16 * 86_400_000;
    expect(buildNoteFrame(old, noon, 'de-DE').age_label).toContain('schön, dass du wieder da bist');
    expect(buildNoteFrame(old, noon, 'en-US').age_label).toContain('good to see you back');
  });

  it('frames localize with the de-first default and never speak as EVE', () => {
    expect(buildNoteFrame(noon, noon, undefined).title).toBe('EVEs Übergabenotiz');
    expect(buildNoteFrame(noon, noon, 'en-US').title).toBe("EVE's handover note");
    // System frame is ABOUT her note, never her voice: no first person.
    expect(buildNoteFrame(noon, noon, 'de-DE').age_label).not.toMatch(/\bich\b/i);
  });
});

describe('SOUL directives: handover ritual + first-brief mirror (posture, not template)', () => {
  it('handover directive carries the path, the hard honesty rules, and the next: shape', () => {
    const d = eveHandoverNoteDirective('/seat/home/company-brain');
    expect(d).toContain('/seat/home/company-brain/uebergabe/note.md');
    expect(d).toContain('never planned work phrased as done');
    expect(d).toContain('never staged pre-work');
    expect(d).toContain('next:');
    // ISO-6: on client seats the note speaks about the mandate only.
    expect(d).toContain('MANDATE');
    // Empty input ⇒ no directive (byte-identical soul).
    expect(eveHandoverNoteDirective('')).toBe('');
  });

  it('mirror directive: mirror first, ONE question, claim-free — no scripted sentences', () => {
    const d = eveFirstBriefMirrorDirective();
    expect(d).toContain('mirror it back FIRST in your own words');
    expect(d).toContain('exactly ONE clarifying question');
    expect(d).toContain('Never claim work you have not done');
    // Posture, not template: the directive must not contain a quoted German
    // greeting line that would ventriloquize her.
    expect(d).not.toMatch(/du bist startklar|Hi \{/);
  });

  it('both directives are WIRED into the SOUL.md assembly (source tripwire)', () => {
    const source = fs.readFileSync(
      path.resolve(__dirname, '../../../packages/desktop/src/process/commandEve/runtimeBootstrapCore.ts'),
      'utf8'
    );
    const soulWrite = source.slice(source.indexOf('EVE_SOUL_MARKDOWN +'));
    expect(soulWrite).toContain('eveHandoverNoteDirective(path.join(paths.hermesHome, COMPANY_BRAIN_DIR))');
    expect(soulWrite).toContain('eveFirstBriefMirrorDirective()');
  });
});

describe('v1.6 Slice 4 — Day-Zero-Soft-Fold', () => {
  it('Command-EVE builds never force-pop the Day-Zero modal; upstream keeps it', async () => {
    const { COMMAND_EVE_SHELL_ENABLED, isDayZeroForcePopEnabled } = await import('@/common/config/commandEveShell');
    // In the test env AIONUI_UPSTREAM_MODE is unset ⇒ this IS an EVE build.
    expect(COMMAND_EVE_SHELL_ENABLED).toBe(true);
    expect(isDayZeroForcePopEnabled()).toBe(false);
  });

  it('the Router mount is gated on the predicate (source tripwire)', () => {
    const source = fs.readFileSync(
      path.resolve(__dirname, '../../../packages/desktop/src/renderer/components/layout/Router.tsx'),
      'utf8'
    );
    expect(source).toContain('isDayZeroForcePopEnabled()');
    // The host mount must sit INSIDE the gate, not beside it.
    const gated = source.slice(source.indexOf('isDayZeroForcePopEnabled()'));
    expect(gated).toContain('<DayZeroOnboardingHost');
  });

  it('the ready greeting now ASKS for the brief (chat = collector), de and en', async () => {
    const { buildOnboardingGreeting } = await import('@/common/config/onboardingGreetingCore');
    const model = {
      schema_version: 'command-eve-onboarding-status/v0',
      generated_at: '2026-07-02T00:00:00.000Z',
      read_only: true,
      first_value_ready: true,
      entitlement_state: 'entitled',
      cloud_bearer_available: true,
      identity: { needs_confirmation: true, confidence: 'placeholder', source: 'unverified' },
      items: [],
      warnings: [],
    } as never;
    expect(buildOnboardingGreeting(model, 'de-DE').subline).toContain('Erzähl mir in 2–3 Sätzen');
    expect(buildOnboardingGreeting(model, 'en-US').subline).toContain('Tell me in 2–3 sentences');
  });
});

describe('v1.6 Beat 2 — Session-1-Artefakt-Skill (D6-Merge)', () => {
  it('ships the always-on artifact-first contract as its own managed skill', async () => {
    const { commandEveArtifactFirstSkillMarkdown } = await import('@/process/commandEve/runtimeBootstrapCore');
    const md = commandEveArtifactFirstSkillMarkdown();
    expect(md).toContain('Artifact-first contract (all sessions)');
    expect(md).toContain('default runtime rule, not an optional feature');
    expect(md).toContain('even if the operator did not explicitly ask for an artifact');
    expect(md).toContain('images, videos, audio clips, HTML screens, reports, files, markdown tables, code snippets');
    expect(md).toContain('return a visible failure artifact instead of silently stopping');
    expect(md).toContain('Do not paste a bare file path as the only answer');
    expect(md).toContain('Do this proactively');
  });

  it('carries the honest menu, the fabrication kill-switch, and budget honesty', async () => {
    const { commandEveArtifactMenuSkillMarkdown } = await import('@/process/commandEve/runtimeBootstrapCore');
    const md = commandEveArtifactMenuSkillMarkdown();
    // Artifact-first lives in a separate always-on contract; this skill remains
    // the opt-in first-session menu.
    expect(md).toContain('eve-artifact-first-contract');
    // Opt-in discipline: one artifact, never auto-start.
    expect(md).toContain('never auto-start');
    expect(md).toContain('One artifact, then hand over and stop');
    // The honest degradation chain: posts-from-brief default, paste-audit,
    // search-only mini-scan gated on a real silent probe — and NEVER a bare-URL
    // website audit (web extract is keyless-dead on a cold install).
    expect(md).toContain('3 Post-Entwürfe aus deinem Brief');
    expect(md).toContain('kopier mir den Text deiner Startseite rein');
    expect(md).toContain('silent web_search actually returns results');
    expect(md).toContain('never offer a "website audit" from a bare URL');
    // Fabrication kill-switch is a HARD rule with the trust rationale.
    expect(md).toContain('Never audit, quote, or describe content you did not actually read');
    // Fixed audit template.
    expect(md).toContain('3 Stärken · 3 Schwächen · 3 konkrete nächste Schritte');
    // Budget honesty: verified 100/day, bounded range, never their exact count.
    expect(md).toContain('100 actions per day');
    expect(md).toContain('grob 3–8 deiner 100 Gratis-Aktionen heute');
    expect(md).toContain('Never claim their exact remaining count');
    // No capability over-claim.
    expect(md).toContain('not a capability claim');
  });

  it('is WIRED as an app-owned managed skill next to eve-onboarding-awareness (source tripwire)', () => {
    const source = fs.readFileSync(
      path.resolve(__dirname, '../../../packages/desktop/src/process/commandEve/runtimeBootstrapCore.ts'),
      'utf8'
    );
    expect(source).toContain("COMMAND_EVE_ARTIFACT_FIRST_SKILL_ID = 'eve-artifact-first-contract'");
    expect(source).toContain("COMMAND_EVE_ARTIFACT_MENU_SKILL_ID = 'session-1-artefakt'");
    // The writer must be CALLED in the bootstrap, right where the onboarding
    // skill is written — a builder without a call site is a dead skill.
    expect(source).toContain(
      'writeCommandEveOnboardingSkill(paths);\n  writeCommandEveArtifactFirstSkill(paths);\n  writeCommandEveArtifactMenuSkill(paths);'
    );
  });
});

describe('parseHandoverNote — CRLF hotfix (1.6.1)', () => {
  it('CRLF line endings keep the next: chips (was: silently dropped ALL of them)', () => {
    const raw = ['---', 'next:', '  - Schritt eins', '  - Schritt zwei', '---', 'Heute erledigt.'].join('\r\n');
    const note = parseHandoverNote(raw);
    expect(note.next).toEqual(['Schritt eins', 'Schritt zwei']);
    expect(note.body_md).toBe('Heute erledigt.');
  });

  it('bare CR line endings also work', () => {
    const note = parseHandoverNote('---\rnext:\r  - Nur einer\r---\rBody.');
    expect(note.next).toEqual(['Nur einer']);
  });
});

/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * THE ZERO-COST CLAIM GATE, EXTENDED PAST THE LOCALE TREE.
 *
 * WHAT WAS MISSING. `localeCopyManifest.test.ts` states its own boundary in its header:
 * "IT DOES NOT COVER COPY THAT IS NOT IN A LOCALE FILE — hardcoded .tsx strings,
 * main-process strings, bundled skill text, the marketing website." That boundary was
 * honest and it was also exactly where the defect lived. `eveTeamRoster.ts` carries
 *
 *     outcome: 'Beantwortet einfache Fragen rund um die Uhr — kostenlos und lokal, ohne Credits.'
 *
 * as a HARDCODED TypeScript string, on a row whose `tier` is `'standard'` — a metered
 * rung. The panel derived its credit marker from the tier alone, so ONE card told the user
 * both "ohne Credits" and "verbraucht Credits", and every committed gate was green: the
 * manifest gate stops at the locale tree, and nothing else looked at hardcoded copy.
 *
 * SO THIS GATE ASKS ONE QUESTION OF THE WHOLE `packages/desktop/src` TREE: does every
 * hardcoded string that claims a thing costs nothing correspond to something that
 * genuinely costs nothing? "Genuinely" is not re-asserted here — it is READ from
 * {@link eveTeamRoleConsumesCredits}, the single derived answer the panel itself renders
 * from. The claim and the fact are therefore joined by a call, not by someone remembering.
 *
 * THE HONEST BOUND, WRITTEN DOWN RATHER THAN INHERITED:
 *   * This is a VOCABULARY, and a vocabulary is never semantic coverage. A zero-cost
 *     promise phrased outside {@link ZERO_COST_CLAIM} ships green. That failure mode has
 *     already beaten two generations of the sibling web gate, and pretending otherwise
 *     here would repeat it.
 *   * It covers STRING LITERALS in `packages/desktop/src`, with comments stripped. Not
 *     locale JSON (the manifest gate owns that), not bundled skill text, not the website.
 *   * FREE_WORD is deliberately NOT applied tree-wide: measured, it matches 40 places in
 *     this tree and almost all are identifiers (`'free'` as a credits tier id,
 *     `'is-free-floor-worker'`, "memory is free"). A rule whose positives are dominated by
 *     enum values is a rule nobody can act on. It is applied where the string is
 *     unambiguously user-facing COPY: the roster's own display fields.
 *
 * NAMING: `.test.ts` — the vitest `node` project takes `tests/unit/**\/*.test.ts`. Pure
 * file reads and pure data; no DOM.
 */

import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { FREE_WORD, REPO_ROOT, ZERO_COST_CLAIM } from '../../../scripts/approved-copy/core.mjs';
import { EVE_TEAM_ROSTER, type EveTeamRole } from '@/common/config/eveTeamRoster';
import { eveTeamRoleConsumesCredits } from '@/common/config/eveTeamControlsCore';

const SRC_ROOT = path.join(REPO_ROOT, 'packages/desktop/src');

/** The roster fields a user actually reads on a card. Named, so a NEW copy field is not silently unguarded. */
const USER_FACING_FIELDS = ['displayName', 'title', 'outcome'] as const;

const roleCopy = (role: EveTeamRole): string[] => USER_FACING_FIELDS.map((f) => String(role[f] ?? ''));

/**
 * Every string a zero-cost claim is ALLOWED to be: the user-facing copy of a role whose
 * derived credit answer is "costs nothing". Derived from the shipped roster, so a role
 * that stops being free takes its permission with it.
 */
function backedClaims(roster: readonly EveTeamRole[]): Set<string> {
  const allowed = new Set<string>();
  for (const role of roster) {
    if (eveTeamRoleConsumesCredits(role)) continue;
    for (const s of roleCopy(role)) allowed.add(s);
  }
  return allowed;
}

/** Collect .ts/.tsx files under a root. */
function sourceFiles(root: string): string[] {
  const out: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (/\.tsx?$/.test(entry.name)) out.push(full);
    }
  };
  walk(root);
  return out.toSorted();
}

const stripComments = (code: string): string =>
  code.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');

/** Quoted string literals, and template literals with no substitution. */
const LITERAL = /'((?:[^'\\\n]|\\.)*)'|"((?:[^"\\\n]|\\.)*)"|`((?:[^`\\$]|\\.|\$(?!\{))*)`/g;

/** Every zero-cost-claiming literal in the tree, as `file :: text`. */
function claimingLiterals(files: string[]): Array<{ file: string; text: string }> {
  const hits: Array<{ file: string; text: string }> = [];
  for (const file of files) {
    const code = stripComments(readFileSync(file, 'utf8'));
    for (const m of code.matchAll(LITERAL)) {
      const text = m[1] ?? m[2] ?? m[3] ?? '';
      if (!text.trim()) continue;
      if (ZERO_COST_CLAIM.test(text)) hits.push({ file: path.relative(REPO_ROOT, file), text });
    }
  }
  return hits;
}

/**
 * THE RULE, as a pure function over (roster) so a NEGATIVE CONTROL can feed it a
 * fixture. Returns the violations; empty means the roster's claims are all backed.
 */
function unbackedRosterClaims(roster: readonly EveTeamRole[]): string[] {
  const violations: string[] = [];
  for (const role of roster) {
    const metered = eveTeamRoleConsumesCredits(role);
    for (const text of roleCopy(role)) {
      const claims = ZERO_COST_CLAIM.test(text) || FREE_WORD.test(text);
      if (claims && metered) violations.push(`${role.agent_id} (tier "${role.tier}") claims zero cost: ${text}`);
    }
  }
  return violations;
}

const FILES = sourceFiles(SRC_ROOT);
const CLAIMS = claimingLiterals(FILES);

describe('ZERO-COST CLAIMS IN HARDCODED SOURCE — the half the locale manifest does not cover', () => {
  it('the scan is really scanning, and there is really something to guard', () => {
    // Both halves matter. A walk that quietly stopped reaching files would make every
    // assertion below vacuous, and a gate over zero live claims guards nothing.
    expect(FILES.length, 'the packages/desktop/src walk emptied out').toBeGreaterThan(900);
    expect(
      CLAIMS.length,
      'no hardcoded zero-cost claim exists any more — this gate now guards nothing'
    ).toBeGreaterThan(0);
  });

  it('EVERY hardcoded zero-cost claim in packages/desktop/src is BACKED by a role that costs nothing', () => {
    const allowed = backedClaims(EVE_TEAM_ROSTER);
    const unbacked = CLAIMS.filter((h) => !allowed.has(h.text)).map((h) => `${h.file} :: ${h.text}`);
    expect(
      unbacked,
      'a hardcoded string promises the user that something costs nothing, and no roster row ' +
        'with a zero-cost credit answer carries that string. Either the claim is false, or it ' +
        'lives somewhere this gate cannot verify — both must be fixed, not waived.'
    ).toEqual([]);
  });

  it('no METERED roster row claims zero cost in ANY user-facing field', () => {
    // The same rule read off the DATA rather than the source text, so a claim moved into
    // a different field, or a row whose `free` flag is dropped, is caught either way.
    expect(unbackedRosterClaims(EVE_TEAM_ROSTER)).toEqual([]);
  });

  it('the free floor really does claim zero cost — the permission above is used, not hypothetical', () => {
    const floor = EVE_TEAM_ROSTER.filter((role) => !eveTeamRoleConsumesCredits(role));
    expect(floor.length).toBeGreaterThan(0);
    expect(floor.some((role) => roleCopy(role).some((s) => ZERO_COST_CLAIM.test(s)))).toBe(true);
  });

  it('NEGATIVE CONTROL: the SAME copy on a row that costs credits is REPORTED', () => {
    // The exact contradiction that shipped: the claim kept, the `free` declaration
    // dropped, so the derived answer says the turns are metered. Fed as a FIXTURE — the
    // shipped roster is never mutated — so this control runs on every CI machine rather
    // than only under a manual sabotage.
    const floorRow = EVE_TEAM_ROSTER.find((role) => role.agent_id === 'house-keeper');
    expect(floorRow, 'the floor row this control is written about is gone').toBeDefined();
    const contradicted = EVE_TEAM_ROSTER.map((role) =>
      role.agent_id === 'house-keeper' ? ({ ...role, free: false } as EveTeamRole) : role
    );
    // Expected count is DERIVED from the row, not typed here: the floor row claims zero
    // cost in more than one field (`title` says "gratis lokal", `outcome` says "ohne
    // Credits"), and a hand-typed 1 would have read as a broken gate the moment a second
    // field was noticed.
    const claimingFields = roleCopy(floorRow as EveTeamRole).filter(
      (s) => ZERO_COST_CLAIM.test(s) || FREE_WORD.test(s)
    );
    expect(claimingFields.length).toBeGreaterThan(0);

    const violations = unbackedRosterClaims(contradicted);
    expect(violations.length, 'the gate did not notice a metered row promising zero cost').toBe(claimingFields.length);
    for (const v of violations) expect(v).toMatch(/house-keeper/);
    // …and the SHIPPED roster is silent, so the control is measuring the sabotage.
    expect(unbackedRosterClaims(EVE_TEAM_ROSTER)).toEqual([]);
  });

  it('NEGATIVE CONTROL: an unbacked claim in ANY source file is REPORTED', () => {
    // A synthetic literal that no roster row carries. Deliberately not written into a
    // real file: the rule is exercised directly, which is what makes this control run
    // unattended instead of relying on someone remembering to sabotage a file by hand.
    const allowed = backedClaims(EVE_TEAM_ROSTER);
    const invented = 'Diese Auswertung geht aufs Haus und zieht keine Credits.';
    expect(ZERO_COST_CLAIM.test(invented), 'the control probe is outside the rule, so it proves nothing').toBe(true);
    expect(allowed.has(invented)).toBe(false);
  });

  it('THE BOUND IS STATED, not inherited: this file says what it does not cover', () => {
    // The sibling manifest gate carries the same self-description requirement, for the
    // same reason: an unstated boundary is inherited as coverage by whoever reads the
    // green tick. If the header stops saying it, this reds.
    const own = readFileSync(new URL(import.meta.url), 'utf8');
    expect(own).toMatch(/vocabulary is never semantic coverage/);
    expect(own).toMatch(/Not locale JSON/);
  });
});

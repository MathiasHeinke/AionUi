/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Reading and writing the ONE approval record — pure, so both surfaces share it.
 *
 * The start screen and a live session used to reach for different state: the
 * start screen wrote `acp.config[backend].preferredMode`, the session decided
 * elsewhere, and three places resolved the same mode key by three different
 * rules. That is why a choice made on one screen never showed up on the other.
 *
 * Everything below takes the stored values as arguments and returns the next
 * value. No configService, no clock, no IO — the caller supplies `now`. That is
 * what lets the migration and the seal bookkeeping be tested directly.
 */

import { forgetCommand, rememberCommand, readRememberedCommands } from './eveRememberedCommandsCore';
import {
  EVE_AUTHORITY_FAIL_CLOSED,
  EVE_LADDER_RUNGS,
  isEveAuthorityGrant,
  ladderFromLegacyMode,
  type EveAuthorityGrant,
  type EveLadderRung,
  type EveSealedCapability,
} from './eveAuthorityCore';

/** The legacy per-backend shape the start screen used to write into. */
export interface LegacyAcpConfigLike {
  [backend: string]: { preferredMode?: string; yoloMode?: boolean } | undefined;
}

/**
 * Which legacy backend key the Command EVE lane used. Other backends keep their
 * own `preferredMode` for their own agents; only this one seeds the shared grant.
 */
export const COMMAND_EVE_LEGACY_BACKEND = 'hermes';

/**
 * The grant to work from, given whatever is on disk.
 *
 * Order: a valid stored grant wins. Absent or malformed, migrate once from the
 * legacy mode. Anything unreadable lands on the fail-closed default rather than
 * being repaired into something that looks deliberate.
 */
export function resolveStoredGrant(
  storedAuthority: unknown,
  legacyAcpConfig?: LegacyAcpConfigLike | null
): EveAuthorityGrant {
  if (isEveAuthorityGrant(storedAuthority)) return storedAuthority;
  const legacyMode = legacyAcpConfig?.[COMMAND_EVE_LEGACY_BACKEND]?.preferredMode;
  if (typeof legacyMode === 'string' && legacyMode.trim().length > 0) {
    // Migration is input, never authority — no seal is ever opened by it.
    return { ladder: ladderFromLegacyMode(legacyMode), capabilities: {}, updatedBy: 'migration' };
  }
  return EVE_AUTHORITY_FAIL_CLOSED;
}

/** True when this grant has never been chosen by a person. The UI says so plainly. */
export function isUnconfirmedGrant(grant: EveAuthorityGrant): boolean {
  return grant.updatedBy !== 'user';
}

function isLadderRung(value: unknown): value is EveLadderRung {
  return EVE_LADDER_RUNGS.includes(value as EveLadderRung);
}

/**
 * The user moved the ladder. Seals are untouched: moving the ladder is a
 * convenience decision and must never open or close a trust decision.
 */
export function withLadder(grant: EveAuthorityGrant, ladder: unknown): EveAuthorityGrant {
  if (!isLadderRung(ladder)) return grant;
  return { ...grant, ladder, updatedBy: 'user' };
}

/**
 * The user opened or closed one seal.
 *
 * Opening records WHEN, because a grant with no date cannot be reviewed later.
 * Closing drops both the flag and the date — a revoked capability should leave
 * no trace suggesting it is still live. Closing `spend.money` also drops its
 * limit, so re-opening it always requires naming an amount again.
 */
export function withSeal(
  grant: EveAuthorityGrant,
  capability: EveSealedCapability,
  open: boolean,
  now: string
): EveAuthorityGrant {
  const capabilities = { ...grant.capabilities };
  const grantedAt = { ...grant.grantedAt };
  const limits = { ...grant.limits };

  if (open) {
    capabilities[capability] = true;
    grantedAt[capability] = now;
  } else {
    delete capabilities[capability];
    delete grantedAt[capability];
    if (capability === 'spend.money') delete limits['spend.money'];
  }

  const next: EveAuthorityGrant = { ...grant, capabilities, grantedAt, updatedBy: 'user' };
  if (Object.keys(limits).length > 0) next.limits = limits;
  else delete (next as { limits?: unknown }).limits;
  return next;
}

/** A daily budget below this is not a budget, it is a typo. Cents. */
export const MIN_DAILY_BUDGET_CENTS = 1;
/**
 * And above this it stops looking like a decision and starts looking like a slip
 * of the keyboard. The UI asks again rather than refusing outright.
 */
export const HIGH_DAILY_BUDGET_CENTS = 100_000; // 1000 EUR

export type DailyBudgetVerdict = 'ok' | 'confirm' | 'invalid';

/** What the settings panel should do with a typed-in budget, before storing it. */
export function classifyDailyBudget(dailyCents: unknown): DailyBudgetVerdict {
  if (typeof dailyCents !== 'number' || !Number.isFinite(dailyCents)) return 'invalid';
  if (!Number.isInteger(dailyCents)) return 'invalid';
  if (dailyCents < MIN_DAILY_BUDGET_CENTS) return 'invalid';
  if (dailyCents > HIGH_DAILY_BUDGET_CENTS) return 'confirm';
  return 'ok';
}

/**
 * The user set the daily money ceiling. Rejected amounts leave the grant
 * untouched rather than falling back to a default — a budget nobody typed is a
 * budget nobody agreed to.
 */
export function withDailyBudget(grant: EveAuthorityGrant, dailyCents: number): EveAuthorityGrant {
  if (classifyDailyBudget(dailyCents) === 'invalid') return grant;
  return {
    ...grant,
    limits: { ...grant.limits, 'spend.money': { dailyCents } },
    updatedBy: 'user',
  };
}

/**
 * Is this grant internally coherent enough to show as active?
 *
 * The one shape that is not: money unsealed with no usable ceiling. It is
 * refused at decision time anyway, but the settings panel has to SAY so, or the
 * user sees a switch that is on and an EVE that never spends, and concludes the
 * feature is broken.
 */
export function grantNeedsAttention(grant: EveAuthorityGrant): 'money-without-budget' | null {
  if (grant.capabilities['spend.money'] !== true) return null;
  const daily = grant.limits?.['spend.money']?.dailyCents;
  return classifyDailyBudget(daily) === 'ok' || classifyDailyBudget(daily) === 'confirm'
    ? null
    : 'money-without-budget';
}

/**
 * The human said "you may always do this" on a permission card.
 *
 * Deliberately NOT Hermes' own "always" button: that one calls
 * `approve_permanent(pattern_key)`, and `pattern_key` is the DESCRIPTION of a
 * regex category — one click would grant the whole class. This stores the
 * literal command instead, and the seat's allowlist is regenerated from it.
 *
 * A rejected candidate leaves the grant untouched, so nothing lands in the
 * allowlist that the human did not see on the card.
 */
export function withRememberedCommand(grant: EveAuthorityGrant, command: string, now: string): EveAuthorityGrant {
  const existing = readRememberedCommands(grant.rememberedCommands);
  const next = rememberCommand(existing, command, now);
  if (next === existing) return grant;
  return { ...grant, rememberedCommands: next, updatedBy: 'user' };
}

/** The human withdrew one remembered command. The next boot emits the allowlist without it. */
export function withoutRememberedCommand(grant: EveAuthorityGrant, command: string): EveAuthorityGrant {
  const existing = readRememberedCommands(grant.rememberedCommands);
  const next = forgetCommand(existing, command);
  if (next.length === existing.length) return grant;
  return { ...grant, rememberedCommands: next, updatedBy: 'user' };
}

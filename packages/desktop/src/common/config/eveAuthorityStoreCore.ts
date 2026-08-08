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
  readEveAuthorityGrant,
  EVE_AUTHORITY_FAIL_CLOSED,
  EVE_LADDER_RUNGS,
  EVE_SEALED_CAPABILITIES,
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
 * The rung a full release lands on. Named rather than inlined so the one place
 * that means "as high as the ladder goes" is greppable.
 */
export const FULL_AUTHORITY_RUNG: EveLadderRung = 5;

/**
 * "Full release for this machine" — the one-act version of a decision that
 * otherwise takes seven separate hands: pick rung 5, open five seals, name a
 * budget. Someone who means "just get on with it, this box is mine" should not
 * have to perform that as a chore, and today they do.
 *
 * WHY THIS IS NOT A SEVENTH RUNG, which is the obvious shape and the wrong one:
 *
 *   - Rung 5 already admits every action class (`RUNG_ADMITS`). A rung 6 would
 *     add nothing on the ladder's own axis; its entire content would be "and
 *     open the seals", which is the other axis.
 *   - `grantAllows` reads the seal BEFORE the rung, on purpose: the human who
 *     unsealed a capability IS the authority for it. A rung that opened seals
 *     would have to invert that rule, and `sealUsable` (eveAuthorityRuntimeCore)
 *     probes seals with an irreversible action precisely because they hang off
 *     no rung.
 *   - It would be PARTLY INERT. `spendWithinDailyLimit` still refuses money with
 *     no ceiling, so a rung 6 would store "everything" and quietly not do one
 *     fifth of it — the exact defect class the 1.821 work exists to remove.
 *   - A rung-shaped grant carries no `grantedAt` per seal, so nothing could be
 *     reviewed later; and "revoke one seal" would have no representable state.
 *
 * So this is a COMPOSITION, not a new kind of grant: it calls `withLadder`,
 * `withSeal` and `withDailyBudget` — the same functions the individual controls
 * call. The record it produces is indistinguishable from one assembled by hand,
 * which is what stops this path from ever drifting away from that one.
 */

/**
 * What a full release should do about money.
 *
 * Deliberately not a boolean. `spendWithinDailyLimit` refuses an open money seal
 * that has no ceiling, so opening it blind would manufacture exactly the one
 * incoherent grant `grantNeedsAttention` exists to report: a switch that is on
 * and an EVE that never spends. Either a number is named here, or money is left
 * out of the act and the confirmation says so in as many words.
 */
export type FullAuthorityMoney = { readonly dailyCents: number } | 'keep-sealed';

/**
 * Exactly what a full release would change, computed BEFORE anything is written.
 *
 * This exists so the confirmation step can list the real consequences rather
 * than a generic warning. A confirmation that says "this grants full access" and
 * a confirmation that names the five things it opens are not the same product:
 * only the second one can be read and disagreed with.
 */
export interface FullAuthorityPreview {
  ladderFrom: EveLadderRung;
  ladderTo: EveLadderRung;
  ladderChanges: boolean;
  /** Seals this act turns from shut to open. */
  sealsToOpen: readonly EveSealedCapability[];
  /** Seals the human already opened. Listed so the confirmation is a full picture, not a diff. */
  sealsAlreadyOpen: readonly EveSealedCapability[];
  /** True when money is deliberately not part of this act; whatever it is now, it stays. */
  moneyLeftAsIs: boolean;
  /** The ceiling this act would write, in cents. Null when `moneyLeftAsIs`. */
  dailyCents: number | null;
  budgetChanges: boolean;
  /** Set when the act cannot run as asked. `withFullAuthority` then changes nothing at all. */
  blocked: 'invalid-budget' | null;
  /** True when the grant already says all of this. The button is then a no-op, and says so. */
  changesNothing: boolean;
}

export function previewFullAuthority(grant: EveAuthorityGrant, money: FullAuthorityMoney): FullAuthorityPreview {
  const moneyLeftAsIs = money === 'keep-sealed';
  const blocked = !moneyLeftAsIs && classifyDailyBudget(money.dailyCents) === 'invalid' ? 'invalid-budget' : null;

  // Money is in the target set only when a number came with it. Everything else
  // is always in it — that is what "full" means.
  const targets = EVE_SEALED_CAPABILITIES.filter((capability) => capability !== 'spend.money' || !moneyLeftAsIs);
  const sealsToOpen = targets.filter((capability) => grant.capabilities[capability] !== true);
  const sealsAlreadyOpen = targets.filter((capability) => grant.capabilities[capability] === true);

  const dailyCents = moneyLeftAsIs ? null : money.dailyCents;
  const budgetChanges = dailyCents !== null && grant.limits?.['spend.money']?.dailyCents !== dailyCents;
  const ladderChanges = grant.ladder !== FULL_AUTHORITY_RUNG;

  return {
    ladderFrom: grant.ladder,
    ladderTo: FULL_AUTHORITY_RUNG,
    ladderChanges,
    sealsToOpen,
    sealsAlreadyOpen,
    moneyLeftAsIs,
    dailyCents,
    budgetChanges,
    blocked,
    changesNothing: blocked === null && !ladderChanges && sealsToOpen.length === 0 && !budgetChanges,
  };
}

/**
 * Apply the full release.
 *
 * ALL OR NOTHING. A refused budget returns the grant untouched rather than
 * opening the other four seals and skipping money: a half-applied "full release"
 * is a grant the human never chose, and they would have no way to tell which
 * half landed.
 *
 * Money is never CLOSED here, only opened. A release raises the ceiling; it is
 * not a channel for taking something back. Withdrawing stays where withdrawing
 * belongs — the individual switch.
 */
export function withFullAuthority(grant: EveAuthorityGrant, money: FullAuthorityMoney, now: string): EveAuthorityGrant {
  const preview = previewFullAuthority(grant, money);
  if (preview.blocked !== null) return grant;

  let next = withLadder(grant, FULL_AUTHORITY_RUNG);
  for (const capability of preview.sealsToOpen) next = withSeal(next, capability, true, now);
  if (money !== 'keep-sealed') next = withDailyBudget(next, money.dailyCents);
  return next;
}

/**
 * Is this seat actually fully released right now?
 *
 * Requires a USABLE money ceiling, not merely an open money seal — because a
 * grant with money open and no number spends nothing (`spendWithinDailyLimit`),
 * and a panel that called that state "full" would be the surface promising more
 * than the runtime holds.
 */
export function isFullAuthority(grant: EveAuthorityGrant): boolean {
  if (grant.ladder !== FULL_AUTHORITY_RUNG) return false;
  if (!EVE_SEALED_CAPABILITIES.every((capability) => grant.capabilities[capability] === true)) return false;
  return grantNeedsAttention(grant) === null;
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
  // `updatedBy` is deliberately CARRIED, not set to 'user'. It records whether a
  // human chose the LADDER, and remembering one command is not that choice.
  // Stamping it here made a grant that a migration invented look confirmed, and
  // silenced the "you have not confirmed this yet" banner on a rung nobody
  // picked (P2, Kimi).
  return { ...grant, rememberedCommands: next };
}

/** The human withdrew one remembered command. The next boot emits the allowlist without it. */
export function withoutRememberedCommand(grant: EveAuthorityGrant, command: string): EveAuthorityGrant {
  const existing = readRememberedCommands(grant.rememberedCommands);
  const next = forgetCommand(existing, command);
  if (next.length === existing.length) return grant;
  // Same reasoning as `withRememberedCommand`: withdrawing a command says
  // nothing about the ladder, so it must not mark the ladder as confirmed.
  return { ...grant, rememberedCommands: next };
}

/**
 * The ACP mode a rung ALSO writes, where the wheel happens to have one.
 *
 * This is a compatibility mirror, not the enforcement. Until 1.821.0 it was
 * both, and that is why only three rungs existed in the UI: the wheel decides
 * against three modes (`default`, `accept_edits`, `dont_ask`), so rungs 0, 4
 * and 5 had nowhere to go and were hidden rather than shipped inert.
 *
 * The enforcement now lives where all six rungs mean something — the approval
 * patch asks `decideAuthority` through the loopback shim on every decision
 * (eveAuthorityRuntimeCore, runtimeBootstrapCore's approval-class patch). A rung
 * with no mode here is therefore NOT an unenforced rung; it is a rung the wheel
 * has no word for.
 *
 * `dont_ask` is mapped for rung 3 for legacy readers only. It never reaches the
 * wheel's session-wide bypass: the shim replaces `_sync_terminal_approval_mode`
 * with one that disables that bypass for every mode, and grants rung 3 its
 * commands one operation at a time instead.
 */
const LADDER_TO_BACKEND_MODE: Partial<Record<EveLadderRung, string>> = {
  0: 'default',
  1: 'default',
  2: 'accept_edits',
  3: 'dont_ask',
};

/**
 * The rungs the settings panel offers, in order — all six.
 *
 * Each one now changes what EVE does: 0 and 1 answer `ask` to everything (they
 * differ in whether EVE may offer to act at all, see `mayOfferToAct`), 2 admits
 * workspace edits, 3 adds workspace commands, 4 reaches outside the working
 * folder, 5 adds irreversible actions. The five seals stay outside the ladder at
 * every rung, including 5.
 */
export const ENFORCED_LADDER_RUNGS: readonly EveLadderRung[] = EVE_LADDER_RUNGS;

/** The legacy ACP mode a rung mirrors, or null when the wheel has no word for it. */
export function ladderToBackendMode(rung: EveLadderRung): string | null {
  return LADDER_TO_BACKEND_MODE[rung] ?? null;
}

/**
 * True when this rung is one the product enforces.
 *
 * Every rung is, since 1.821.0 — the approval path reads the grant itself. The
 * function stays because callers ask the question, and because the honest answer
 * is no longer "does the wheel have a mode for it".
 */
export function isEnforcedLadderRung(rung: EveLadderRung): boolean {
  return EVE_LADDER_RUNGS.includes(rung);
}

/**
 * The legacy per-backend value to write ALONGSIDE the grant, so the choice
 * actually takes effect.
 *
 * The grant is the record; `acp.config[hermes].preferredMode` is what the
 * session opening path already reads. Writing only the grant would leave a
 * setting that stores a preference and changes nothing — which is exactly the
 * defect class this whole change exists to remove.
 */
export function backendModeForGrant(grant: EveAuthorityGrant): string | null {
  return ladderToBackendMode(grant.ladder);
}

/**
 * The seat's remembered commands, taken from a raw backend-settings bag.
 *
 * Exists as its own function because the inline version lived in the Electron
 * main entry point, where it could not be tested — and that is exactly where it
 * was missing: the emitter accepted the grants, the tests passed them by hand,
 * and no production caller ever read them (P1, independent review). A test that
 * has to inject the value cannot catch a caller that never supplies it.
 *
 * Fail-CLOSED: an unreadable or malformed bag yields an empty list, never "all
 * the grants from last time". An empty list simply means EVE asks again.
 */
export function rememberedCommandsFromSettings(bag: Record<string, unknown> | null | undefined) {
  if (!bag || typeof bag !== 'object') return [];
  const grant = readEveAuthorityGrant(bag['commandEve.authority']);
  return readRememberedCommands(grant.rememberedCommands);
}

/**
 * The rung a legacy ACP mode corresponds to, or null.
 *
 * Deliberately reads its OWN map, not ENFORCED_LADDER_RUNGS: since rung 0 and
 * rung 1 both mirror `default`, iterating the rungs in order would resolve
 * `default` to rung 0 and silently DEMOTE anyone whose in-chat pill said "ask"
 * to the hard off-switch. The inverse of a non-injective map has to be written
 * down, not derived. Rungs with no mode of their own stay unreachable from a
 * mode string — which is correct: a mode cannot express them.
 */
const BACKEND_MODE_TO_LADDER: Readonly<Record<string, EveLadderRung>> = {
  default: 1,
  accept_edits: 2,
  dont_ask: 3,
};

export function ladderFromBackendMode(mode: string | null | undefined): EveLadderRung | null {
  return BACKEND_MODE_TO_LADDER[String(mode ?? '').trim()] ?? null;
}

/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Command EVE authority: one graduated grant, read identically by the start
 * screen and by a live session.
 *
 * THE INVARIANT — the human's grant is a CEILING, never a floor.
 *
 * `decideAuthority` may turn an allowed action into a question. It may NEVER turn
 * a disallowed action into an allowed one. That is what makes it safe to let the
 * ceiling go all the way up: the judgment layer can only ever spend LESS autonomy
 * than the human granted, so its worst possible bug is asking too often — never
 * doing something uncovered. `judgment_never_widens_a_grant` in the test file
 * proves it exhaustively rather than asserting it in prose.
 *
 * Everything here is pure. No IO, no config reads, no clock. The session and the
 * start screen both call these functions on the same stored record, which is why
 * they cannot drift apart.
 */

import type { EveRememberedCommand } from './eveRememberedCommandsCore';

/** How consequential an action is. Ordered: each rung of the ladder admits a prefix of this list. */
export type EveActionClass =
  | 'read'
  | 'workspace_edit'
  | 'workspace_command'
  | 'reversible_outside'
  | 'irreversible'
  /** Not classified by anyone. Never admitted by any rung — unknown is not harmless. */
  | 'unclassified';

/**
 * Capabilities no ladder rung ever grants, at any height, and which are also not
 * BOUND to a rung: each is its own switch, usable from rung 1 upward.
 *
 * Raising a rung is a convenience decision; unsealing one of these is a trust
 * decision. If money hung off rung 5, everyone who meant "just get on with it"
 * would silently also buy "and spend my money" — so they do not share a control.
 * And the converse matters just as much: "this card, fifty euros a day" is not a
 * statement about files, so it must not require rung 5 either.
 */
export type EveSealedCapability =
  | 'spend.money'
  | 'publish.outward'
  | 'delete.outside'
  | 'credentials.read'
  | 'deploy.production';

export const EVE_SEALED_CAPABILITIES: readonly EveSealedCapability[] = [
  'spend.money',
  'publish.outward',
  'delete.outside',
  'credentials.read',
  'deploy.production',
] as const;

/** 0 watch-only … 5 full (minus the sealed set). */
export type EveLadderRung = 0 | 1 | 2 | 3 | 4 | 5;

export const EVE_LADDER_RUNGS: readonly EveLadderRung[] = [0, 1, 2, 3, 4, 5] as const;

/** The highest action class each rung admits without asking. Index = rung. */
const RUNG_ADMITS: Readonly<Record<EveLadderRung, readonly EveActionClass[]>> = {
  0: ['read'],
  1: ['read'],
  2: ['read', 'workspace_edit'],
  3: ['read', 'workspace_edit', 'workspace_command'],
  4: ['read', 'workspace_edit', 'workspace_command', 'reversible_outside'],
  5: ['read', 'workspace_edit', 'workspace_command', 'reversible_outside', 'irreversible'],
};

/**
 * Rung 0 and rung 1 admit the same action classes on purpose. The difference is
 * not what EVE may do unasked — it is whether EVE may ask at all. Rung 0 means
 * "read and propose, do not offer to change anything"; rung 1 means "ask me".
 * `mayOfferToAct` carries that distinction so the UI does not have to guess.
 */
export function mayOfferToAct(rung: EveLadderRung): boolean {
  return rung >= 1;
}

export interface EveAuthorityGrant {
  ladder: EveLadderRung;
  /**
   * The literal commands this seat's human said EVE may always run.
   *
   * Lives on the grant so the whole approval posture of a seat is ONE record —
   * one thing to read, one thing to show, one thing to revoke. The seat's Hermes
   * `command_allowlist` is a projection of this, never the other way round.
   */
  rememberedCommands?: readonly EveRememberedCommand[];
  capabilities: Readonly<Partial<Record<EveSealedCapability, boolean>>>;
  /** ISO timestamp per capability, recording WHEN the human unsealed it. */
  grantedAt?: Readonly<Partial<Record<EveSealedCapability, string>>>;
  /**
   * Bounds that come WITH a seal. Today only money has one, because only money
   * has a natural unit. An unsealed `spend.money` without a limit here is refused
   * rather than treated as unlimited.
   */
  limits?: Readonly<{ 'spend.money'?: { dailyCents: number } }>;
  /** 'user' = a human chose this. 'migration' = derived from an older stored value. */
  updatedBy: 'user' | 'migration';
}

/** The fail-closed grant. Used whenever stored state is absent, unreadable or untrusted. */
export const EVE_AUTHORITY_FAIL_CLOSED: EveAuthorityGrant = {
  ladder: 1,
  capabilities: {},
  updatedBy: 'migration',
};

export interface EveAction {
  class: EveActionClass;
  /** Set when this action needs a sealed capability. The seal alone is the authority (rung 0 aside). */
  sealed?: EveSealedCapability;
  /** Short human-readable description, used in the escalation sentence. */
  description?: string;
  /** `spend.money` only: what this action costs, in cents. Absent = refused. */
  amountCents?: number;
  /** `spend.money` only: what today has already cost, in cents. */
  spentTodayCents?: number;
}

/**
 * Signals HG-3.5 weighs. All optional: an absent signal is never read as "fine",
 * it is simply not a reason to escalate on its own.
 */
export interface EveJudgmentSignals {
  /** The action touches a path outside the user's workspace. */
  outsideWorkspace?: boolean;
  /** A risk pattern matched (e.g. `rm -rf`, `osascript`). Carries the pattern name. */
  riskPattern?: string;
  /** First use of this sealed capability in this session. */
  firstSealedUseInSession?: boolean;
  /** The action does not correspond to what the user asked for (goal drift / injection). */
  offTask?: boolean;
  /** How many comparable actions happened in the last few seconds. */
  burstCount?: number;
}

/** Above this, a run stops looking like routine and starts looking like a mistake. */
export const BURST_ESCALATION_THRESHOLD = 10;

export type EveAuthorityDecision = 'allow' | 'ask';

export interface EveAuthorityOutcome {
  decision: EveAuthorityDecision;
  /**
   * Why, in one sentence, for the card. An escalation without a reason is an
   * imposition; the user cannot tell it apart from a bug.
   */
  reason: string;
  /** True when the grant covered this but judgment asked anyway. Never logged as an error. */
  escalated: boolean;
}

function capabilityGranted(grant: EveAuthorityGrant, capability: EveSealedCapability): boolean {
  return grant.capabilities[capability] === true;
}

/**
 * Does the stored grant alone cover this action?
 *
 * This is the ceiling, and the ONLY thing that can raise it is a human writing a
 * new grant. `decideAuthority` never calls anything that could make this true.
 */
export function grantAllows(action: EveAction, grant: EveAuthorityGrant): boolean {
  // Unknown is not harmless. Nothing admits it, at any rung, ever.
  if (action.class === 'unclassified') return false;

  // Rung 0 is the hard off-switch: "change nothing" would contradict itself if an
  // open seal could still act through it. Every other rung leaves the seals alone.
  if (grant.ladder === 0) return action.class === 'read';

  if (action.sealed) {
    // A seal is its OWN decision, not the crown of the ladder. "This card, fifty
    // euros a day" says nothing about files: someone may keep EVE cautious about
    // everything else and still hand it a budget. So the rung does not also have
    // to admit the class — the human unsealing it IS the authority.
    if (!capabilityGranted(grant, action.sealed)) return false;
    if (action.sealed === 'spend.money') return spendWithinDailyLimit(action, grant);
    return true;
  }

  return RUNG_ADMITS[grant.ladder]?.includes(action.class) === true;
}

/**
 * Money is the one seal that is not a boolean. An unsealed `spend.money` without
 * an amount would be a blank cheque, so the grant carries a daily ceiling and the
 * action carries what it costs plus what today has already cost.
 *
 * Every uncertainty resolves to "no": no limit configured, an unknown price, a
 * negative or non-finite number, or a total that would cross the ceiling.
 */
function spendWithinDailyLimit(action: EveAction, grant: EveAuthorityGrant): boolean {
  const dailyCents = grant.limits?.['spend.money']?.dailyCents;
  if (typeof dailyCents !== 'number' || !Number.isFinite(dailyCents) || dailyCents <= 0) return false;
  const cost = action.amountCents;
  if (typeof cost !== 'number' || !Number.isFinite(cost) || cost < 0) return false;
  const spent = action.spentTodayCents ?? 0;
  if (!Number.isFinite(spent) || spent < 0) return false;
  return spent + cost <= dailyCents;
}

/**
 * Why HG-3.5 would ask even though the grant covers this — or null to proceed.
 * Pure and side-effect free so it can be reasoned about and tested directly.
 */
export function escalationReason(action: EveAction, signals: EveJudgmentSignals | undefined): string | null {
  if (!signals) return null;
  if (signals.offTask) {
    return 'Diese Aktion gehört nicht zu dem, worum du gebeten hast — ich frage lieber nach.';
  }
  if (signals.riskPattern) {
    return `Der Befehl enthält ein Muster, das ich nicht ungefragt ausführe (${signals.riskPattern}).`;
  }
  if (signals.outsideWorkspace && action.class !== 'read') {
    return 'Ich dürfte das, aber der Pfad liegt außerhalb deines Projekts.';
  }
  if (action.sealed && signals.firstSealedUseInSession) {
    return 'Du hast das freigegeben — ich frage trotzdem einmal pro Sitzung nach, bevor ich es benutze.';
  }
  if ((signals.burstCount ?? 0) > BURST_ESCALATION_THRESHOLD) {
    return `Das wäre die ${signals.burstCount}. gleichartige Aktion in kurzer Zeit — das sieht nicht mehr nach Routine aus.`;
  }
  return null;
}

/**
 * The single decision point. Structured so the invariant holds BY CONSTRUCTION,
 * not by care: the only `return 'allow'` in this function sits behind
 * `grantAllows`, and nothing after it can reach that branch.
 */
export function decideAuthority(
  action: EveAction,
  grant: EveAuthorityGrant,
  signals?: EveJudgmentSignals
): EveAuthorityOutcome {
  if (!grantAllows(action, grant)) {
    return {
      decision: 'ask',
      reason:
        action.class === 'unclassified'
          ? 'Ich kann diese Aktion nicht einordnen — deshalb frage ich.'
          : 'Dafür hast du mir keine Freigabe erteilt.',
      escalated: false,
    };
  }
  const reason = escalationReason(action, signals);
  if (reason) return { decision: 'ask', reason, escalated: true };
  return { decision: 'allow', reason: '', escalated: false };
}

/**
 * Map a legacy `preferredMode` string onto a rung.
 *
 * A migrated grant NEVER unseals a capability: nobody consented to that, and a
 * value restored from disk is input, never authority. Unknown values land on
 * rung 1 rather than being guessed upward.
 */
export function ladderFromLegacyMode(mode: string | null | undefined): EveLadderRung {
  switch (String(mode ?? '').trim()) {
    case 'read-only':
    case 'plan':
      return 0;
    case 'accept_edits':
    case 'accept-edits':
    case 'auto_edits':
    case 'auto-edits':
      return 2;
    case 'dont_ask':
    case 'dont-ask':
    case 'auto':
      return 3;
    case 'yolo':
    case 'yoloNoSandbox':
    case 'bypassPermissions':
    case 'full-access':
      // Deliberately 4, not 5. The legacy "yolo" values predate the sealed set,
      // so their holders never decided anything about irreversible actions.
      // Rung 5 has to be chosen, not inherited.
      return 4;
    default:
      return 1;
  }
}

export function migrateLegacyGrant(mode: string | null | undefined): EveAuthorityGrant {
  return { ladder: ladderFromLegacyMode(mode), capabilities: {}, updatedBy: 'migration' };
}

/** Runtime guard. Anything unrecognised fails closed rather than being repaired. */
export function isEveAuthorityGrant(value: unknown): value is EveAuthorityGrant {
  if (!value || typeof value !== 'object') return false;
  const candidate = value as Partial<EveAuthorityGrant>;
  if (!EVE_LADDER_RUNGS.includes(candidate.ladder as EveLadderRung)) return false;
  if (candidate.updatedBy !== 'user' && candidate.updatedBy !== 'migration') return false;
  const capabilities = candidate.capabilities;
  if (!capabilities || typeof capabilities !== 'object') return false;
  for (const [key, flag] of Object.entries(capabilities)) {
    if (!EVE_SEALED_CAPABILITIES.includes(key as EveSealedCapability)) return false;
    if (typeof flag !== 'boolean') return false;
  }
  if (candidate.rememberedCommands !== undefined && !Array.isArray(candidate.rememberedCommands)) return false;
  // Individual rows are NOT validated here on purpose. `readRememberedCommands`
  // drops anything unusable, and BOTH readers of this field — the Freigaben list
  // and the config.yaml projection — go through it, so they always agree.
  //
  // The first cut rejected the entire grant when one row failed. That was
  // collateral, not safety: a single hand-edited line would silently reset the
  // human's LADDER to fail-closed as well. Losing a grant nobody revoked is its
  // own defect.
  const limits = candidate.limits;
  if (limits !== undefined) {
    if (!limits || typeof limits !== 'object') return false;
    for (const [key, bound] of Object.entries(limits)) {
      if (key !== 'spend.money') return false;
      const daily = (bound as { dailyCents?: unknown } | null)?.dailyCents;
      if (typeof daily !== 'number' || !Number.isFinite(daily) || daily <= 0) return false;
    }
  }
  return true;
}

export function readEveAuthorityGrant(value: unknown): EveAuthorityGrant {
  return isEveAuthorityGrant(value) ? value : EVE_AUTHORITY_FAIL_CLOSED;
}

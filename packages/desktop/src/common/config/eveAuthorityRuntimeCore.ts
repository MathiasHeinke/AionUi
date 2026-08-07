/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * The seat's grant, rendered into the few booleans the Hermes-side approval
 * patch is allowed to obey — and rendered by asking `grantAllows`, never by
 * re-deciding anything here.
 *
 * WHY THIS FILE EXISTS. `decideAuthority`/`grantAllows` were built, tested and
 * then never called by production code, so the product fell back to "always
 * ask" and the whole ladder above rung 3 stored a preference and changed
 * nothing. The fix is not to teach Python the policy — it is to make the
 * EXISTING decision function the one that answers, and to hand the answers
 * across the process boundary as data.
 *
 * So the split is deliberate and load-bearing:
 *   - TypeScript DECIDES (every field below comes out of `grantAllows`),
 *   - the emitted patch OBEYS (it reads booleans; it contains no rung numbers,
 *     no thresholds, and no second copy of the ladder).
 *
 * That is what keeps the two ends from drifting: there is only one place where
 * a rung means anything.
 */

import {
  EVE_SEALED_CAPABILITIES,
  grantAllows,
  type EveAuthorityGrant,
  type EveSealedCapability,
} from './eveAuthorityCore';

/**
 * The wheel's edit-approval vocabulary (whl:acp_adapter/edit_approval.py:200
 * `should_auto_approve_edit`):
 *   - `ask`               always prompt,
 *   - `workspace_session` auto-approve only under the session cwd (+ the real
 *                         temp dir); sensitive paths still prompt,
 *   - `session`           auto-approve anywhere.
 * These three are exactly the distinction the ladder already draws between
 * `workspace_edit` and `reversible_outside`, which is why the mapping below is
 * a lookup and not a judgement.
 */
export type EveEditApprovalPolicy = 'ask' | 'workspace_session' | 'session';

/** What the approval patch is handed. Booleans only — no policy, no numbers to compare. */
export interface EveAuthorityRuntime {
  /** Present for the receipt/diagnostics only. Nothing in the patch branches on it. */
  ladder: number;
  edit_policy: EveEditApprovalPolicy;
  /** A terminal command inside the session's working folder may run unasked. */
  workspace_command: boolean;
  /** …and outside it. */
  outside_workspace_command: boolean;
  /** Irreversible actions may run unasked (rung 5). */
  irreversible: boolean;
  /**
   * Per seal: may EVE use it unasked right now? `spend.money` is false unless a
   * usable daily ceiling exists — an open seal without a budget is refused, not
   * read as unlimited (`spendWithinDailyLimit`).
   */
  seals: Record<EveSealedCapability, boolean>;
  /** The ceiling, for display and for the daily accounting. 0 = none configured. */
  spend_daily_cents: number;
}

/**
 * Probe a seal WITHOUT accidentally riding rung 0's read exemption.
 *
 * `grantAllows` short-circuits rung 0 to "reads only" BEFORE it looks at the
 * seal, so probing with `class: 'read'` would report every open seal as usable
 * on the hard off-switch. Probing with `irreversible` cannot: rung 0 rejects it
 * outright, every other rung falls through to the seal branch, and the seal —
 * not the rung — decides. Rung 0 therefore closes everything, which is what
 * "change nothing" has to mean.
 *
 * `amountCents: 0` is the cheapest honest money probe: it asks "is there a
 * ceiling at all", because a zero-cost spend still fails `spendWithinDailyLimit`
 * when `dailyCents` is missing, zero or malformed.
 */
function sealUsable(grant: EveAuthorityGrant, capability: EveSealedCapability): boolean {
  return grantAllows({ class: 'irreversible', sealed: capability, amountCents: 0 }, grant);
}

/**
 * Render the grant for the Hermes side. EVERY field is an answer from
 * `grantAllows` — this function contains no rung literal on purpose.
 */
export function renderEveAuthorityRuntime(grant: EveAuthorityGrant): EveAuthorityRuntime {
  const editsInWorkspace = grantAllows({ class: 'workspace_edit' }, grant);
  const editsOutside = grantAllows({ class: 'reversible_outside' }, grant);
  const seals = Object.fromEntries(
    EVE_SEALED_CAPABILITIES.map((capability) => [capability, sealUsable(grant, capability)])
  ) as Record<EveSealedCapability, boolean>;
  return {
    ladder: grant.ladder,
    edit_policy: editsOutside ? 'session' : editsInWorkspace ? 'workspace_session' : 'ask',
    workspace_command: grantAllows({ class: 'workspace_command' }, grant),
    outside_workspace_command: editsOutside,
    irreversible: grantAllows({ class: 'irreversible' }, grant),
    seals,
    spend_daily_cents: seals['spend.money'] ? (grant.limits?.['spend.money']?.dailyCents ?? 0) : 0,
  };
}

/**
 * Which seal a shell command would spend, or null.
 *
 * CONSERVATIVE BY CONSTRUCTION, and it has to be: this runs at the moment the
 * ladder would otherwise let a command through unasked, so a miss here is a
 * sealed capability spent without anyone deciding to. Every pattern below is
 * therefore broad, and anything it recognises falls back to asking unless that
 * exact seal is open.
 *
 * It is NOT a security boundary and must never be described as one — a
 * determined command can be spelled around any list of substrings. It is the
 * "do not let the everyday convenience setting quietly buy something else"
 * layer: the seals stay separate from the ladder, which is the whole reason
 * they are not rung 6.
 */
export function sealImplicatedByCommand(command: string): EveSealedCapability | null {
  const text = String(command ?? '').toLowerCase();
  if (!text.trim()) return null;
  // Money: anything that buys, tops up, or charges.
  if (/\b(stripe|checkout|purchase|billing)\b/.test(text)) return 'spend.money';
  // Outward publishing: it leaves this machine and other people can see it.
  if (/\b(npm|pnpm|yarn|bun)\s+publish\b/.test(text)) return 'publish.outward';
  if (/\bgit\s+push\b/.test(text)) return 'publish.outward';
  if (/\b(gh|hub)\s+(pr|release)\s+create\b/.test(text)) return 'publish.outward';
  if (/\btwine\s+upload\b/.test(text)) return 'publish.outward';
  // Production deploys.
  if (/\b(vercel|netlify|fly|heroku|wrangler)\s+deploy\b/.test(text)) return 'deploy.production';
  if (/\b(kubectl|helm)\b/.test(text)) return 'deploy.production';
  if (/\bsupabase\s+db\s+push\b/.test(text)) return 'deploy.production';
  // Credentials: reading them is the spend, not writing them.
  if (/(^|[\s;&|])(cat|less|more|head|tail|bat|strings)\s+[^\n;|&]*(\.env|\.npmrc|id_rsa|credentials|\.pem)/.test(text))
    return 'credentials.read';
  if (/\b(security\s+find-generic-password|keychain|gpg\s+--decrypt)\b/.test(text)) return 'credentials.read';
  // Deletion outside the working folder. `rm` alone is workspace_command; an
  // absolute or home-rooted target is the thing that is not.
  if (/\brm\s+(-[^\s]*\s+)*(~|\/)/.test(text)) return 'delete.outside';
  return null;
}

export type EveCommandApprovalVerdict = 'allow' | 'ask';

/**
 * The one decision the approval patch delegates back: may this terminal command
 * run without a card?
 *
 * Ordered so the answer can only ever narrow:
 *   1. an implicated seal must be OPEN — and it beats every rung, including 5;
 *   2. otherwise the rung's command class decides, split by where the command runs.
 *
 * Anything unresolved is `ask`. There is deliberately no branch that returns
 * `allow` for a reason other than these two.
 */
export function decideCommandApproval(
  input: { command: string; insideWorkspace: boolean },
  runtime: EveAuthorityRuntime
): EveCommandApprovalVerdict {
  const seal = sealImplicatedByCommand(input.command);
  if (seal) return runtime.seals[seal] === true ? 'allow' : 'ask';
  if (!input.insideWorkspace) return runtime.outside_workspace_command ? 'allow' : 'ask';
  return runtime.workspace_command ? 'allow' : 'ask';
}

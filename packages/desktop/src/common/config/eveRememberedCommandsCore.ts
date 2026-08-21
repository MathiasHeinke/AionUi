/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Historical remembered-command records, retained per seat for the settings
 * migration and user-visible revoke path.
 *
 * Hermes has TWO grant units in one config list, and the dangerous one is what
 * its own "always" button writes. `detect_dangerous_command` sets
 * `pattern_key = description`, so `approve_permanent` stores the NAME OF A REGEX
 * CATEGORY: one click on `rm /tmp/picture.png` permanently grants "delete in
 * root path", across sessions, for every command that category matches. That is
 * the grant the 1.820 C0 containment revokes on every boot, correctly.
 *
 * The record is intentionally no longer projected into Hermes'
 * `command_allowlist`. Existing persisted rows remain readable and revocable, but
 * native ACP is the only runtime authority.
 */

/**
 * Mirrors `_ALLOWLIST_SHELL_OPERATOR_RE` in the bundled wheel
 * (tools/approval.py). Historical records still reject those commands so the
 * retained settings data preserves its prior validity rules.
 *
 * MIRRORED CONSTANT — re-check this against the wheel on every Hermes bump.
 * `eveRememberedCommandsCore.test.ts` pins the exact source pattern.
 */
const SHELL_OPERATOR_RE = /(?:\n|&&|\|\||[;&|<>`]|\$\()/;

/** Longer than this is not a command a human can review in a list. */
export const MAX_REMEMBERED_COMMAND_LENGTH = 300;

export interface EveRememberedCommand {
  /** The literal command text, exactly as it was approved. Never a pattern. */
  command: string;
  /** When the human granted it. A grant with no date cannot be reviewed later. */
  grantedAt: string;
}

export type RememberVerdict =
  | 'ok'
  /** Empty or whitespace only. */
  | 'empty'
  /** Contains a shell operator: Hermes could never match it, so we do not pretend. */
  | 'compound'
  /** Too long to be reviewable in a list of grants. */
  | 'too-long'
  /** Contains a glob character: we store literals only, so the scope stays legible. */
  | 'pattern'
  /** Already remembered. */
  | 'duplicate';

/**
 * May this command be remembered?
 *
 * Deliberately literal-only. A glob is a grant whose scope the user cannot see
 * at the moment of granting — `podman *` reads as one line and covers every
 * podman invocation there will ever be. If globs are ever wanted they should be
 * their own feature, typed deliberately, not something a permission card can
 * produce as a side effect of one click.
 */
export function classifyRememberCandidate(
  command: string,
  existing: readonly EveRememberedCommand[] = []
): RememberVerdict {
  const value = (command ?? '').trim();
  if (!value) return 'empty';
  if (value.length > MAX_REMEMBERED_COMMAND_LENGTH) return 'too-long';
  if (SHELL_OPERATOR_RE.test(value)) return 'compound';
  if (/[*?[\]]/.test(value)) return 'pattern';
  if (existing.some((entry) => entry.command === value)) return 'duplicate';
  return 'ok';
}

/** True when this command may be offered a "remember this" option at all. */
export function canOfferRemember(command: string, existing: readonly EveRememberedCommand[] = []): boolean {
  const verdict = classifyRememberCandidate(command, existing);
  return verdict === 'ok' || verdict === 'duplicate';
}

/**
 * Add a historical record. Rejected candidates leave the list untouched rather
 * than being repaired into something adjacent.
 */
export function rememberCommand(
  existing: readonly EveRememberedCommand[],
  command: string,
  now: string
): readonly EveRememberedCommand[] {
  if (classifyRememberCandidate(command, existing) !== 'ok') return existing;
  return [...existing, { command: command.trim(), grantedAt: now }];
}

/** Withdraw one grant. Unknown entries are a no-op, never an error. */
export function forgetCommand(
  existing: readonly EveRememberedCommand[],
  command: string
): readonly EveRememberedCommand[] {
  const value = (command ?? '').trim();
  return existing.filter((entry) => entry.command !== value);
}

/** Runtime guard for the stored list. One bad row discards only that row. */
export function readRememberedCommands(value: unknown): readonly EveRememberedCommand[] {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  const rows: EveRememberedCommand[] = [];
  for (const raw of value) {
    if (!raw || typeof raw !== 'object') continue;
    const entry = raw as Partial<EveRememberedCommand>;
    const command = typeof entry.command === 'string' ? entry.command.trim() : '';
    const grantedAt = typeof entry.grantedAt === 'string' ? entry.grantedAt : '';
    if (!command || !grantedAt) continue;
    // Re-apply the same rules on read. A row that got into the store by another
    // route — a hand-edited file, an older build — is not trusted just because
    // it is already there.
    if (SHELL_OPERATOR_RE.test(command)) continue;
    if (/[*?[\]]/.test(command)) continue;
    if (command.length > MAX_REMEMBERED_COMMAND_LENGTH) continue;
    if (seen.has(command)) continue;
    seen.add(command);
    rows.push({ command, grantedAt });
  }
  return rows;
}

/**
 * Tokens that mean "this answer lets the command run". Everything else — and
 * anything unrecognised — is treated as a refusal.
 *
 * Deliberately an allowlist. A remember triggered by a DENY would be the worst
 * possible bug in this feature: the human says no and EVE writes a standing yes.
 * So an option id nobody anticipated must fall on the refusal side.
 */
const ALLOW_ANSWER_TOKENS = new Set([
  'allow',
  'allow_once',
  'allow_session',
  'allow_for_session',
  'allow_current_session',
  'proceed',
  'proceed_once',
  'proceed_session',
  'session_allow',
]);

/** May this answer trigger a "remember this command" write at all? */
export function answerAllowsExecution(optionId: string | null | undefined): boolean {
  const token = String(optionId ?? '')
    .trim()
    .toLowerCase()
    .replace(/[\s-]+/g, '_');
  if (!token) return false;
  if (token.includes('deny') || token.includes('reject') || token.includes('cancel') || token.includes('never')) {
    return false;
  }
  return ALLOW_ANSWER_TOKENS.has(token);
}

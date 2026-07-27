/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * "You may always do this" — remembered per seat, narrow enough to read.
 *
 * Hermes has TWO grant units in one config list, and the dangerous one is what
 * its own "always" button writes. `detect_dangerous_command` sets
 * `pattern_key = description`, so `approve_permanent` stores the NAME OF A REGEX
 * CATEGORY: one click on `rm /tmp/picture.png` permanently grants "delete in
 * root path", across sessions, for every command that category matches. That is
 * the grant the 1.820 C0 containment revokes on every boot, correctly.
 *
 * The narrow unit already exists next to it and is simply never used:
 * `_command_matches_permanent_allowlist` compares the LITERAL command text (or an
 * explicit glob) and runs BEFORE any danger check. So we do not press Hermes'
 * button — we write the literal entries ourselves, from a record the desktop
 * owns.
 *
 * The consequences are the point:
 *   - Hermes asks once and then stops asking, because its own allowlist hits.
 *   - The record is per seat, so one client's grant never reaches another's.
 *   - config.yaml is a PROJECTION of the record, so revoking is deleting a row —
 *     and a grant the human cannot withdraw is not a grant, it is a leak.
 *   - A category-wide entry can never appear, because nothing here can write one.
 */

/**
 * Mirrors `_ALLOWLIST_SHELL_OPERATOR_RE` in the bundled wheel
 * (tools/approval.py). A command containing any of these can NEVER match the
 * allowlist, so remembering it would be a promise that is silently never kept:
 * the user would click "always" and keep being asked.
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
 * Add a grant. Rejected candidates leave the list untouched rather than being
 * repaired into something adjacent — a command nobody approved must never end up
 * in the allowlist because it looked close enough to one that was.
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
 * The `command_allowlist` block for a seat's generated config.yaml.
 *
 * An empty record yields `command_allowlist: []` — byte-identical to what the C0
 * containment emits today. That is deliberate: with nothing granted, this change
 * is a no-op, and every legacy category-wide entry keeps getting revoked exactly
 * as before.
 */
export function buildCommandAllowlistYaml(entries: readonly EveRememberedCommand[]): string[] {
  const rows = readRememberedCommands(entries);
  if (rows.length === 0) return ['command_allowlist: []'];
  return ['command_allowlist:', ...rows.map((entry) => `  - ${JSON.stringify(entry.command)}`)];
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

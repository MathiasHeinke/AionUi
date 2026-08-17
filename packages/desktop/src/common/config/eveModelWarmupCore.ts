/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Single owner of the local model warm-up skip classification.
 *
 * A warm-up may end in `skipped` for two fundamentally different reasons, and
 * the product must not treat them alike: a DELIBERATE opt-out (env kill switch
 * or the user's own setting) genuinely means "there is nothing to warm and the
 * send may proceed", while an UNREADY runtime means the local model is not
 * usable at all. Reading the latter as success moved the failure to the send
 * itself and destroyed the actionable BLOCKED_RAM/BLOCKED_DISK cause on the way.
 *
 * Main and renderer both consume this module so the rule has exactly one owner.
 */

export type CommandEveModelWarmupSkipReason = 'disabled_by_env' | 'disabled_by_user' | 'runtime_not_ready';

/** Warm-up receipt projection both processes can supply (main: local receipt, renderer: IPC payload). */
type CommandEveModelWarmupOutcome = {
  status?: string;
  skip_reason?: string;
};

/**
 * True only for a skip the operator (or an explicit env kill switch) asked for.
 *
 * Fail-closed on an absent reason: an unlabeled skip cannot prove it was
 * deliberate, and the whole point of the classification is that an unexplained
 * skip must never read as readiness.
 */
export function commandEveWarmupSkipIsDeliberate(skipReason: string | undefined): boolean {
  return skipReason === 'disabled_by_env' || skipReason === 'disabled_by_user';
}

/** True when this warm-up outcome permits a local send. */
export function commandEveWarmupPermitsLocalSend(warmup: CommandEveModelWarmupOutcome | undefined): boolean {
  if (!warmup) return false;
  if (warmup.status === 'ready') return true;
  if (warmup.status !== 'skipped') return false;
  return commandEveWarmupSkipIsDeliberate(warmup.skip_reason);
}

/** Runtime stage projection carrying the fail-closed reason code the bootstrap recorded. */
type CommandEveWarmupBlockerStage = {
  id: string;
  status: string;
  code?: string;
  detail?: string;
};

/**
 * Stages that gate the LOCAL model specifically. A blocked capacity/runtime/model
 * stage is what carries the real, user-facing cause (BLOCKED_RAM, BLOCKED_DISK,
 * OLLAMA_MISSING, MODEL_NOT_FETCHED).
 */
const LOCAL_MODEL_STAGE_IDS: ReadonlySet<string> = new Set(['capacity', 'ollama', 'model']);

/**
 * The concrete reason the local model is unavailable, taken from the bootstrap's
 * own stage record rather than restated as a generic sentence.
 *
 * Only stages carrying an explicit reason code count: a managed provider's
 * normal `ollama: skip` is expected and must not be reported as a blocker.
 */
export function describeCommandEveWarmupBlocker(
  stages: ReadonlyArray<CommandEveWarmupBlockerStage> | undefined
): string | undefined {
  const blocker = stages?.find(
    (stage) => LOCAL_MODEL_STAGE_IDS.has(stage.id) && stage.status !== 'pass' && Boolean(stage.code)
  );
  if (!blocker) return undefined;
  const detail = blocker.detail?.trim();
  return detail ? `${blocker.code}: ${detail}` : blocker.code;
}

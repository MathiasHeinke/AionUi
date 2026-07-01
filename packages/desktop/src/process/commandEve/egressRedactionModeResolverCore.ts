/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * S11 — THE PII/DSGVO EGRESS SWITCH. The per-seat egress-redaction-mode resolver
 * the Ollama shim calls PER cloud request to decide whether the PII/DSGVO
 * redactor runs before the payload leaves the machine.
 *
 * WHY IT LIVES HERE (the store-split lesson, applied): the settings card writes
 * `commandEve.egressRedactionMode` via the renderer's `configService.set` → the
 * aioncore BACKEND settings store (`/api/settings/client`), NOT the main-process
 * ProcessConfig JSON. A main-process read of that key from ProcessConfig would be
 * the exact "silently dead control" bug the store-split guard exists to prevent.
 * So this reads FRESH from the backend batch reader (seat-scoped-aware) on every
 * request — a toggle flip takes effect on the very next turn, no cache-warm grace.
 *
 * FAIL-DIRECTION (decided, spec #1) — DIFFERENT from the money bug:
 *   Privacy is fail-SAFE. Any read error resolves to `'on'` (ALWAYS redact). There
 *   is NO last-known-good: the safe direction is always redact. The money resolver
 *   holds a last-known-good roster because there "fail-safe" means "don't resurrect
 *   a fired worker"; here "fail-safe" means "never leak PII", so a backend hiccup
 *   must NEVER flip the filter off. A conscious `'off'` is honored ONLY when the
 *   backend read succeeds AND explicitly returns `'off'`.
 *
 * Values: `'on'` | `'off'`; absent ⇒ `'on'`; any non-`'off'` string ⇒ `'on'`.
 *
 * PURE + injectable: the backend read is injected so the whole fresh-read +
 * fail-safe decision is unit-testable against a mocked backend, WITHOUT importing
 * the electron-heavy main entry. index.ts wires the real
 * `readCommandEveSettingsFromBackend` in.
 */

export type CommandEveEgressRedactionMode = 'on' | 'off';

const EGRESS_REDACTION_MODE_KEY = 'commandEve.egressRedactionMode';

/** Injected backend batch read (real one: readCommandEveSettingsFromBackend). */
export type CommandEveSettingsBatchReader = (
  logicalKeys: readonly string[]
) => Promise<Record<string, unknown>>;

/**
 * Normalize a raw persisted value to the mode. FAIL-SAFE: only the exact string
 * `'off'` turns the filter off; everything else (absent, `'on'`, a typo, a
 * non-string) is `'on'` (redact). A control-waiver must be an explicit, correct
 * `'off'` — never an accident.
 */
export function normalizeEgressRedactionMode(raw: unknown): CommandEveEgressRedactionMode {
  return raw === 'off' ? 'off' : 'on';
}

/**
 * Build the per-request egress-redaction-mode resolver. Returns an async resolver
 * the shim awaits before it decides whether to redact.
 *
 * @param readSettings the backend batch reader (injected for testability).
 * @param onError optional side-channel for logging (index.ts passes console.warn).
 */
export function createEgressRedactionModeResolver(
  readSettings: CommandEveSettingsBatchReader,
  onError?: (error: unknown) => void
): () => Promise<CommandEveEgressRedactionMode> {
  return async () => {
    try {
      const bag = await readSettings([EGRESS_REDACTION_MODE_KEY]);
      return normalizeEgressRedactionMode(bag[EGRESS_REDACTION_MODE_KEY]);
    } catch (error) {
      // FAIL-SAFE: a backend hiccup ALWAYS redacts. No last-known-good — the safe
      // privacy direction is redact, and a transient error must never leak PII.
      onError?.(error);
      return 'on';
    }
  };
}

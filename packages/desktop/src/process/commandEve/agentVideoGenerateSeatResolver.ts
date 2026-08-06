/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * CEVE-18205-FLAG — the PER-SEAT release for agent-initiated video generation.
 *
 * WHAT THIS REPLACES. The first slice gated the tool on an env var plus licence
 * eligibility. That is not a per-seat release: an env var is a property of the
 * PROCESS, so every seat an operator runs out of one install inherited the same
 * answer. For a switch that spends a client's credits, "the founder turned it on
 * once" must never mean "every client seat can spend".
 *
 * WHERE THE VALUE LIVES, and why this module exists at all: the operator flips
 * this in the UI, so it is persisted by the renderer's `configService.set` into
 * the aioncore BACKEND settings store (`/api/settings/client`) — NOT the
 * main-process `ProcessConfig` JSON. A main-process `ProcessConfig.get` of this
 * key would return `undefined` forever and the control would be silently dead:
 * the exact store-split bug `inferenceSelectionBackendRead.ts` was written to
 * fix and the store-split guard exists to catch. So this reads FRESH from the
 * backend batch reader on every request — a flip takes effect on the next call,
 * with no cache-warm grace.
 *
 * FAIL-DIRECTION: FAIL-CLOSED, and harder than the privacy resolver's.
 *
 *   `egressRedactionModeResolverCore.ts` fail-SAFEs to `'on'` because the safe
 *   privacy direction is "always redact". Here the safe direction is "never
 *   spend", so EVERY uncertainty resolves to OFF: an absent key, a malformed
 *   value, a backend that will not answer, a thrown read. There is deliberately
 *   NO last-known-good — the money resolver next door holds one so a hiccup
 *   cannot resurrect a fired worker, but holding one HERE would mean a backend
 *   outage keeps a spending tool open on a seat whose current answer we cannot
 *   read. A hiccup must close the tool, never open it.
 *
 *   Concretely: only `true`, `'true'`, `1` and `'1'` enable. A `'yes'`, an
 *   `'on'`, a `{}` or a `'TRUE'` do not. A spending switch that accepts several
 *   spellings is one that gets turned on by accident.
 *
 * SEAT ISOLATION comes from two edits outside this file, and both are load-bearing:
 *   - `seatConfigKeyCore.ts` lists the key in `SEAT_SCOPED_CONFIG_KEYS`, so the
 *     renderer persists and Main reads the seat-physical key;
 *   - `commandEveBackendSettingsRead.ts` lists it in `NO_LEGACY_INHERIT_KEYS`, so
 *     a real seat with no value of its own does NOT inherit the founder/legacy
 *     row. Without that second edit the isolation is fail-OPEN in the worst way:
 *     a fresh client seat would silently inherit a founder `true` and could spend.
 *
 * PURE + injectable: the backend read, the env kill-switch and the licence check
 * are all injected, so the whole decision is unit-testable without importing the
 * electron-heavy main entry.
 */

/** The logical config key. Seat-scoped + no-legacy-inherit (see module docstring). */
export const AGENT_VIDEO_GENERATE_SEAT_CONFIG_KEY = 'commandEve.agentVideoGenerateEnabled';

/** Injected backend batch read (real one: readCommandEveSettingsFromBackend). */
export type CommandEveSettingsBatchReader = (logicalKeys: readonly string[]) => Promise<Record<string, unknown>>;

/**
 * Normalize a raw persisted value to the release decision. FAIL-CLOSED: exactly
 * `true` / `'true'` / `1` / `'1'` enable; everything else — absent, `null`,
 * `'yes'`, `'on'`, `'TRUE'`, `2`, `{}`, `[]` — is OFF.
 *
 * The accepted set is deliberately tiny and exact. A checkbox persists a real
 * boolean; the string and numeric forms are here only because a JSON round-trip
 * or an older writer can produce them. Anything beyond that is a value nobody
 * meant as consent.
 */
export function normalizeAgentVideoGenerateSeatValue(raw: unknown): boolean {
  if (raw === true || raw === 1) return true;
  if (raw === 'true' || raw === '1') return true;
  return false;
}

/**
 * Build the per-seat resolver: one fresh backend read, normalized fail-closed.
 *
 * @param readSettings the backend batch reader (injected for testability).
 * @param onError optional side-channel for logging.
 */
export function createAgentVideoGenerateSeatResolver(
  readSettings: CommandEveSettingsBatchReader,
  onError?: (error: unknown) => void
): () => Promise<boolean> {
  return async () => {
    try {
      const bag = await readSettings([AGENT_VIDEO_GENERATE_SEAT_CONFIG_KEY]);
      return normalizeAgentVideoGenerateSeatValue(bag[AGENT_VIDEO_GENERATE_SEAT_CONFIG_KEY]);
    } catch (error) {
      // FAIL-CLOSED. No last-known-good: a backend we cannot reach is a seat
      // whose consent we cannot read, and an unreadable consent is not consent.
      onError?.(error);
      return false;
    }
  };
}

export interface AgentVideoGenerateGateDeps {
  /** The per-seat release (this module's resolver, or a stub in tests). */
  readSeatRelease: () => Promise<boolean>;
  /**
   * The GLOBAL kill-switch: true when `COMMAND_EVE_ENABLE_AGENT_VIDEO_GENERATE`
   * is exactly `'0'`. An emergency off that does not require touching any seat's
   * config or deleting credentials.
   */
  isKillSwitched: () => boolean;
  /** True iff this seat's CEVE licence wire is present and readable. */
  isLicenseEligible: () => boolean;
  onError?: (error: unknown) => void;
}

/**
 * THE composed decision, in one place, so the loopback gate and the emitted
 * child env cannot drift apart about what a seat may do.
 *
 * Three conditions, all required, evaluated cheapest-first so a kill-switched or
 * ineligible seat never issues an HTTP read it cannot act on:
 *
 *   1. NOT globally kill-switched (`…=0`);
 *   2. licence-eligible — a seat that cannot pay is never told about a paid tool,
 *      whatever its config says;
 *   3. the PER-SEAT config says yes.
 *
 * WHAT IS DELIBERATELY *NOT* REQUIRED: an env `'1'`. The env keeps only its
 * kill-switch role. Requiring `'1'` as well would mean an operator who ticks the
 * box in the UI gets nothing, with no feedback and no way to tell a closed seat
 * from a broken one — a second silently-dead control, which is the failure this
 * whole store-split lineage exists to prevent. The per-seat config is the
 * authority; the env can only ever take that authority away, never grant it.
 */
export function createAgentVideoGenerateGate(deps: AgentVideoGenerateGateDeps): () => Promise<boolean> {
  return async () => {
    try {
      if (deps.isKillSwitched()) return false;
      if (!deps.isLicenseEligible()) return false;
      return await deps.readSeatRelease();
    } catch (error) {
      // A throw from the env read or the licence read lands here too. Same
      // direction as everything else in this file.
      deps.onError?.(error);
      return false;
    }
  };
}

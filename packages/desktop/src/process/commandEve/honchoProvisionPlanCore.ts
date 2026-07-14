/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Command EVE HONCHO PROVISION PLAN core (1.7.0 / COMPA-624 Inc.3 / P1 — the PURE
 * provisioning decision).
 *
 * Given the DETECTED machine state + the user's CONSENT state + the mode + the
 * Inc.1 per-seat config, it decides: should Honcho be provisioned+run for this
 * seat (`honchoEnabled`), and if so, the ORDERED install steps (with which steps
 * are already satisfied + which need explicit user consent). If not, a truthful
 * `skipReason`.
 *
 * FAIL-SAFE / NO FALSE READINESS (founder): Honcho is OPTIONAL. EVERY reason to
 * not run it (mode off, memory not opted-in, a missing dep the user declined, no
 * disk, no deriver credential) yields `honchoEnabled:false` + a skip reason —
 * NEVER a hard error and NEVER a block. The caller maps every such miss to the
 * bootstrap 'skip' status (honchoMissStatus), so the runtime receipt stays 'ready'
 * and first value is never blocked; memory simply falls back to Company Brain +
 * MEMORY.md. PURE: no fs/net/spawn — deterministic decision only.
 */

import { HONCHO_REASON_DECLINED, HONCHO_REASON_DEP_MISSING } from './honchoReadinessCore';
import { HONCHO_DERIVER_BRANCH_LOCAL, type HonchoRuntimeConfig } from './honchoRuntimeConfigCore';

/** Extra skip reasons specific to the provisioning decision (non-secret UI codes). */
export const HONCHO_REASON_MODE_OFF = 'HONCHO_MODE_OFF';
export const HONCHO_REASON_BLOCKED_DISK = 'HONCHO_BLOCKED_DISK';
export const HONCHO_REASON_BLOCKED_RAM = 'HONCHO_BLOCKED_RAM';

/**
 * Free-disk floor for the Honcho stack itself (Postgres + pgvector + honcho-ai —
 * a few hundred MB; the ~4GB Gemma E4B opt-in is a SEPARATE capacity gate). Kept
 * modest so Honcho only skips on a genuinely full disk.
 */
export const HONCHO_MIN_FREE_DISK_GB = 2;

/**
 * Unified-memory floor for running the LOCAL Honcho stack (Postgres + pgvector +
 * a FastAPI server + a deriver worker ≈ +300-700MB PERMANENT). The perf deep-audit
 * (Opus + Codex, both CRITICAL) showed an 8GB MacBook Air already sits ~4.5-5.5GB
 * with EVE + one chat open, so adding Honcho tips it into swap for near-zero
 * benefit (its deriver can only be the cloud lane on 8GB anyway). Below this floor
 * Honcho stays OFF and memory falls back to the always-on, cheap Company Brain +
 * MEMORY.md. 10 GB blocks an 8GB Air while allowing a 16GB machine.
 */
export const HONCHO_MIN_UNIFIED_MEMORY_GB = 10;

/** The canonical ORDERED provisioning step ids. */
export const HONCHO_STEP_HOMEBREW = 'honcho-homebrew';
export const HONCHO_STEP_POSTGRES = 'honcho-postgres';
export const HONCHO_STEP_PGVECTOR = 'honcho-pgvector';
export const HONCHO_STEP_PYTHON = 'honcho-python';
export const HONCHO_STEP_PACKAGE = 'honcho-package';
export const HONCHO_STEP_DB = 'honcho-db';
export const HONCHO_STEP_PROCESS = 'honcho-process';
export const HONCHO_STEP_READY = 'honcho-ready';

/** Detected machine state (flat + optional; absence ⇒ "not present"). */
export interface HonchoDepDetection {
  hasHomebrew?: boolean;
  hasPostgres?: boolean;
  hasPgvector?: boolean;
  hasUv?: boolean;
  pythonSupported?: boolean;
  hasHonchoPkg?: boolean;
  /** per-seat database + the `vector` extension already exist. */
  dbProvisioned?: boolean;
  freeDiskGb?: number;
  /** Total unified memory (os.totalmem()/2^30). Gates the local Honcho stack. */
  totalMemoryGb?: number;
}

/** User consent + entitlement state (flat + optional; absence ⇒ safe default). */
export interface HonchoConsentState {
  /** The user opted into local memory at first-run ("takes a bit; do it anyway"). */
  memoryOptedIn?: boolean;
  /** The user declined installing a needed machine dep (Homebrew/Postgres). */
  installDeclined?: boolean;
  /** installer_policy.allow_homebrew_install — brew install is permitted. */
  allowHomebrewInstall?: boolean;
  /** A CEVE license exists — required for the cloud-flash deriver to authenticate. */
  hasLicense?: boolean;
  /** Carried for completeness; the deriver branch itself comes from config.deriver. */
  localModelOptedIn?: boolean;
  localModelReady?: boolean;
}

export type HonchoProvisionMode = 'auto' | 'check' | 'off';

export interface HonchoInstallStep {
  id?: string;
  /** Installing a machine dep the user must approve (Homebrew, Postgres). */
  needsConsent?: boolean;
  /** Detection says it is already present ⇒ the orchestrator no-ops this step. */
  alreadySatisfied?: boolean;
  detail?: string;
}

export interface HonchoProvisionPlan {
  honchoEnabled?: boolean;
  /** A HONCHO_* reason when honchoEnabled is false. */
  skipReason?: string;
  steps?: HonchoInstallStep[];
  /** true when any not-yet-satisfied step needs the user's install consent. */
  consentRequired?: boolean;
}

function disabled(reason: string): HonchoProvisionPlan {
  return { honchoEnabled: false, skipReason: reason, steps: [], consentRequired: false };
}

/**
 * Decide the Honcho provisioning plan for a seat. Order of the fail-safe gates:
 *   mode 'off'                         → skip (HONCHO_MODE_OFF)
 *   memory not opted-in                → skip (HONCHO_DECLINED)
 *   cloud-flash deriver but no license → skip (HONCHO_DEP_MISSING; no deriver auth)
 *   free disk below the floor          → skip (HONCHO_BLOCKED_DISK)
 *   a needed install was declined      → skip (HONCHO_DEP_MISSING)
 *   otherwise                          → enabled, with the ordered steps.
 */
export function buildHonchoProvisionPlan(input: {
  detection?: HonchoDepDetection;
  consent?: HonchoConsentState;
  mode?: HonchoProvisionMode;
  config?: HonchoRuntimeConfig;
}): HonchoProvisionPlan {
  const detection: HonchoDepDetection = input.detection || {};
  const consent: HonchoConsentState = input.consent || {};
  const mode: HonchoProvisionMode = input.mode || 'auto';

  if (mode === 'off') return disabled(HONCHO_REASON_MODE_OFF);
  if (consent.memoryOptedIn !== true) return disabled(HONCHO_REASON_DECLINED);

  // The cloud-flash deriver authenticates with the CEVE license; without one it
  // could never derive, so provisioning Postgres would be dead weight. Fail-closed.
  // DEFAULT-DENY on the branch (Codex #2): the RUNTIME default deriver is cloud-
  // flash — local is chosen ONLY when explicitly opted-in+ready. So a missing /
  // unknown branch is treated as CLOUD and MUST have a license; only an EXPLICIT
  // local-ollama branch waives it.
  const branch = input.config && input.config.deriver ? input.config.deriver.branch : undefined;
  const isExplicitLocal = branch === HONCHO_DERIVER_BRANCH_LOCAL;
  if (!isExplicitLocal && consent.hasLicense !== true) {
    return disabled(HONCHO_REASON_DEP_MISSING);
  }

  if (typeof detection.freeDiskGb === 'number' && detection.freeDiskGb < HONCHO_MIN_FREE_DISK_GB) {
    return disabled(HONCHO_REASON_BLOCKED_DISK);
  }

  // RAM floor (perf audit — Opus + Codex CRITICAL): the local Honcho server stack
  // (+300-700MB permanent) must not provision on a low-memory machine where it
  // would push EVE into swap. Below the floor Honcho stays off; memory falls back
  // to Company Brain + MEMORY.md. A missing value is not gated (the caller — the
  // bootstrap — always passes os.totalmem()).
  if (typeof detection.totalMemoryGb === 'number' && detection.totalMemoryGb < HONCHO_MIN_UNIFIED_MEMORY_GB) {
    return disabled(HONCHO_REASON_BLOCKED_RAM);
  }

  // Python is satisfied when a supported interpreter exists (the package installs
  // into the existing hermes venv via pip; uv is a 1.8 concern).
  const pythonSatisfied = detection.pythonSupported === true;

  const steps: HonchoInstallStep[] = [
    {
      id: HONCHO_STEP_HOMEBREW,
      needsConsent: true,
      alreadySatisfied: detection.hasHomebrew === true,
      detail: 'Homebrew (Paketmanager) sicherstellen',
    },
    {
      id: HONCHO_STEP_POSTGRES,
      needsConsent: true,
      alreadySatisfied: detection.hasPostgres === true,
      detail: 'PostgreSQL lokal installieren',
    },
    {
      id: HONCHO_STEP_PGVECTOR,
      needsConsent: true,
      alreadySatisfied: detection.hasPgvector === true,
      detail: 'pgvector-Erweiterung installieren',
    },
    {
      id: HONCHO_STEP_PYTHON,
      needsConsent: false,
      alreadySatisfied: pythonSatisfied,
      detail: 'Python-Laufzeit für Honcho vorbereiten',
    },
    {
      id: HONCHO_STEP_PACKAGE,
      needsConsent: false,
      alreadySatisfied: detection.hasHonchoPkg === true,
      detail: 'Honcho-Paket installieren',
    },
    {
      id: HONCHO_STEP_DB,
      needsConsent: false,
      alreadySatisfied: detection.dbProvisioned === true,
      detail: 'Per-Seat-Datenbank + Vektor-Erweiterung anlegen',
    },
    { id: HONCHO_STEP_PROCESS, needsConsent: false, alreadySatisfied: false, detail: 'Lokalen Honcho-Server starten' },
    {
      id: HONCHO_STEP_READY,
      needsConsent: false,
      alreadySatisfied: false,
      detail: 'Bereitschaft prüfen (/health + Deriver)',
    },
  ];

  const consentSteps = steps.filter((s) => s.needsConsent === true && s.alreadySatisfied !== true);
  const consentRequired = consentSteps.length > 0;

  // A needed install exists AND the user declined it ⇒ Honcho stays off (fail-safe).
  if (consentRequired && consent.installDeclined === true) {
    return disabled(HONCHO_REASON_DEP_MISSING);
  }

  return { honchoEnabled: true, steps, consentRequired };
}

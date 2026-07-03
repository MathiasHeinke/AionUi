/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import fs from 'fs';
import path from 'path';
import {
  commandEveOllamaContextModelRef,
  loadCommandEveRuntimeBootstrapManifest,
  resolveCommandEveRuntimeBootstrapManifestPath,
  resolveCommandEveRuntimeBootstrapPaths,
  selectRuntimeBootstrapTier,
  validateRuntimeBootstrapManifest,
  type RuntimeBootstrapManifest,
  type RuntimeBootstrapReceipt,
  type RuntimeBootstrapStage,
  type RuntimeBootstrapTier,
} from './runtimeBootstrapCore';

export const COMMAND_EVE_LOCAL_RUNTIME_STATUS_BRIDGE_VERSION = 'command-eve-local-runtime-status/v0';

export type CommandEveLocalRuntimeStatus = 'ready' | 'blocked' | 'failed';

export type CommandEveLocalRuntimeTierStatus = 'selected' | 'available' | 'opt_in' | 'pro';

/**
 * How a blocked local stage is fixed — drives the S4 RemediationCard on the
 * read-only /runtime page. Mirrors the S0 onboarding-status canon so both
 * surfaces key off the same reason-code → kind decision:
 *   - `external-link`  → download Ollama (the download step-screen card).
 *   - `pull-progress`  → the model is not (fully) fetched; show the live pull
 *                        poll + explainer (reuses the warm-up poll).
 *   - `cloud-redirect` → this Mac can't run local (RAM/disk); stay on cloud.
 *   - `reinstall`      → our-bug class (Python/Hermes); reinstall, never brew.
 */
export type CommandEveLocalRuntimeRemediationKind =
  | 'external-link'
  | 'pull-progress'
  | 'cloud-redirect'
  | 'reinstall';

export type CommandEveLocalRuntimeBlockedStage = {
  /** The bootstrap stage that blocked (e.g. `ollama`, `model`, `python`). */
  stage_id: RuntimeBootstrapStage['id'];
  /** The stage status that surfaced the block. */
  stage_status: 'blocked' | 'failed';
  /** The machine reason code carried on the blocking stage (e.g. OLLAMA_MISSING). */
  reason_code: string;
  /** How the renderer should remediate it. */
  remediation_kind: CommandEveLocalRuntimeRemediationKind;
  /** Optional raw stage detail (already operator-safe; never a shell command). */
  detail?: string;
};

/**
 * Reason-code → remediation-kind for the read-only /runtime RemediationCard.
 * Kept in lockstep with onboardingStatusCore's LOCAL_BLOCK_REMEDIATION: the
 * difference is only the kind VOCAB the /runtime page renders against
 * (`pull-progress` is the page's name for the html-screen pull poll).
 */
const LOCAL_RUNTIME_REMEDIATION_KIND: Record<string, CommandEveLocalRuntimeRemediationKind> = {
  OLLAMA_MISSING: 'external-link',
  OLLAMA_NOT_RUNNING: 'external-link',
  MODEL_NOT_FETCHED: 'pull-progress',
  MODEL_PULL_FAILED: 'pull-progress',
  BLOCKED_RAM: 'cloud-redirect',
  BLOCKED_DISK: 'cloud-redirect',
  PYTHON_UNSUPPORTED: 'reinstall',
  PYTHON_MISSING: 'reinstall',
  PYTHON_VENV_FAILED: 'reinstall',
  HERMES_MISSING: 'reinstall',
  HERMES_VERSION_MISMATCH: 'reinstall',
  HERMES_INSTALL_FAILED: 'reinstall',
};

function remediationKindForCode(code: string): CommandEveLocalRuntimeRemediationKind {
  // Unknown block code: surface as the our-bug "reinstall" class rather than
  // inventing a brew command or pretending it is fine.
  return LOCAL_RUNTIME_REMEDIATION_KIND[code] || 'reinstall';
}

function buildBlockedStage(
  receipt?: RuntimeBootstrapReceipt
): CommandEveLocalRuntimeBlockedStage | undefined {
  const stages = receipt?.stages;
  if (!Array.isArray(stages)) return undefined;
  // The bootstrap returns the receipt the moment a stage blocks, so at most one
  // blocking stage is present; we still scan defensively for the first one.
  const stage = stages.find((s) => s.status === 'blocked' || s.status === 'failed');
  if (!stage) return undefined;
  const code = String(stage.code || '').trim() || 'UNKNOWN_LOCAL_BLOCK';
  return {
    stage_id: stage.id,
    stage_status: stage.status as 'blocked' | 'failed',
    reason_code: code,
    remediation_kind: remediationKindForCode(code),
    ...(typeof stage.detail === 'string' && stage.detail.trim() ? { detail: stage.detail } : {}),
  };
}

export type CommandEveLocalRuntimeTierCard = {
  id: string;
  label: string;
  model_ref: string;
  runtime_model_ref: string;
  context_length: number;
  max_tokens: number;
  min_unified_memory_gb: number;
  min_free_disk_gb: number;
  status: CommandEveLocalRuntimeTierStatus;
  /**
   * 1.6.3 — the model is PRESENT in the local Ollama store (bridge-injected
   * /api/tags probe). false also covers "Ollama unreachable" — the card must
   * never claim an install it cannot see (a warning names the unreachable probe).
   */
  installed: boolean;
  /** Bytes the installed model occupies on disk (Ollama /api/tags size). */
  installed_size_bytes?: number;
  /** This machine meets the tier's RAM floor (unknown hardware ⇒ true — never invent a blocker). */
  ram_fit: boolean;
  /** Enough free disk for a fresh pull OR already installed (installed needs no new space). */
  disk_fit: boolean;
  /** 1.6.3 recommendation policy (recommendedLocalTierId — founder-tunable). */
  recommended: boolean;
};

export type CommandEveLocalRuntimeStatusModel = {
  schema_version: 'command-eve-local-runtime-status/v0';
  generated_at: string;
  read_only: true;
  release: string;
  hermes: {
    package: string;
    version: string;
  };
  provider: {
    type: 'ollama';
    base_url: string;
    egress_proxy_url: string;
  };
  selected_tier_id: string;
  selected_model_ref: string;
  receipt?: {
    path: string;
    status: RuntimeBootstrapReceipt['status'];
    default_model: string;
    base_model?: string;
    next_action: string;
    completed_at: string;
  };
  model_warmup?: {
    path: string;
    status: 'running' | 'ready' | 'failed' | 'skipped';
    model: string;
    base_url: string;
    started_at: string;
    completed_at?: string;
    elapsed_ms: number;
    error?: string;
  };
  /**
   * Live model-pull progress (v1.6.x). Read from the side file the bootstrap
   * writes during `ollama pull` — the receipt canon is silent mid-pull, so this
   * is what lets the RemediationCard show real bytes/percent instead of a
   * frozen spinner. Absent when no pull has run.
   */
  model_pull?: {
    path: string;
    status: 'pulling' | 'done' | 'failed';
    model: string;
    total: number;
    completed: number;
    percent: number;
    updated_at: string;
    error?: string;
  };
  /**
   * The first blocked/failed bootstrap stage, with its reason code mapped to a
   * remediation kind — drives the S4 RemediationCard. Absent when no local
   * stage is blocked (cloud stays the default regardless).
   */
  blocked_stage?: CommandEveLocalRuntimeBlockedStage;
  tiers: CommandEveLocalRuntimeTierCard[];
  /** 1.6.3 — the probed machine facts the per-tier fits were computed from. */
  hardware?: {
    total_memory_gb?: number;
    free_disk_gb?: number;
  };
  warnings: string[];
};

export type CommandEveLocalRuntimeStatusResult = {
  version: typeof COMMAND_EVE_LOCAL_RUNTIME_STATUS_BRIDGE_VERSION;
  ok: boolean;
  status: CommandEveLocalRuntimeStatus;
  reason_code?: string;
  message?: string;
  model?: CommandEveLocalRuntimeStatusModel;
  source: {
    manifest_path?: string;
    receipt_path?: string;
    generated_by: 'command-eve-local-runtime-status-core';
  };
};

export type CommandEveLocalRuntimeStatusOptions = {
  userDataPath: string;
  appPath?: string;
  resourcesPath?: string;
  manifestPath?: string;
  receiptPath?: string;
  modelWarmupReceiptPath?: string;
  modelPullProgressPath?: string;
  now?: () => Date;
  // ── 1.6.3 probe INJECTIONS (bridge-resolved; the core stays file-pure) ────
  /** Ollama /api/tags models. undefined = probe failed/skipped (⇒ installed:false + `ollama_probe_unavailable` warning). */
  installedModels?: Array<{ name: string; size?: number }>;
  /** os.totalmem(). undefined ⇒ ram_fit true (never invent a blocker from a missing probe). */
  totalMemoryBytes?: number;
  /** Free disk at the runtime root (GB). undefined ⇒ disk_fit true. */
  freeDiskGb?: number;
};

type JsonRecord = Record<string, unknown>;

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function readJsonFile(filePath: string): unknown {
  return JSON.parse(fs.readFileSync(filePath, 'utf8')) as unknown;
}

function parseReceipt(receiptPath: string): { receipt?: RuntimeBootstrapReceipt; warning?: string } {
  if (!fs.existsSync(receiptPath)) return {};
  try {
    const raw = readJsonFile(receiptPath);
    if (!isRecord(raw) || typeof raw.status !== 'string' || typeof raw.default_model !== 'string') {
      return { warning: 'runtime_receipt_schema_mismatch' };
    }
    return { receipt: raw as RuntimeBootstrapReceipt };
  } catch {
    return { warning: 'runtime_receipt_json_invalid' };
  }
}

function parseModelWarmupReceipt(receiptPath: string): {
  receipt?: NonNullable<CommandEveLocalRuntimeStatusModel['model_warmup']>;
  warning?: string;
} {
  if (!fs.existsSync(receiptPath)) return {};
  try {
    const raw = readJsonFile(receiptPath);
    if (
      !isRecord(raw) ||
      raw.version !== 'command-eve-model-warmup/v0' ||
      !['running', 'ready', 'failed', 'skipped'].includes(String(raw.status || '')) ||
      typeof raw.model !== 'string' ||
      typeof raw.base_url !== 'string' ||
      typeof raw.started_at !== 'string' ||
      typeof raw.elapsed_ms !== 'number'
    ) {
      return { warning: 'model_warmup_receipt_schema_mismatch' };
    }
    if (typeof raw.completed_at !== 'undefined' && typeof raw.completed_at !== 'string') {
      return { warning: 'model_warmup_receipt_schema_mismatch' };
    }
    return {
      receipt: {
        path: receiptPath,
        status: raw.status as 'running' | 'ready' | 'failed' | 'skipped',
        model: raw.model,
        base_url: raw.base_url,
        started_at: raw.started_at,
        elapsed_ms: raw.elapsed_ms,
        ...(typeof raw.completed_at === 'string' ? { completed_at: raw.completed_at } : {}),
        ...(typeof raw.error === 'string' ? { error: raw.error } : {}),
      },
    };
  } catch {
    return { warning: 'model_warmup_receipt_json_invalid' };
  }
}

function parseModelPullProgress(progressPath: string): {
  progress?: NonNullable<CommandEveLocalRuntimeStatusModel['model_pull']>;
  warning?: string;
} {
  if (!fs.existsSync(progressPath)) return {};
  try {
    const raw = readJsonFile(progressPath);
    if (
      !isRecord(raw) ||
      raw.version !== 'command-eve-model-pull/v0' ||
      !['pulling', 'done', 'failed'].includes(String(raw.status || '')) ||
      typeof raw.model !== 'string'
    ) {
      return { warning: 'model_pull_progress_schema_mismatch' };
    }
    const num = (v: unknown): number => (typeof v === 'number' && v >= 0 ? v : 0);
    return {
      progress: {
        path: progressPath,
        status: raw.status as 'pulling' | 'done' | 'failed',
        model: raw.model,
        total: num(raw.total),
        completed: num(raw.completed),
        percent: num(raw.percent),
        updated_at: typeof raw.updated_at === 'string' ? raw.updated_at : '',
        error: typeof raw.error === 'string' ? raw.error : undefined,
      },
    };
  } catch {
    return { warning: 'model_pull_progress_json_invalid' };
  }
}

/**
 * A live pull is invisible to the receipt (only written per completed stage), so
 * synthesize the `model`/`pull-progress` blocked stage from the progress side
 * file — but ONLY while genuinely pulling and only if the receipt did not
 * already surface a real block (a real block wins). Stale ('pulling' but the
 * file hasn't advanced for a while) is treated as not-pulling by the caller via
 * updated_at, so this never freezes the card on a dead pull.
 */
/** A 'pulling' file older than this (no throttled write in that window) is a
 *  dead/abandoned pull — do not keep the card (and its poll loop) alive on it. */
const MODEL_PULL_STALE_MS = 120_000;

function syntheticPullBlockedStage(
  progress: NonNullable<CommandEveLocalRuntimeStatusModel['model_pull']> | undefined,
  existing: CommandEveLocalRuntimeBlockedStage | undefined,
  nowMs: number
): CommandEveLocalRuntimeBlockedStage | undefined {
  if (existing) return existing;
  if (!progress || progress.status !== 'pulling') return undefined;
  // Stale 'pulling' (crashed/killed pull) must not freeze the card forever.
  const updatedMs = progress.updated_at ? Date.parse(progress.updated_at) : NaN;
  if (Number.isFinite(updatedMs) && nowMs - updatedMs > MODEL_PULL_STALE_MS) return undefined;
  return {
    stage_id: 'model',
    stage_status: 'blocked',
    reason_code: 'MODEL_NOT_FETCHED',
    remediation_kind: 'pull-progress',
    detail: `Pulling ${progress.model} (${progress.percent}%).`,
  };
}

function tierContextLength(tier: RuntimeBootstrapTier): number {
  return tier.context_length || 65_536;
}

function tierMaxTokens(tier: RuntimeBootstrapTier): number {
  return tier.max_tokens || 512;
}

function tierOllamaNumCtx(tier: RuntimeBootstrapTier): number {
  return tier.ollama_num_ctx || tierContextLength(tier);
}

function tierStatus(tier: RuntimeBootstrapTier, selectedTier: RuntimeBootstrapTier): CommandEveLocalRuntimeTierStatus {
  if (tier.id === selectedTier.id) return 'selected';
  if (tier.id.includes('31b')) return 'pro';
  if (tier.default) return 'available';
  return 'opt_in';
}

/**
 * 1.6.3 — drop a STALE 'pulling' row from the emitted payload (same
 * MODEL_PULL_STALE_MS rule as syntheticPullBlockedStage, so every consumer sees
 * one truth). done/failed rows pass through untouched (they are terminal facts).
 */
function staleFilteredModelPull(
  progress: CommandEveLocalRuntimeStatusModel['model_pull'],
  nowMs: number,
  warnings: string[]
): CommandEveLocalRuntimeStatusModel['model_pull'] {
  if (!progress || progress.status !== 'pulling') return progress;
  const updatedMs = Date.parse(progress.updated_at);
  if (Number.isFinite(updatedMs) && nowMs - updatedMs <= MODEL_PULL_STALE_MS) return progress;
  warnings.push('model_pull_stale');
  return undefined;
}

/** Normalize an Ollama model name/ref for equality (a bare name implies :latest). */
function normalizeModelRef(ref: string): string {
  const trimmed = (ref || '').trim();
  return trimmed.endsWith(':latest') ? trimmed.slice(0, -':latest'.length) : trimmed;
}

/** 1.6.3 — find the tier's model in the injected /api/tags list (by model_ref OR runtime alias). */
function findInstalledModel(
  tier: RuntimeBootstrapTier,
  runtimeModelRef: string,
  installedModels?: Array<{ name: string; size?: number }>
): { name: string; size?: number } | undefined {
  if (!installedModels) return undefined;
  const wanted = new Set([normalizeModelRef(tier.model_ref), normalizeModelRef(runtimeModelRef)]);
  return installedModels.find((m) => wanted.has(normalizeModelRef(m.name)));
}

/**
 * 1.6.3 RECOMMENDATION POLICY (deliberately one place, founder-tunable): the
 * manifest default tier is recommended; a ≥64 GB machine is lifted to the 12B
 * tier when the manifest ships one. A 'pro'-status tier is NEVER auto-recommended.
 */
export function recommendedLocalTierId(
  tiers: readonly RuntimeBootstrapTier[],
  defaultTierId: string,
  totalMemoryBytes?: number
): string {
  const memGb = typeof totalMemoryBytes === 'number' && totalMemoryBytes > 0 ? totalMemoryBytes / 1024 ** 3 : 0;
  const twelveB = tiers.find((t) => t.id.includes('12b') && !t.id.includes('31b'));
  if (memGb >= 64 && twelveB) return twelveB.id;
  return tiers.some((t) => t.id === defaultTierId) ? defaultTierId : (tiers[0]?.id ?? '');
}

function buildTierCard(
  tier: RuntimeBootstrapTier,
  selectedTier: RuntimeBootstrapTier,
  probes: {
    installedModels?: Array<{ name: string; size?: number }>;
    totalMemoryBytes?: number;
    freeDiskGb?: number;
    recommendedTierId: string;
  }
): CommandEveLocalRuntimeTierCard {
  const runtimeModelRef = commandEveOllamaContextModelRef(tier.model_ref, tierOllamaNumCtx(tier));
  const installedModel = findInstalledModel(tier, runtimeModelRef, probes.installedModels);
  const memGb =
    typeof probes.totalMemoryBytes === 'number' && probes.totalMemoryBytes > 0
      ? probes.totalMemoryBytes / 1024 ** 3
      : undefined;
  // Unknown hardware ⇒ fit (a missing probe must never invent a blocker);
  // an INSTALLED model needs no fresh disk, so disk_fit is true for it.
  const ramFit = memGb === undefined ? true : memGb + 0.5 >= tier.min_unified_memory_gb;
  const diskFit =
    installedModel !== undefined || probes.freeDiskGb === undefined || probes.freeDiskGb >= tier.min_free_disk_gb;
  return {
    id: tier.id,
    label: tier.label,
    model_ref: tier.model_ref,
    runtime_model_ref: runtimeModelRef,
    context_length: tierContextLength(tier),
    max_tokens: tierMaxTokens(tier),
    min_unified_memory_gb: tier.min_unified_memory_gb,
    min_free_disk_gb: tier.min_free_disk_gb,
    status: tierStatus(tier, selectedTier),
    installed: installedModel !== undefined,
    ...(installedModel && typeof installedModel.size === 'number' ? { installed_size_bytes: installedModel.size } : {}),
    ram_fit: ramFit,
    disk_fit: diskFit,
    recommended: tier.id === probes.recommendedTierId,
  };
}

function resultBase(
  source: CommandEveLocalRuntimeStatusResult['source']
): Pick<CommandEveLocalRuntimeStatusResult, 'version' | 'source'> {
  return {
    version: COMMAND_EVE_LOCAL_RUNTIME_STATUS_BRIDGE_VERSION,
    source,
  };
}

function inferSelectedTier(
  manifest: RuntimeBootstrapManifest,
  receipt?: RuntimeBootstrapReceipt
): RuntimeBootstrapTier {
  const byReceiptBase = receipt?.base_model
    ? manifest.local_runtime.tiers.find((tier) => tier.model_ref === receipt.base_model)
    : undefined;
  const byReceiptDefault = receipt?.default_model
    ? manifest.local_runtime.tiers.find(
        (tier) => commandEveOllamaContextModelRef(tier.model_ref, tierOllamaNumCtx(tier)) === receipt.default_model
      )
    : undefined;
  return byReceiptBase || byReceiptDefault || selectRuntimeBootstrapTier(manifest);
}

export function buildLocalRuntimeStatus(
  options: CommandEveLocalRuntimeStatusOptions
): CommandEveLocalRuntimeStatusResult {
  const paths = resolveCommandEveRuntimeBootstrapPaths(options.userDataPath);
  const manifestPath =
    options.manifestPath ||
    resolveCommandEveRuntimeBootstrapManifestPath({
      appPath: options.appPath,
      resourcesPath: options.resourcesPath,
    });
  const receiptPath = options.receiptPath || paths.receiptPath;
  const modelWarmupReceiptPath = options.modelWarmupReceiptPath || paths.modelWarmupReceiptPath;
  const base = resultBase({
    manifest_path: manifestPath,
    receipt_path: receiptPath,
    generated_by: 'command-eve-local-runtime-status-core',
  });

  try {
    const manifest = loadCommandEveRuntimeBootstrapManifest(manifestPath);
    const warnings: string[] = [];
    const parsedReceipt = parseReceipt(receiptPath);
    const parsedModelWarmupReceipt = parseModelWarmupReceipt(modelWarmupReceiptPath);
    const parsedModelPull = parseModelPullProgress(options.modelPullProgressPath || paths.modelPullProgressPath);
    if (parsedReceipt.warning) warnings.push(parsedReceipt.warning);
    if (!parsedReceipt.receipt) warnings.push('runtime_receipt_missing');
    if (parsedModelWarmupReceipt.warning) warnings.push(parsedModelWarmupReceipt.warning);
    if (!parsedModelWarmupReceipt.receipt) warnings.push('model_warmup_receipt_missing');
    if (parsedModelPull.warning) warnings.push(parsedModelPull.warning);

    const selectedTier = inferSelectedTier(manifest, parsedReceipt.receipt);
    const manifestFailures = validateRuntimeBootstrapManifest(manifest, selectedTier);
    if (manifestFailures.length) {
      throw new Error(manifestFailures.join(', '));
    }
    // 1.6.3: enrich every card with the injected probes (installed / fits /
    // recommendation). A missing Ollama probe is SAID, not hidden — the UI can
    // then render "Status unbekannt" instead of a false "Nicht geladen".
    if (options.installedModels === undefined) warnings.push('ollama_probe_unavailable');
    const recommendedTierId = recommendedLocalTierId(
      manifest.local_runtime.tiers,
      manifest.local_runtime.default_tier_id,
      options.totalMemoryBytes
    );
    const tiers = manifest.local_runtime.tiers.map((tier) =>
      buildTierCard(tier, selectedTier, {
        installedModels: options.installedModels,
        totalMemoryBytes: options.totalMemoryBytes,
        freeDiskGb: options.freeDiskGb,
        recommendedTierId,
      })
    );
    const memGbRounded =
      typeof options.totalMemoryBytes === 'number' && options.totalMemoryBytes > 0
        ? Math.round(options.totalMemoryBytes / 1024 ** 3)
        : undefined;
    const hardware =
      memGbRounded !== undefined || options.freeDiskGb !== undefined
        ? {
            ...(memGbRounded !== undefined ? { total_memory_gb: memGbRounded } : {}),
            ...(options.freeDiskGb !== undefined ? { free_disk_gb: Math.round(options.freeDiskGb * 10) / 10 } : {}),
          }
        : undefined;

    return {
      ...base,
      ok: true,
      status: 'ready',
      model: {
        schema_version: 'command-eve-local-runtime-status/v0',
        generated_at: (options.now ?? (() => new Date()))().toISOString(),
        read_only: true,
        release: manifest.release,
        hermes: {
          package: manifest.hermes.package,
          version: manifest.hermes.version,
        },
        provider: {
          type: manifest.local_runtime.provider,
          base_url: manifest.local_runtime.base_url,
          egress_proxy_url: manifest.local_runtime.egress_proxy_url,
        },
        selected_tier_id: selectedTier.id,
        selected_model_ref: commandEveOllamaContextModelRef(selectedTier.model_ref, tierOllamaNumCtx(selectedTier)),
        receipt: parsedReceipt.receipt
          ? {
              path: receiptPath,
              status: parsedReceipt.receipt.status,
              default_model: parsedReceipt.receipt.default_model,
              base_model: parsedReceipt.receipt.base_model,
              next_action: parsedReceipt.receipt.next_action,
              completed_at: parsedReceipt.receipt.completed_at,
            }
          : undefined,
        blocked_stage: syntheticPullBlockedStage(
          parsedModelPull.progress,
          buildBlockedStage(parsedReceipt.receipt),
          (options.now ?? (() => new Date()))().getTime()
        ),
        model_warmup: parsedModelWarmupReceipt.receipt,
        // 1.6.3 review fix (HIGH): apply the SAME staleness rule the synthetic
        // blocked-stage already has to the RAW payload — a crashed pull leaves
        // status:'pulling' on disk forever, and an unfiltered emit froze the
        // model card on "Lädt X %" with a locked button. A stale 'pulling' row
        // is dropped (the card falls back to the installed/not-installed truth).
        model_pull: staleFilteredModelPull(
          parsedModelPull.progress,
          (options.now ?? (() => new Date()))().getTime(),
          warnings
        ),
        tiers,
        ...(hardware ? { hardware } : {}),
        warnings,
      },
    };
  } catch (error) {
    return {
      ...base,
      ok: false,
      status: 'failed',
      reason_code: 'LOCAL_RUNTIME_STATUS_FAILED',
      message: error instanceof Error ? error.message : 'Command EVE local runtime status could not be built.',
    };
  }
}

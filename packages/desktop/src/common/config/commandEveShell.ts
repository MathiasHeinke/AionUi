import type { TProviderWithModel } from './storage';
import type { AcpModelInfo } from '../types/platform/acpTypes';

export const COMMAND_EVE_SHELL_ENABLED =
  typeof process === 'undefined' ? true : process.env.AIONUI_UPSTREAM_MODE !== '1';

/**
 * v1.6 Slice 4 ("Day-Zero-Soft-Fold"): in Command-EVE builds the forced Day-0
 * "Seed your Company Brain" modal no longer pops — the CHAT is the brief
 * collector (the ready greeting asks for the brief; EVE mirrors it, Beat 1).
 * Everything else survives: the per-seat seed/dismissed persistence, both IPC
 * providers, the Settings → Company Brain manual path, and the host component
 * itself (per-seat correctness stays pinned by its tests). Upstream builds
 * (AIONUI_UPSTREAM_MODE=1) keep the modal unchanged.
 */
export function isDayZeroForcePopEnabled(): boolean {
  return !COMMAND_EVE_SHELL_ENABLED;
}

/**
 * Founder / internal build flag.
 *
 * DEFAULT (every shipped operator build) is FALSE: EVE is the operator-facing
 * "The Operator" confidant (SOUL.md) — a co-founder-grade partner for making
 * money with AI for the operator and their clients. Operators NEVER see the
 * internal Company.OS orchestration scaffolding (Chief-of-Staff, Founder Intent,
 * CEO/Codex delegation, Worker Contracts, Plane, HG-gates) or the Command Center.
 *
 * The founder opts into the internal Chief-of-Staff orchestration persona + tools
 * by setting COMMAND_EVE_FOUNDER_BUILD=1 in their environment. This is a
 * process-layer signal (the assistant seed runs in the main process); the renderer
 * must receive it via config/IPC, not by reading process.env.
 */
export const COMMAND_EVE_FOUNDER_BUILD_ENV = 'COMMAND_EVE_FOUNDER_BUILD';
export function isCommandEveFounderBuild(
  env: NodeJS.ProcessEnv | undefined = typeof process === 'undefined' ? undefined : process.env
): boolean {
  const value = env?.[COMMAND_EVE_FOUNDER_BUILD_ENV];
  return value === '1' || value === 'true';
}

/**
 * Public packaged builds can never be promoted into founder mode by launching
 * the app with an environment variable. Internal founder surfaces remain
 * available only in an unpackaged development build.
 */
export function isCommandEveFounderBuildAllowed(
  isPackaged: boolean,
  env: NodeJS.ProcessEnv | undefined = typeof process === 'undefined' ? undefined : process.env
): boolean {
  return !isPackaged && isCommandEveFounderBuild(env);
}

export const COMMAND_EVE_APP_NAME = 'Command EVE';
export const COMMAND_EVE_DISPLAY_NAME = 'EVE';
export const COMMAND_EVE_TITLE = '⌘ EVE';
// Electron Updater requires three-part SemVer. The compact founder-facing
// release train is 1.813, 1.814, ... while package/feed truth stays 1.813.0,
// 1.814.0, ... so update ordering remains standards-compliant.
export const COMMAND_EVE_VERSION = '1.822.2';
export const COMMAND_EVE_MARKETING_VERSION = '1.822';

export function formatCommandEveDisplayVersion(version: string): string {
  const normalized = String(version || '').trim();
  return normalized.replace(/^(\d+\.\d{3})\.0$/, '$1');
}
export const COMMAND_EVE_APP_ID = 'com.fynlabs.commandeve';
/**
 * Generic (electron-updater) over-the-air update feed base URL for Command EVE.
 *
 * This is the Cloudflare Worker that proxies the R2 release bucket (electron-builder.yml
 * `publish.url` bakes the SAME value into the bundled app-update.yml). It is the default the
 * runtime feed resolver falls back to when COMMAND_EVE_SHELL_ENABLED and no explicit
 * COMMAND_EVE_UPDATE_FEED_URL env / persisted `update.feedUrl` override is set, so an
 * installed Command EVE build actually checks `<base>/latest-arm64-mac.yml` on startup.
 *
 * WHY A WORKER, NOT THE pub-*.r2.dev URL: electron-updater does DIFFERENTIAL (delta)
 * downloads via HTTP MULTI-range requests; R2's public pub-*.r2.dev URL answers single
 * ranges (206) but 400s on multi-range, forcing a full ~700MB download every update. This
 * Worker (apps/eve-update-proxy) implements multipart/byteranges itself, so the updater gets
 * its delta and users download only the changed blocks. Upstream (CE shell off) builds never
 * get this default.
 */
export const COMMAND_EVE_UPDATE_FEED_BASE_URL = 'https://eve-update-proxy.commandeve.workers.dev';
export const COMMAND_EVE_PROTOCOL_SCHEME = 'command-eve';
export const COMMAND_EVE_ASSISTANT_ID = 'command-eve-chief-of-staff';
export const COMMAND_EVE_ASSISTANT_KEY = `custom:${COMMAND_EVE_ASSISTANT_ID}`;
// RELATIVE path (no leading slash): the packaged app loads the renderer via file://
// (loadFile) with a HashRouter, so an ABSOLUTE '/command-eve-logo.svg' resolves to the
// filesystem root (file:///command-eve-logo.svg → 404 → broken-image glyph). './' resolves
// against the document base (out/renderer/index.html, where public/ assets land) in BOTH
// the dev server and the packaged file:// build. Same rule as Vite's favicon rewrite.
export const COMMAND_EVE_ASSISTANT_AVATAR = './command-eve-logo.svg';
export const COMMAND_EVE_DEFAULT_ACP_BACKEND = 'hermes';
export const COMMAND_EVE_DEFAULT_ACP_MODEL_ID = 'custom:command-eve-gemma4-e4b-64k:latest';
export const COMMAND_EVE_LOCAL_RUNTIME_PROVIDER_ID = 'command-eve-local-runtime';
export const COMMAND_EVE_LOCAL_RUNTIME_PROVIDER_NAME = 'Command EVE Local Runtime';
export const COMMAND_EVE_EGRESS_PROXY_OPENAI_BASE_URL = 'http://127.0.0.1:25811/v1';
export const COMMAND_EVE_BONSAI_LOCAL_TIER_ID = 'bonsai-27b-local-experimental';
export const COMMAND_EVE_BONSAI_RUNTIME_MODEL_ID = 'command-eve-bonsai-27b-q2';
export const COMMAND_EVE_BONSAI_ACP_MODEL_ID = `custom:${COMMAND_EVE_BONSAI_RUNTIME_MODEL_ID}`;
export const COMMAND_EVE_COLIBRI_LOCAL_TIER_ID = 'colibri-glm-5-2-uncensored-max';
export const COMMAND_EVE_COLIBRI_RUNTIME_MODEL_ID = 'command-eve-colibri-glm-5-2-uncensored';
export const COMMAND_EVE_COLIBRI_ACP_MODEL_ID = `custom:${COMMAND_EVE_COLIBRI_RUNTIME_MODEL_ID}`;
export const COMMAND_EVE_LOCAL_MODEL_TIERS = [
  {
    id: 'gemma-4-e4b-local-default',
    // Offline/local models ARE named (founder 2026-06-28): they run on the user's
    // own device, so transparency wins — only the CLOUD lane stays model-abstract.
    label: 'Gemma 4 E4B Uncensored',
    modelId: 'custom:command-eve-gemma4-e4b-64k:latest',
    modelRef: 'hf.co/tripolskypetr/Gemma-4-Uncensored-Aggressive-GGUF:Q5_K_M',
    contextLength: 65_536,
    diskGb: 10,
    memoryGb: 16,
    recommendedMemoryGb: 24,
    runtime: 'ollama',
    state: 'default',
    lane: 'fast',
    alignment: 'uncensored',
    toolCalling: 'preview',
    source: {
      repo: 'tripolskypetr/Gemma-4-Uncensored-Aggressive-GGUF',
      revision: '858c398771586fb7ba12c1c4e441707fb2cdfdeb',
      artifactSha256: 'c96f1afc2af92bb27b1d5057fd91c8f6e41e9a72f9f32faa389e1601a6963ee6',
      license: 'gemma',
    },
  },
  {
    id: 'gemma-4-12b-local-planning',
    label: 'Gemma 4 12B Heretic',
    modelId: 'custom:command-eve-gemma4-12b-64k:latest',
    modelRef: 'hf.co/SC117/Gemma-4-12B-it-heretic-GGUF:Q6_K',
    contextLength: 65_536,
    diskGb: 20,
    memoryGb: 24,
    recommendedMemoryGb: 32,
    runtime: 'ollama',
    state: 'opt_in',
    lane: 'balanced',
    alignment: 'uncensored',
    toolCalling: 'preview',
    source: {
      repo: 'SC117/Gemma-4-12B-it-heretic-GGUF',
      revision: 'efa14611b0b04ab1ab1e38356596ac8d673a619a',
      artifactSha256: '792ebdaa79993baf2030e35dd0a107eb88ade8e7ebccdf7bbe4f63cd4e114354',
      license: 'gemma',
    },
  },
  {
    id: 'gemma-4-31b-local-pro',
    label: 'Gemma 4 31B Heretic',
    modelId: 'custom:command-eve-gemma4-31b-64k:latest',
    modelRef: 'hf.co/llmfan46/gemma-4-31B-it-uncensored-heretic-GGUF:Q6_K',
    contextLength: 65_536,
    diskGb: 45,
    memoryGb: 64,
    recommendedMemoryGb: 96,
    runtime: 'ollama',
    state: 'pro',
    lane: 'pro',
    alignment: 'uncensored',
    toolCalling: 'preview',
    source: {
      repo: 'llmfan46/gemma-4-31B-it-uncensored-heretic-GGUF',
      revision: 'eee61b81461ac75eb920a24ca9e5d420bb66e33d',
      artifactSha256: 'ec331ca8d40bef30bc00312b506a78e01bd9bdc6aa98d449d79b2942eca6efc1',
      license: 'gemma',
    },
  },
  {
    id: COMMAND_EVE_BONSAI_LOCAL_TIER_ID,
    label: 'Bonsai 27B',
    modelId: COMMAND_EVE_BONSAI_ACP_MODEL_ID,
    modelRef: 'bonsai:27b-q2',
    contextLength: 65_536,
    diskGb: 12,
    memoryGb: 24,
    recommendedMemoryGb: 32,
    runtime: 'bonsai-prism',
    state: 'experimental',
    lane: 'bonsai',
    alignment: 'standard',
    toolCalling: 'qualified',
    source: {
      repo: 'prism-ml/Ternary-Bonsai-27B-gguf',
      revision: 'main',
      artifactSha256: '868c11714cf8fe47f5ec9eeb2be0ab1a337112886f92ee0ede6b855c4fa31757',
      license: 'research',
    },
  },
  {
    id: COMMAND_EVE_COLIBRI_LOCAL_TIER_ID,
    label: 'Colibrì GLM-5.2 Uncensored',
    modelId: COMMAND_EVE_COLIBRI_ACP_MODEL_ID,
    modelRef: 'colibri:glm-5.2-fp8-uncensored-int4',
    contextLength: 65_536,
    diskGb: 400,
    memoryGb: 48,
    recommendedMemoryGb: 128,
    runtime: 'colibri',
    state: 'experimental',
    lane: 'colibri',
    alignment: 'uncensored',
    toolCalling: 'preview',
    source: {
      repo: 'annelo/GLM-5.2-FP8-Uncensored-Colibri-Int4',
      revision: '5bba67e2e9d7e6d565655f2d923c64247f919db4',
      artifactSha256: '7eb139ed5b5a9b2d0e8dbd8adf082b26bb261a5dcf79b7c44ca46085cb4ed543',
      license: 'mit',
    },
  },
] as const;
export type CommandEveLocalModelTier = (typeof COMMAND_EVE_LOCAL_MODEL_TIERS)[number];
export type CommandEveLocalModelTierId = CommandEveLocalModelTier['id'];
export const COMMAND_EVE_DEFAULT_LOCAL_MODEL_TIER_ID: CommandEveLocalModelTierId = COMMAND_EVE_LOCAL_MODEL_TIERS[0].id;
export const COMMAND_EVE_DATA_DIR_NAME = 'command-eve';
export const COMMAND_EVE_CONFIG_DIR_NAME = 'config';
export const COMMAND_EVE_TEMP_DIR_NAME = 'command-eve';
export const COMMAND_EVE_CLI_DATA_SYMLINK = '.command-eve';
export const COMMAND_EVE_CLI_CONFIG_SYMLINK = '.command-eve-config';
export const COMMAND_EVE_CDP_REGISTRY_FILE = '.command-eve-cdp-registry.json';

export const COMMAND_EVE_AGENT_FALLBACK_ORDER = ['hermes'] as const;

/**
 * True iff an ACP conversation's backend is the Command EVE runtime (Hermes)
 * while the EVE shell is enabled. The single signal used to decide whether a
 * running conversation SUPPRESSES the raw ACP model selector (desktop) and the
 * model entry in the mobile action sheet, and mounts the MAX toggle instead.
 *
 * Founder mandate (MAT-1749): an EVE user must never see a raw CLI/agent/model
 * list — and must not see a replacement lane/tier picker either. The composer
 * offers exactly one intelligence affordance, the additive MAX toggle, plus the
 * permission-mode selector. The private local lane is chosen in Settings →
 * Modell, never in the composer.
 */
export function isCommandEveAcpConversation(backend: string | null | undefined): boolean {
  return COMMAND_EVE_SHELL_ENABLED && backend === COMMAND_EVE_DEFAULT_ACP_BACKEND;
}

export function getCommandEveEnvSuffix(): string {
  return process.env.AIONUI_MULTI_INSTANCE === '1' ? '-dev-2' : '-dev';
}

export function getCommandEveAppName(isPackaged: boolean): string {
  return isPackaged ? COMMAND_EVE_APP_NAME : `${COMMAND_EVE_APP_NAME}${getCommandEveEnvSuffix()}`;
}

export function getCommandEveDefaultAcpModelId(backend: string): string | undefined {
  if (!COMMAND_EVE_SHELL_ENABLED || backend !== COMMAND_EVE_DEFAULT_ACP_BACKEND) {
    return undefined;
  }
  return COMMAND_EVE_DEFAULT_ACP_MODEL_ID;
}

export function normalizeCommandEveLocalModelTierId(tierId?: string | null): CommandEveLocalModelTierId {
  const matched = COMMAND_EVE_LOCAL_MODEL_TIERS.find((tier) => tier.id === tierId);
  return matched?.id ?? COMMAND_EVE_DEFAULT_LOCAL_MODEL_TIER_ID;
}

export function getCommandEveLocalModelTier(tierId?: string | null): CommandEveLocalModelTier {
  const normalized = normalizeCommandEveLocalModelTierId(tierId);
  return COMMAND_EVE_LOCAL_MODEL_TIERS.find((tier) => tier.id === normalized) ?? COMMAND_EVE_LOCAL_MODEL_TIERS[0];
}

export function normalizeCommandEveLocalRuntimeModelId(modelId?: string | null): string {
  const normalized = String(modelId || '')
    .trim()
    .replace(/^custom:/, '');
  return normalized.endsWith(':latest') ? normalized.slice(0, -':latest'.length) : normalized;
}

export function getCommandEveLocalModelTierForRuntimeModel(
  modelId?: string | null
): CommandEveLocalModelTier | undefined {
  const normalized = normalizeCommandEveLocalRuntimeModelId(modelId);
  if (!normalized) return undefined;
  return COMMAND_EVE_LOCAL_MODEL_TIERS.find(
    (tier) => normalizeCommandEveLocalRuntimeModelId(tier.modelId) === normalized
  );
}

export function getCommandEveAcpModelIdForTier(tierId?: string | null): string {
  return getCommandEveLocalModelTier(tierId).modelId;
}

export function getCommandEveLocalAcpModelInfo(
  backend?: string | null,
  currentModelId?: string | null
): AcpModelInfo | undefined {
  if (!COMMAND_EVE_SHELL_ENABLED || backend !== COMMAND_EVE_DEFAULT_ACP_BACKEND) {
    return undefined;
  }

  const available_models = COMMAND_EVE_LOCAL_MODEL_TIERS.map((tier) => ({
    id: tier.modelId,
    label: tier.label,
  }));
  const resolvedModelId =
    currentModelId && available_models.some((model) => model.id === currentModelId)
      ? currentModelId
      : COMMAND_EVE_DEFAULT_ACP_MODEL_ID;
  const selected = available_models.find((model) => model.id === resolvedModelId) ?? available_models[0];

  return {
    current_model_id: selected?.id ?? null,
    current_model_label: selected?.label ?? null,
    available_models,
  };
}

export function getCommandEveLocalAcpModelInfoForTier(
  backend: string | undefined,
  tierId?: string | null
): AcpModelInfo | undefined {
  const modelId = backend ? getCommandEveDefaultAcpModelIdForTier(backend, tierId) : undefined;
  return getCommandEveLocalAcpModelInfo(backend, modelId);
}

export function getCommandEveDefaultAcpModelIdForTier(backend: string, tierId?: string | null): string | undefined {
  if (!COMMAND_EVE_SHELL_ENABLED || backend !== COMMAND_EVE_DEFAULT_ACP_BACKEND) {
    return undefined;
  }
  return getCommandEveAcpModelIdForTier(tierId);
}

export function getCommandEveLocalRuntimeProvider(tierId?: string | null): TProviderWithModel {
  const tier = getCommandEveLocalModelTier(tierId);
  return {
    id: COMMAND_EVE_LOCAL_RUNTIME_PROVIDER_ID,
    platform: 'custom',
    name: COMMAND_EVE_LOCAL_RUNTIME_PROVIDER_NAME,
    base_url: COMMAND_EVE_EGRESS_PROXY_OPENAI_BASE_URL,
    api_key: 'command-eve-local-loopback',
    use_model: tier.modelId,
    context_limit: tier.contextLength,
    capabilities: [{ type: 'text' }, { type: 'function_calling' }],
  };
}

export function getCommandEveCliSafeName(baseName: string, isPackaged: boolean): string {
  return isPackaged ? baseName : `${baseName}${getCommandEveEnvSuffix()}`;
}

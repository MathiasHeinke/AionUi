import type { TProviderWithModel } from './storage';
import type { AcpModelInfo } from '../types/platform/acpTypes';

export const COMMAND_EVE_SHELL_ENABLED =
  typeof process === 'undefined' ? true : process.env.AIONUI_UPSTREAM_MODE !== '1';

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
export function isCommandEveFounderBuild(env: NodeJS.ProcessEnv | undefined = typeof process === 'undefined' ? undefined : process.env): boolean {
  const value = env?.[COMMAND_EVE_FOUNDER_BUILD_ENV];
  return value === '1' || value === 'true';
}

export const COMMAND_EVE_APP_NAME = 'Command EVE';
export const COMMAND_EVE_DISPLAY_NAME = 'EVE';
export const COMMAND_EVE_TITLE = '⌘ EVE';
export const COMMAND_EVE_VERSION = '1.2.14';
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
export const COMMAND_EVE_LOCAL_MODEL_TIERS = [
  {
    id: 'gemma-4-e4b-local-default',
    // Offline/local models ARE named (founder 2026-06-28): they run on the user's
    // own device, so transparency wins — only the CLOUD lane stays model-abstract.
    label: 'Gemma 4 E4B',
    modelId: 'custom:command-eve-gemma4-e4b-64k:latest',
    modelRef: 'gemma4:e4b',
    contextLength: 65_536,
    diskGb: 10,
    memoryGb: 16,
    state: 'default',
  },
  {
    id: 'gemma-4-12b-local-planning',
    label: 'Gemma 4 12B',
    modelId: 'custom:command-eve-gemma4-12b-64k:latest',
    modelRef: 'gemma4:12b',
    contextLength: 65_536,
    diskGb: 20,
    memoryGb: 16,
    state: 'opt_in',
  },
  {
    id: 'gemma-4-31b-local-pro',
    label: 'Gemma 4 31B',
    modelId: 'custom:command-eve-gemma4-31b-64k:latest',
    modelRef: 'gemma4:31b',
    contextLength: 65_536,
    diskGb: 45,
    memoryGb: 64,
    state: 'pro',
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
 * running conversation surfaces the EVE Inference tier picker (instead of the
 * raw ACP model selector) and the EVE tier entry in the mobile action sheet.
 *
 * Founder mandate: an EVE user must never see a raw CLI/agent/model list — only
 * the EVE Inference + Private tier picker and the permission-mode selector.
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

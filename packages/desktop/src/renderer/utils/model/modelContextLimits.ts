/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import { COMMAND_EVE_OPERATIONAL_CONTEXT_LIMIT } from '@/common/config/eveContextPolicyCore';

/**
 * ── Command EVE cloud lane (eve-inference → OpenRouter) ────────────────────
 *
 * Split out of {@link MODEL_CONTEXT_LIMITS} (which spreads it back in, so every
 * key still resolves exactly as before) for ONE reason: it is also the source of
 * {@link CLOUD_MODEL_IDENTIFIERS}, the deny-list that keeps a provider/model id
 * out of user-facing error text. Deriving that list from a NAMED block means a
 * model added to EVE's cloud lane is denied automatically; deriving it from the
 * whole table would drag in BYOK ids the user picked themselves.
 *
 * Provider-advertised context windows. Command EVE still clamps every cloud lane
 * to the operational 256K contract below. Keyed by BOTH the model slug AND the
 * bare model name, because a request_trace / upstream error may carry either —
 * which is exactly why the deny-list has to cover both forms too.
 */
const EVE_CLOUD_MODEL_CONTEXT_LIMITS: Record<string, number> = {
  'z-ai/glm-5.2': 1_048_576,
  'glm-5.2': 1_048_576,
  'deepseek/deepseek-v4-pro': 1_048_576,
  'deepseek/deepseek-v4-flash': 1_048_576,
  'deepseek-v4-pro': 1_048_576,
  'deepseek-v4-flash': 1_048_576,
  'deepseek-v4': 1_048_576,
  'moonshotai/kimi-k2.6': 262_144,
  'kimi-k2.6': 262_144,
  'moonshotai/kimi-k3': 1_048_576,
  'kimi-k3': 1_048_576,
  'command-eve-inference': 1_048_576, // any EVE cloud tier
};

/**
 * EVE's OWN lane vocabulary, not a provider identifier. The product renders these
 * deliberately (the lane name is EVE's, and says nothing about who serves it), so
 * they are excluded from the deny-list rather than redacted out of EVE's own copy.
 */
const EVE_INTERNAL_LANE_PREFIX = 'command-eve-';

/**
 * 已知模型的 context window 大小配置
 */
const MODEL_CONTEXT_LIMITS: Record<string, number> = {
  // Gemini 系列
  'gemini-3.1-pro-preview': 1_048_576,
  'gemini-3-pro-preview': 1_048_576,
  'gemini-3-flash-preview': 1_048_576,
  'gemini-3-pro-image-preview': 65_536,
  'gemini-2.5-pro': 1_048_576,
  'gemini-2.5-flash': 1_048_576,
  'gemini-2.5-flash-lite': 1_048_576,
  'gemini-2.5-flash-image': 32_768,
  'gemini-2.0-flash': 1_048_576,
  'gemini-2.0-flash-lite': 1_048_576,
  'gemini-1.5-pro': 2_097_152,
  'gemini-1.5-flash': 1_048_576,

  // OpenAI 系列
  'gpt-5.6': 1_000_000,
  'gpt-5.1': 400_000,
  'gpt-5.1-chat': 128_000,
  'gpt-5': 400_000,
  'gpt-5-chat': 128_000,
  'gpt-4o': 128_000,
  'gpt-4o-mini': 128_000,
  'gpt-4-turbo': 128_000,
  'gpt-4-turbo-preview': 128_000,
  'gpt-4': 8_192,
  'gpt-3.5-turbo': 16_385,
  'gpt-3.5-turbo-16k': 16_385,
  o1: 200_000,
  'o1-preview': 128_000,
  'o1-mini': 128_000,
  o3: 200_000,
  'o3-mini': 200_000,

  // Claude 系列
  'claude-opus-4.8': 1_000_000,
  'claude-fable-5': 1_000_000,
  'fable-5': 1_000_000,
  'claude-opus-4.5': 200_000,
  'claude-haiku-4.5': 200_000,
  'claude-sonnet-4.5': 1_000_000,
  'claude-opus-4.1': 200_000,
  'claude-opus-4': 200_000,
  'claude-sonnet-4': 1_000_000,
  'claude-3.7-sonnet': 200_000,
  'claude-3.5-haiku': 200_000,
  'claude-3-opus': 200_000,
  'claude-3-haiku': 200_000,

  // ── Command EVE cloud lane ───────────────────────────────────────────────
  // Declared above so the deny-list can be derived from it; spread in here so
  // the fuzzy fallback still resolves whichever id the request_trace carries —
  // the founder's point: GLM must NOT read as 64k like a local model.
  ...EVE_CLOUD_MODEL_CONTEXT_LIMITS,

  // ── Command EVE local lane (bundled Gemma via Ollama) ────────────────────
  // FALLBACK ONLY — the live `acp_context_usage` frame reports the real runtime
  // size and always wins. This is the `ollama_num_ctx` MEMORY CAP (64k on the M1
  // 16GB baseline), NOT the model's theoretical max — deliberately bounded.
  // INFERENCE (config-sourced, runtimeBootstrapCore DEFAULT_LONG_CONTEXT_LENGTH).
  'command-eve-gemma': 65_536,
  'gemma-4': 65_536,
  gemma4: 65_536,
};

/**
 * Every concrete cloud model identifier this build knows about, derived from
 * {@link EVE_CLOUD_MODEL_CONTEXT_LIMITS} rather than re-listed.
 *
 * Used ONLY as a deny-list for {@link scrubModelIdentifiers} on user-facing error
 * text: the founder mandate is that the chat never renders a model id, and an
 * upstream error body is the one path that can carry one through. Deriving it
 * here means a model swapped in the table is scrubbed automatically instead of
 * needing a second list somebody forgets.
 *
 * BOTH FORMS, and that is the fix (1.820.1). This used to be
 * `keys.filter(id => id.includes('/'))` — SLUGS ONLY. The shape scrub already
 * catches a `vendor/model` slug on its own, so the slug-only list added nothing,
 * while the form it did NOT cover — the BARE model name (`kimi-k3`,
 * `deepseek-v4-flash`), which is what an upstream body carries when it names the
 * model without its vendor prefix — passed through unscrubbed. So every slug now
 * contributes its bare segment too.
 *
 * PROSE GUARD. Deny-list entries are matched as case-insensitive SUBSTRINGS with
 * no word boundary, so a bare word here would mangle ordinary sentences. Every
 * entry must therefore contain a digit — true of every model name, false of every
 * vendor word ("deepseek", "moonshotai") and of any ordinary word. Vendor
 * segments are deliberately NOT added for that reason; the shape scrub covers
 * them wherever they appear attached to a model.
 */
export const CLOUD_MODEL_IDENTIFIERS: readonly string[] = Object.freeze(
  Array.from(
    new Set(
      Object.keys(EVE_CLOUD_MODEL_CONTEXT_LIMITS)
        .filter((id) => !id.startsWith(EVE_INTERNAL_LANE_PREFIX))
        .flatMap((id) => (id.includes('/') ? [id, id.slice(id.indexOf('/') + 1)] : [id]))
    )
  ).filter((id) => /[0-9]/.test(id))
);

/**
 * 默认 context limit（当无法确定模型时使用）
 */
export const DEFAULT_CONTEXT_LIMIT = COMMAND_EVE_OPERATIONAL_CONTEXT_LIMIT;

/**
 * Command EVE's operational cloud context window. Provider marketing may
 * advertise 1M+, but EVE deliberately keeps one predictable 256K contract for
 * every cloud model. Hermes compacts before this ceiling; local models retain
 * their smaller live hardware cap.
 *
 * WHY a named constant the resolver leans on: the live `acp_context_usage.size`
 * frame Hermes emits carries the runtime's CONFIGURED `context_length`, which on
 * a Command EVE build is the LOCAL Ollama `ollama_num_ctx` memory cap (64k on the
 * M1 16GB baseline, bounded to ≤262144 in runtimeBootstrapCore). Hermes reports
 * that SAME 64k window on CLOUD turns too (one managed config, not per-lane), so
 * a naive "live size always wins" pins cloud turns at 64K. The resolver therefore
 * ignores that stale local size on cloud turns, but it also never exposes the
 * provider's theoretical 1M window as EVE's usable budget.
 */
export const EVE_CLOUD_CONTEXT_LIMIT = COMMAND_EVE_OPERATIONAL_CONTEXT_LIMIT;

/**
 * True iff `modelId` denotes the EVE cloud inference lane (any tier:
 * standard/high/xhigh/max/ultra), whose operational context window is the
 * 256K cloud contract, NOT
 * the local-runtime `acp_context_usage.size` (which is the Ollama memory cap).
 *
 * Matches the cloud model slugs (GLM/DeepSeek/Kimi), the EVE inference provider id,
 * and the bare wire tier values the request_trace may carry. Deliberately does
 * NOT match local Gemma ids (those keep the live 64k size as truth).
 */
export function isEveCloudModelId(modelName: string | undefined | null): boolean {
  if (!modelName) return false;
  const id = modelName.toLowerCase();
  // Local lane never qualifies — its 64k live size is the real window.
  if (id.includes('gemma') || id.includes('command-eve-gemma')) return false;
  return (
    id.includes('command-eve-inference') ||
    id.includes('glm-5.2') ||
    id.includes('deepseek-v4') ||
    id.includes('kimi-k2.6') ||
    id.includes('kimi-k3') ||
    // The EVE Inference selection ids (and their bare tier forms) the picker
    // persists — e.g. "command-eve-inference:eve-max" (caught above) or a bare
    // "eve-max"/"eve-high"/"eve-standard" if the prefix was ever stripped.
    id === 'eve-standard' ||
    id === 'eve-high' ||
    id === 'eve-xhigh' ||
    id === 'eve-max' ||
    id === 'eve-ultra' ||
    id === 'standard' ||
    id === 'high' ||
    id === 'xhigh' ||
    id === 'max' ||
    id === 'ultra'
  );
}

/**
 * 根据模型名称获取 context limit
 * 支持模糊匹配，例如 "gemini-2.5-pro-latest" 会匹配 "gemini-2.5-pro"
 */
export function getModelContextLimit(modelName: string | undefined | null): number {
  if (!modelName) return DEFAULT_CONTEXT_LIMIT;

  const lowerModelName = modelName.toLowerCase();

  // 精确匹配
  if (MODEL_CONTEXT_LIMITS[lowerModelName]) {
    return MODEL_CONTEXT_LIMITS[lowerModelName];
  }

  // 模糊匹配：查找最长匹配的模型名
  let bestMatch = '';
  let bestLimit = DEFAULT_CONTEXT_LIMIT;

  for (const [key, limit] of Object.entries(MODEL_CONTEXT_LIMITS)) {
    if (lowerModelName.includes(key) && key.length > bestMatch.length) {
      bestMatch = key;
      bestLimit = limit;
    }
  }

  return bestLimit;
}

/**
 * Resolve the context window to DISPLAY/USE for a model, given the optional LIVE
 * runtime size from Hermes' `acp_context_usage` frame.
 *
 *  - LOCAL lane: the live `size` is the hardware-safe runtime truth.
 *  - CLOUD lane (EVE inference): every provider is operationally capped at 256K,
 *    even if its advertised window is 1M or larger.
 *  - Other/unknown remote models are clamped to the same 256K ceiling, while
 *    genuinely smaller model windows stay smaller.
 *
 * Compaction is intentionally NOT modeled here: the displayed window is the
 * model's real capacity; Hermes still compacts at its own (separate) threshold.
 */
export function resolveEffectiveContextLimit(
  modelName: string | undefined | null,
  liveContextLimit?: number | null
): number {
  const live = typeof liveContextLimit === 'number' && liveContextLimit > 0 ? liveContextLimit : 0;
  const registry = getModelContextLimit(modelName);

  if (isEveCloudModelId(modelName)) {
    return EVE_CLOUD_CONTEXT_LIMIT;
  }

  // Local / unknown: trust a smaller live runtime cap, but never expose a larger
  // provider window than EVE's universal operating contract.
  return Math.min(live > 0 ? live : registry, COMMAND_EVE_OPERATIONAL_CONTEXT_LIMIT);
}

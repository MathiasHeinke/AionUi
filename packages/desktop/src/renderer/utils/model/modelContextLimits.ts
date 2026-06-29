/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

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

  // ── Command EVE cloud lane (eve-inference → OpenRouter) ──────────────────
  // All three EVE cloud tiers serve a 1M-context model (FACT: OpenRouter catalog
  // 2026-06-27, context_length=1_048_576 each): Standard=DeepSeek V4 Flash,
  // Hoch=DeepSeek V4 Pro, Max=GLM 5.2. Keyed by BOTH the model slug AND the EVE
  // selection prefix, so the fuzzy fallback resolves whichever id the request_trace
  // carries — the founder's point: GLM must NOT read as 64k like a local model.
  'z-ai/glm-5.2': 1_048_576,
  'glm-5.2': 1_048_576,
  'deepseek/deepseek-v4-pro': 1_048_576,
  'deepseek/deepseek-v4-flash': 1_048_576,
  'deepseek-v4-pro': 1_048_576,
  'deepseek-v4-flash': 1_048_576,
  'deepseek-v4': 1_048_576,
  'command-eve-inference': 1_048_576, // any EVE cloud tier (eve-standard/high/max)

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
 * 默认 context limit（当无法确定模型时使用）
 */
export const DEFAULT_CONTEXT_LIMIT = 1_048_576;

/**
 * The EVE CLOUD lane's true context window (all three cloud tiers serve a
 * 1M-context model — FACT modelContextLimits above + OpenRouter catalog).
 *
 * WHY a named constant the resolver leans on: the live `acp_context_usage.size`
 * frame Hermes emits carries the runtime's CONFIGURED `context_length`, which on
 * a Command EVE build is the LOCAL Ollama `ollama_num_ctx` memory cap (64k on the
 * M1 16GB baseline, bounded to ≤262144 in runtimeBootstrapCore). Hermes reports
 * that SAME 64k window on CLOUD turns too (one managed config, not per-lane), so
 * a naive "live size always wins" pins the cloud Max model (GLM 5.2, 1M) at 64k —
 * exactly the founder's "Kontextfenster auf 64K trotz Cloud Max Model?". The
 * model's real window must follow the MODEL on the cloud lane, so the cloud
 * resolver floors the displayed window at the model's registry size and never
 * lets the local-runtime compaction cap shrink it. (Auto-compaction still fires
 * at its own threshold — that is a separate Hermes concern, decoupled here.)
 */
export const EVE_CLOUD_CONTEXT_LIMIT = 1_048_576;

/**
 * True iff `modelId` denotes the EVE cloud inference lane (any tier:
 * standard/high/max), whose real context window is the large cloud window, NOT
 * the local-runtime `acp_context_usage.size` (which is the Ollama memory cap).
 *
 * Matches the cloud model slugs (GLM/DeepSeek), the EVE inference provider id,
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
    // The EVE Inference selection ids (and their bare tier forms) the picker
    // persists — e.g. "command-eve-inference:eve-max" (caught above) or a bare
    // "eve-max"/"eve-high"/"eve-standard" if the prefix was ever stripped.
    id === 'eve-standard' ||
    id === 'eve-high' ||
    id === 'eve-max' ||
    id === 'standard' ||
    id === 'high' ||
    id === 'max'
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
 *  - LOCAL lane (and unknown models): the live `size` is the truth — it IS the
 *    real runtime window — so it wins when present; else the registry; else 1M.
 *  - CLOUD lane (EVE inference): the window follows the MODEL. The live `size` is
 *    the local-runtime compaction cap (64k) misreported on cloud turns, so we
 *    FLOOR at the model's registry window and never let that cap shrink it. This
 *    is what makes "EVE Cloud · Max" read as its real ~1M window, not 64k.
 *
 * Compaction is intentionally NOT modeled here: the displayed window is the
 * model's real capacity; Hermes still compacts at its own (separate) threshold.
 */
export function resolveEffectiveContextLimit(modelName: string | undefined | null, liveContextLimit?: number | null): number {
  const live = typeof liveContextLimit === 'number' && liveContextLimit > 0 ? liveContextLimit : 0;
  const registry = getModelContextLimit(modelName);

  if (isEveCloudModelId(modelName)) {
    // Cloud: the model's window is the floor; a smaller live cap can't shrink it.
    // A bare tier id (e.g. "max") resolves to the 1M DEFAULT via getModelContextLimit;
    // EVE_CLOUD_CONTEXT_LIMIT keeps the floor explicit even if the registry ever
    // returns a smaller default for an as-yet-unmapped cloud id.
    return Math.max(registry, EVE_CLOUD_CONTEXT_LIMIT, live);
  }

  // Local / unknown: the live runtime size is the real window when we have one.
  return live > 0 ? live : registry;
}

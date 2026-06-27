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

/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * THE CLOUD MODEL IDENTIFIER CONTRACT — COMMON LAYER, ON PURPOSE.
 *
 * The founder mandate is that no surface ever renders a provider/model id. Two
 * independent scrubs enforce it and they used to have DIFFERENT strength:
 *
 *   RENDERER — `scrubModelIdentifiers(text, CLOUD_MODEL_IDENTIFIERS)`: shape rule
 *              (`vendor/model`) PLUS the concrete deny-list, so it also catches a
 *              BARE model name.
 *   PROCESS  — `scrubUpstreamErrorBody` in the Ollama shim: shape rule ONLY. An
 *              upstream body naming `kimi-k3` without its vendor prefix went
 *              through untouched, on the path that carries the most upstream text
 *              of any in the product.
 *
 * The obvious fix — have the process import the renderer's deny-list — is exactly
 * the architecture violation the project forbids (main must not import renderer;
 * see AGENTS.md "never mix their APIs"). So the CONTRACT moves down to `common/`,
 * which both processes may import, and neither side reaches across.
 *
 * WHAT LIVES HERE vs WHAT STAYS IN THE RENDERER. This module owns (a) the models
 * EVE ITSELF SERVES and (b) the derivation RULE. The renderer keeps its much wider
 * BYOK provider catalog (gemini/gpt/claude/…) in `modelContextLimits.ts`, because
 * a context-window table is a renderer display concern and the main process has no
 * use for it. The renderer's deny-list is therefore the union: its own table PLUS
 * this list. The process side uses this list alone, which is complete FOR THE
 * PROCESS — the only upstream the shim proxies is the eve-inference lane, so the
 * only model ids its error bodies can name are the ones below.
 */

/**
 * The model ids the eve-inference Edge Function actually routes to, mirrored from
 * its `MODEL_BY_TIER` (supabase/functions/_shared/eve-inference-core.ts).
 *
 * CURRENT AND HISTORICAL IDS BOTH MATTER. The paid Standard/High routes now use
 * `openai/gpt-5.6-luna` and xhigh/max use `moonshotai/kimi-k3` (ladder switch
 * 2026-08-18, frontier lane decided by the measured MAX evaluation); the retired
 * Grok/Gemini/DeepSeek/GLM ids remain possible in older error bodies. Substring
 * matching must know the most specific form first, otherwise a dated id can leave
 * a residue such as `…-0731` in the user's error message.
 *
 * MIRRORING IS A HUMAN STEP, and it is stated rather than implied: this is a
 * separate repo from the Edge Function, so nothing mechanically links the two. A
 * new pin has to be added here. The cost of forgetting is a scrub that misses one
 * id, not a broken lane — which is why the list is allowed to be a mirror at all.
 */
export const EVE_SERVED_MODEL_IDS: readonly string[] = Object.freeze([
  // wire tiers `standard` and `high` — current paid routes (effort-differentiated)
  'openai/gpt-5.6-luna',
  // wire tiers `xhigh` and `max` — current paid routes (effort-differentiated)
  'moonshotai/kimi-k3',
  // wire tiers `xhigh`/`max` — held the frontier lane for part of 2026-08-18 only,
  // retired when the measured MAX evaluation put Kimi K3 ahead. Still scrubbed.
  'x-ai/grok-4.6',
  // wire tier `standard` — retired 2026-08-18, still scrubbed from old bodies
  'google/gemini-3.7-flash',
  // wire tier `standard` — dated pin
  'deepseek/deepseek-v4-flash-0731',
  // the floating alias the pin was chosen over: still scrubbed, since an upstream
  // body may echo whichever form it likes.
  'deepseek/deepseek-v4-flash',
  // wire tier `high`
  'deepseek/deepseek-v4-pro',
  // wire tier `xhigh`
  'z-ai/glm-5.2',
]);

/**
 * Derive the deny-list from a set of model ids: every id contributes BOTH its full
 * slug and its BARE segment (`moonshotai/kimi-k3` → also `kimi-k3`).
 *
 * WHY BOTH FORMS. The shape rule already catches `vendor/model` on its own, so a
 * slug-only list adds nothing; the bare name is the form a slug-only list could
 * not see, and it is what an upstream body carries when it names the model without
 * its vendor prefix.
 *
 * THE DIGIT FILTER IS A PROSE GUARD, not a tidy-up. Entries are matched as
 * case-insensitive SUBSTRINGS with no word boundary, so a bare vendor word
 * ("deepseek", "moonshotai") would mangle ordinary sentences — and would silently
 * rewrite text that never named a model. Every real model name carries a digit; no
 * ordinary word does. Vendor segments are therefore deliberately excluded, and the
 * shape rule covers them wherever they appear attached to a model.
 *
 * LONGEST FIRST. The dated pin and the alias it extends both match the same text,
 * and replacing the SHORTER one first leaves the date fragment behind. Sorting by
 * descending length makes the most specific id win, which is what turns "residue"
 * into "scrubbed" — see the residue note on EVE_SERVED_MODEL_IDS.
 */
export function deriveCloudModelIdentifiers(rawIds: Iterable<string>): readonly string[] {
  const expanded = new Set<string>();
  for (const id of rawIds) {
    if (typeof id !== 'string' || id.length === 0) continue;
    expanded.add(id);
    if (id.includes('/')) expanded.add(id.slice(id.indexOf('/') + 1));
  }
  return Object.freeze(
    Array.from(expanded)
      .filter((id) => /[0-9]/.test(id))
      .sort((a, b) => b.length - a.length || a.localeCompare(b))
  );
}

/**
 * The deny-list the MAIN PROCESS uses. Complete for its scope: the shim proxies
 * exactly one upstream (eve-inference), so these are the only model ids its error
 * bodies can name.
 */
export const EVE_SERVED_MODEL_IDENTIFIERS: readonly string[] = deriveCloudModelIdentifiers(EVE_SERVED_MODEL_IDS);

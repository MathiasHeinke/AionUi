/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Pure helpers for the LOCAL auto session-title lane (1.2.13).
 *
 * After the FIRST user message in a NEW conversation the renderer asks the main
 * process to summarize the task into a short 3-6 word title using the bundled
 * ON-DEVICE Gemma model (free + private; never the cloud/credits lane). These
 * helpers are the pure, unit-testable parts: the prompt builder, the Ollama
 * model picker, and the sanitizer that turns a raw model reply into a clean
 * one-line title (or null when the reply is unusable → caller keeps the
 * truncated fallback title).
 */

/** The Ollama model-name prefix the runtime registers the bundled tiers under. */
export const COMMAND_EVE_LOCAL_OLLAMA_MODEL_PREFIX = 'command-eve';

/** Max characters for a generated title (a short, scannable sidebar label). */
export const COMMAND_EVE_TITLE_MAX_CHARS = 48;

/** Hard cap on how much of the user's first message we feed the title prompt. */
const TITLE_INPUT_MAX_CHARS = 1200;

export type CommandEveTitleLocale = 'de-DE' | 'en-US';

export type CommandEveTitleSmokeReason =
  | 'TITLE_SMOKE_EMPTY'
  | 'TITLE_SMOKE_TOO_SHORT'
  | 'TITLE_SMOKE_TOO_LONG'
  | 'TITLE_SMOKE_ECHOED_PROMPT'
  | 'TITLE_SMOKE_OFF_TOPIC';

export interface CommandEveTitleSmokeGateResult {
  ok: boolean;
  title: string | null;
  reason_code?: CommandEveTitleSmokeReason;
}

/**
 * Build the tight title prompt. Locale-aware so a German task gets a German
 * title and an English task gets an English one. The instruction forbids end
 * punctuation and asks for 3-6 words so the sanitizer rarely has to trim.
 */
export function buildLocalTitlePrompt(taskText: string, locale: CommandEveTitleLocale = 'de-DE'): string {
  const task = String(taskText || '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, TITLE_INPUT_MAX_CHARS);
  if (locale === 'en-US') {
    return [
      'Summarize this task as a short, punchy session title (3-6 words, no trailing punctuation, no quotes).',
      'Answer with the title only — nothing else.',
      `Task: ${task}`,
    ].join('\n');
  }
  return [
    'Fasse diese Aufgabe in einen kurzen, prägnanten Session-Titel (3-6 Wörter, kein Satzzeichen am Ende, keine Anführungszeichen).',
    'Antworte nur mit dem Titel — sonst nichts.',
    `Aufgabe: ${task}`,
  ].join('\n');
}

/**
 * Pick the bundled local Gemma model from an Ollama `/api/tags` model list.
 * Prefers the smallest bundled tier (e4b) — the founder spec: e4b is plenty for
 * a 3-6 word title and it is the model most likely already warm. Falls back to
 * ANY `command-eve-*` model, then returns null (caller keeps the fallback title).
 */
export function pickLocalTitleModel(modelNames: string[]): string | null {
  const names = (modelNames || []).map((n) => String(n || '').trim()).filter(Boolean);
  const ours = names.filter((n) => n.toLowerCase().startsWith(`${COMMAND_EVE_LOCAL_OLLAMA_MODEL_PREFIX}-`));
  if (ours.length === 0) return null;
  // Prefer the e4b tier (smallest/fastest), else the first managed model.
  const e4b = ours.find((n) => /gemma4?-e4b/i.test(n));
  return e4b ?? ours[0];
}

/**
 * Turn a raw model reply into a clean title, or null if unusable.
 *
 * Strips: <think> blocks, surrounding quotes, markdown bullets/headings, a
 * leading "Titel:" / "Title:" label, trailing punctuation. Collapses whitespace,
 * keeps the FIRST non-empty line only, and clamps to a word + char budget. A
 * reply that survives to <2 chars (or is obviously a refusal/echo of the
 * instruction) returns null.
 */
export function sanitizeGeneratedTitle(raw: string | null | undefined): string | null {
  let text = String(raw ?? '');
  // Drop chain-of-thought blocks some models emit.
  text = text.replace(/<think>[\s\S]*?<\/think>/gi, ' ');
  // First non-empty line only.
  const firstLine = text
    .replace(/\r/g, '')
    .split('\n')
    .map((l) => l.trim())
    .find((l) => l.length > 0);
  if (!firstLine) return null;

  let title = firstLine
    // Strip a leading "Titel:" / "Title:" label.
    .replace(/^\s*(titel|title)\s*[:：]\s*/i, '')
    // Strip markdown bullets/heading/quote markers.
    .replace(/^[#>*\-\d.\s]+/u, '')
    // Strip wrapping quotes (straight or smart).
    .replace(/^["'“”«»‟]+/u, '')
    .replace(/["'“”«»‟]+$/u, '')
    // Collapse whitespace.
    .replace(/\s+/g, ' ')
    .trim()
    // Drop trailing sentence punctuation.
    .replace(/[.。!！?？,;:、]+$/u, '')
    .trim();

  if (!title) return null;

  // Word budget: keep it short (≤ 8 words to be safe), then clamp chars.
  const words = title.split(' ');
  if (words.length > 8) {
    title = words.slice(0, 8).join(' ');
  }
  if (title.length > COMMAND_EVE_TITLE_MAX_CHARS) {
    title = title.slice(0, COMMAND_EVE_TITLE_MAX_CHARS).trim();
  }

  // Too short to be a real title → let the caller keep the fallback.
  if (title.length < 2) return null;
  return title;
}

function normalizeSmokeText(text: string): string {
  return text
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase();
}

function firstRawSmokeLine(raw: string | null | undefined): string {
  return (
    String(raw ?? '')
      .replace(/<think>[\s\S]*?<\/think>/gi, ' ')
      .replace(/\r/g, '')
      .split('\n')
      .map((line) => line.trim())
      .find(Boolean) ?? ''
  );
}

/**
 * Evaluate a real local Gemma title answer for the release smoke gate.
 *
 * The runtime title path remains best-effort and fail-quiet for users, but the
 * gate must be fail-loud: if Gemma returns empty output, prompt echo, an
 * overlong rambly answer, or a title that misses every expected topic token,
 * the release operator gets a hard reason code instead of silent degradation.
 */
export function evaluateLocalTitleSmokeGate(
  raw: string | null | undefined,
  expectedTerms: readonly string[] = []
): CommandEveTitleSmokeGateResult {
  const firstLine = firstRawSmokeLine(raw);
  const title = sanitizeGeneratedTitle(raw);
  if (!title) return { ok: false, title: null, reason_code: 'TITLE_SMOKE_EMPTY' };

  const rawWords = firstLine.split(/\s+/).filter(Boolean);
  if (rawWords.length > 12 || firstLine.length > 96) {
    return { ok: false, title, reason_code: 'TITLE_SMOKE_TOO_LONG' };
  }

  const words = title.split(/\s+/).filter(Boolean);
  if (words.length < 2) return { ok: false, title, reason_code: 'TITLE_SMOKE_TOO_SHORT' };
  if (words.length > 8 || title.length > COMMAND_EVE_TITLE_MAX_CHARS) {
    return { ok: false, title, reason_code: 'TITLE_SMOKE_TOO_LONG' };
  }

  const normalizedTitle = normalizeSmokeText(title);
  if (/\b(task|aufgabe|user|eve|summarize|fasse|antworte)\b/i.test(title)) {
    return { ok: false, title, reason_code: 'TITLE_SMOKE_ECHOED_PROMPT' };
  }

  const terms = expectedTerms.map((term) => normalizeSmokeText(String(term || '').trim())).filter(Boolean);
  if (terms.length > 0 && !terms.some((term) => normalizedTitle.includes(term))) {
    return { ok: false, title, reason_code: 'TITLE_SMOKE_OFF_TOPIC' };
  }

  return { ok: true, title };
}

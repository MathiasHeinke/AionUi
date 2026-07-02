/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * L3 SESSION-DIGEST WRITER (v1.4 T5) — the pure, injectable core.
 *
 * WHAT. When a conversation turn goes quiet (a debounce window elapses, or the turn
 * lands in a terminal state), the RENDERER relays a request over IPC. This MAIN-side
 * core then: fetches the transcript over the local backend HTTP (compact, last ~30
 * messages), extracts the user + assistant text, HARD-CAPS it, summarizes it with the
 * BUNDLED local Ollama model (fail-quiet — never the cloud/credits lane, PII stays on
 * device), and persists ONE `session_digest` entry into the ACTIVE seat's Company
 * Brain under a STABLE id (`sd-<conversation>`), then FIFO-prunes to ≤50 per seat.
 *
 * WHY MAIN-SIDE + RENDERER-TRIGGERED. `turn.completed` is a backend WS event that ONLY
 * the renderer receives (the httpBridge WS is a renderer singleton; main has no WS
 * client — a main-side subscription would be a silent no-op). So the trigger MUST come
 * from the renderer; the WORK (local inference + a per-seat brain write) belongs in
 * main (it can reach Ollama + the seat home; the renderer must not).
 *
 * WHY A LOCAL DIGEST, NEVER RAW TEXT. On any Ollama failure we write NOTHING — we do
 * NOT fall back to dumping the raw transcript into the brain (a raw transcript in a
 * durable per-client store is a privacy hazard). No digest is an honest, safe outcome;
 * the next turn's relay tries again.
 *
 * PURE / INJECTABLE. This module owns NO fs, NO fetch, NO Electron and NO active-seat
 * resolution. `runSessionDigest(deps, input)` takes everything it touches as an
 * injected dependency (fetchTranscript / generateDigest / writeDigestEntry / pruneDigests
 * / isSwitchInFlight / now), so it unit-tests with plain fakes. The bridge wires the
 * REAL implementations (backend HTTP + Ollama + companyBrainStoreCore) around it.
 *
 * HONEST v1.4 LIMITS (documented, not hidden). The trigger only fires while a window
 * is open (renderer relay) — a closed window means no digest until the NEXT anchor
 * (the pre-switch flush awaits only an ALREADY-running digest, it does not start a new
 * one; there is NO quit-flush because quit's 10s budget stops the backend, leaving no
 * room for inference). So digests are best-effort coverage, never a guarantee of one
 * digest per turn.
 */

/** The runtime turn states that are TERMINAL (turn finished for now). */
export type TerminalTurnState = 'ai_waiting_input' | 'error' | 'stopped';

/**
 * The state-machine mirror of useConversationListSync's isTerminalTurnState — kept
 * IN SYNC deliberately (the relay uses this exported copy so the two never drift).
 *
 * STATE-DEFAULT FALLE (spec + T2-store note). The turn.completed mapper defaults a
 * MISSING `state` to 'ai_waiting_input' ONLY when status==='finished', else to
 * 'unknown'. 'unknown' is NOT terminal here — so a turn with no explicit state and a
 * non-finished status does NOT fire an immediate digest; it waits for the debounce
 * (or a later, explicitly-terminal event). This guard treats ONLY the three real
 * terminal states as terminal; everything else (including 'unknown', 'ai_generating',
 * 'ai_waiting_confirmation', 'initializing') is non-terminal.
 */
export function isTerminalTurnState(state: string | undefined | null): state is TerminalTurnState {
  return state === 'ai_waiting_input' || state === 'error' || state === 'stopped';
}

/** One transcript message as it matters to the digest (role + text). */
export interface DigestMessage {
  role: 'user' | 'assistant';
  text: string;
}

/** Hard input cap (characters) fed to the local model — keeps a big session cheap. */
export const DIGEST_INPUT_CHAR_CAP = 6000;

/** Hard output cap (characters) for the persisted digest body. */
export const DIGEST_OUTPUT_CHAR_CAP = 600;

/** How many recent messages to request from the backend (compact). */
export const DIGEST_MESSAGE_WINDOW = 30;

/**
 * EXTRACT the user + assistant TEXT from a raw backend message list (content_mode
 * 'compact'). Defensive by design — the backend/compact shape is not the renderer's
 * normalized TMessage, so we tolerate several encodings:
 *   • role: an explicit `role`/`sender` field ('user' | 'assistant'), else inferred
 *     from `position` ('right' → user, 'left' → assistant). Anything else is dropped.
 *   • text: a `text`-type message's `content.content` (string), or a bare string
 *     `content`, or a `content.text`. Non-text message types (tool_call, tool_group,
 *     plan, thinking, agent_status, permission, tips, …) carry NO durable turn text
 *     and are skipped. Empty/whitespace text is dropped.
 * Never throws — a malformed row is skipped, not fatal.
 */
export function extractTranscriptText(items: unknown): DigestMessage[] {
  if (!Array.isArray(items)) return [];
  const out: DigestMessage[] = [];
  for (const raw of items) {
    if (!raw || typeof raw !== 'object') continue;
    const rec = raw as Record<string, unknown>;

    // Only plain text turns carry durable user/assistant prose. A missing type is
    // tolerated (some compact rows omit it) as long as we can find text below.
    const type = typeof rec.type === 'string' ? rec.type : undefined;
    if (type && type !== 'text' && type !== 'user_content') continue;

    const role = resolveRole(rec);
    if (!role) continue;

    const text = resolveText(rec.content);
    if (!text) continue;

    out.push({ role, text });
  }
  return out;
}

const resolveRole = (rec: Record<string, unknown>): 'user' | 'assistant' | null => {
  const explicit = typeof rec.role === 'string' ? rec.role : typeof rec.sender === 'string' ? (rec.sender as string) : undefined;
  if (explicit === 'user') return 'user';
  if (explicit === 'assistant' || explicit === 'ai' || explicit === 'agent') return 'assistant';
  const position = typeof rec.position === 'string' ? rec.position : undefined;
  if (position === 'right') return 'user';
  if (position === 'left') return 'assistant';
  return null;
};

const resolveText = (content: unknown): string => {
  if (typeof content === 'string') return content.trim();
  if (content && typeof content === 'object') {
    const c = content as Record<string, unknown>;
    if (typeof c.content === 'string') return c.content.trim();
    if (typeof c.text === 'string') return c.text.trim();
  }
  return '';
};

/**
 * Render the extracted messages into a single capped transcript string. Newest
 * messages matter most, so if the joined text exceeds the cap we keep the TAIL
 * (most recent) and drop the oldest. Roles are labelled in German (the digest prompt
 * is German). Returns '' when there is no usable text (caller writes no digest).
 */
export function clampTranscript(messages: DigestMessage[], cap: number = DIGEST_INPUT_CHAR_CAP): string {
  const labelled = messages
    .map((m) => ({ role: m.role, text: m.text.replace(/\s+/g, ' ').trim() }))
    .filter((m) => m.text.length > 0)
    .map((m) => `${m.role === 'user' ? 'Nutzer' : 'EVE'}: ${m.text}`);
  if (labelled.length === 0) return '';

  // Keep the most-recent lines that fit under the cap (tail-first).
  const kept: string[] = [];
  let used = 0;
  for (let i = labelled.length - 1; i >= 0; i -= 1) {
    const line = labelled[i];
    const add = line.length + 1; // +1 for the join newline
    if (used + add > cap && kept.length > 0) break;
    kept.unshift(line);
    used += add;
    if (used >= cap) break;
  }
  const joined = kept.join('\n');
  return joined.length > cap ? joined.slice(joined.length - cap) : joined;
}

/**
 * Build the German digest prompt. The instruction is deliberately plain — "worum ging
 * es, was wurde entschieden/erzeugt, welche offenen Punkte" — and EXPLICITLY forbids a
 * marketing tone, so the digest reads like a factual work note, not ad copy. The ≤600c
 * limit is stated to the model AND enforced afterward (sanitizeDigest).
 */
export function buildDigestPrompt(transcript: string): string {
  return [
    'Du fasst eine Arbeits-Session zwischen einem Nutzer und der KI-Assistentin EVE zusammen.',
    'Schreibe eine NÜCHTERNE Notiz auf Deutsch, höchstens 600 Zeichen, in Prosa oder knappen Stichpunkten:',
    '1) Worum ging es? 2) Was wurde entschieden oder erzeugt? 3) Welche offenen Punkte bleiben?',
    'KEIN Marketing-Ton, keine Floskeln, keine Anrede, keine Emojis. Nur der Inhalt.',
    '',
    'Transkript:',
    transcript,
  ].join('\n');
}

/**
 * Clean + hard-cap the model's raw output into a digest body. Trims, collapses
 * excessive blank lines, strips surrounding quotes/backticks a small model sometimes
 * wraps around its answer, and truncates to ≤600 chars (on a word boundary near the
 * cap, with an ellipsis). Returns '' for empty/whitespace output so the caller writes
 * no digest.
 */
export function sanitizeDigest(raw: string | undefined | null, cap: number = DIGEST_OUTPUT_CHAR_CAP): string {
  let text = String(raw ?? '').replace(/\r\n/g, '\n').trim();
  if (!text) return '';
  // Strip a single wrapping pair of quotes/backticks/code-fence the model may add.
  text = text.replace(/^```[a-z]*\n?/i, '').replace(/\n?```$/i, '').trim();
  if ((text.startsWith('"') && text.endsWith('"')) || (text.startsWith('“') && text.endsWith('”'))) {
    text = text.slice(1, -1).trim();
  }
  text = text.replace(/\n{3,}/g, '\n\n').trim();
  if (!text) return '';
  if (text.length <= cap) return text;
  const cut = text.slice(0, cap);
  const lastSpace = cut.lastIndexOf(' ');
  const base = lastSpace > cap * 0.6 ? cut.slice(0, lastSpace) : cut;
  return `${base.trimEnd()}…`;
}

/** [a-z0-9-] only. Keeps a conversation id fit to embed in a bare entry-id slug. */
const slugifyConversationId = (conversationId: string): string =>
  conversationId
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40);

/**
 * STABLE per-conversation digest id: `sd-<conversation-slug>`. Stable so a RE-DIGEST
 * of the same conversation REPLACES the prior digest (upsertSystemEntry UPDATE) rather
 * than duplicating it. If the conversation id has no [a-z0-9] characters at all, a
 * short hash keeps the id non-empty and safe. Bounded to 64 chars (assertEntryId cap).
 */
export function stableDigestId(conversationId: string): string {
  const slug = slugifyConversationId(conversationId);
  const base = slug.length > 0 ? `sd-${slug}` : `sd-${fallbackHash(conversationId)}`;
  return base.slice(0, 64).replace(/-+$/g, '') || `sd-${fallbackHash(conversationId)}`;
}

const fallbackHash = (input: string): string => {
  let h = 0;
  for (let i = 0; i < input.length; i += 1) {
    h = (h * 31 + input.charCodeAt(i)) >>> 0;
  }
  return h.toString(36).slice(0, 10);
};

/** The reason a digest run resolved without writing (audit/test). */
export type SessionDigestOutcome =
  | 'written' // a digest entry was written (or updated)
  | 'switch_in_flight' // fenced — a seat switch was in progress
  | 'no_conversation' // no conversation id
  | 'no_transcript' // no usable user/assistant text
  | 'no_digest' // Ollama returned nothing / failed (fail-quiet)
  | 'error'; // an unexpected throw (still non-fatal to the caller)

export interface SessionDigestResult {
  ok: boolean;
  outcome: SessionDigestOutcome;
  /** The stable entry id, when a digest was written. */
  id?: string;
  /** How many stale digests the FIFO prune removed after this write. */
  pruned?: number;
}

export interface SessionDigestDeps {
  /** True while a seat switch is in flight — a digest must be fenced (no cross-seat write). */
  isSwitchInFlight: () => boolean;
  /** Fetch the recent transcript for a conversation (compact). Returns the raw message list. */
  fetchTranscript: (conversationId: string, window: number) => Promise<unknown>;
  /** The conversation TITLE if the transcript fetch surfaced one (else undefined). */
  resolveTitle?: (conversationId: string) => Promise<string | undefined>;
  /** Summarize the capped transcript with the local model. Fail-quiet ⇒ returns null. */
  generateDigest: (prompt: string) => Promise<string | null>;
  /** Persist the digest as a session_digest entry (upsertSystemEntry wrapper). */
  writeDigestEntry: (input: { id: string; title: string; body: string; now?: () => Date }) => void;
  /** FIFO-prune session digests to the per-seat cap; returns how many were pruned. */
  pruneDigests: () => number;
  /** Injectable clock (ISO timestamps in the entry + a "Session <datum>" fallback title). */
  now?: () => Date;
}

export interface SessionDigestInput {
  conversationId: string;
}

/**
 * ORCHESTRATE one digest run. Ordered, fail-safe, injectable:
 *   1) FENCE — if a seat switch is in flight, refuse (no cross-seat digest).
 *   2) FETCH — pull the recent transcript (compact) and extract user+assistant text.
 *   3) CAP — clamp to DIGEST_INPUT_CHAR_CAP; no usable text ⇒ no digest.
 *   4) SUMMARIZE — local Ollama; fail-quiet ⇒ NO entry, NO raw-text fallback.
 *   5) WRITE — one session_digest entry under a stable id (re-digest REPLACES).
 *   6) PRUNE — FIFO to the per-seat cap.
 * Never throws — any unexpected error resolves as { ok:false, outcome:'error' } so a
 * failed digest can never break the turn or the seat-switch flush that awaits it.
 */
export async function runSessionDigest(deps: SessionDigestDeps, input: SessionDigestInput): Promise<SessionDigestResult> {
  try {
    const conversationId = String(input?.conversationId ?? '').trim();
    if (!conversationId) return { ok: false, outcome: 'no_conversation' };

    // 1) FENCE.
    if (deps.isSwitchInFlight()) return { ok: false, outcome: 'switch_in_flight' };

    // 2) FETCH + extract.
    const rawItems = await deps.fetchTranscript(conversationId, DIGEST_MESSAGE_WINDOW);
    const messages = extractTranscriptText(rawItems);

    // 3) CAP.
    const transcript = clampTranscript(messages);
    if (!transcript) return { ok: false, outcome: 'no_transcript' };

    // 4) SUMMARIZE (fail-quiet). Re-check the fence AFTER the (async) inference — a
    //    switch may have STARTED while the local model ran; writing now could land in
    //    the wrong seat. Refuse rather than risk a cross-seat digest.
    const raw = await deps.generateDigest(buildDigestPrompt(transcript));
    const body = sanitizeDigest(raw);
    if (!body) return { ok: false, outcome: 'no_digest' };
    if (deps.isSwitchInFlight()) return { ok: false, outcome: 'switch_in_flight' };

    // 5) WRITE (stable id ⇒ re-digest replaces).
    const id = stableDigestId(conversationId);
    const title = await resolveDigestTitle(deps, conversationId);
    deps.writeDigestEntry({ id, title, body, now: deps.now });

    // 6) PRUNE.
    const pruned = deps.pruneDigests();
    return { ok: true, outcome: 'written', id, pruned };
  } catch {
    // Non-fatal by contract — a broken digest must never break the turn.
    return { ok: false, outcome: 'error' };
  }
}

/**
 * Title = the conversation title if the deps can resolve one, else a dated fallback
 * "Session <YYYY-MM-DD>". Best-effort — a title resolver failure degrades to the date.
 */
async function resolveDigestTitle(deps: SessionDigestDeps, conversationId: string): Promise<string> {
  try {
    const title = (await deps.resolveTitle?.(conversationId))?.trim();
    if (title) return title.length > 120 ? `${title.slice(0, 119)}…` : title;
  } catch {
    /* fall through to the dated fallback */
  }
  const d = deps.now?.() ?? new Date();
  const iso = d.toISOString().slice(0, 10);
  return `Session ${iso}`;
}

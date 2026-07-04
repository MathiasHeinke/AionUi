/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import crypto from 'crypto';
import fs from 'fs';
import http, { type IncomingMessage, type ServerResponse } from 'http';
import path from 'path';
import {
  evaluateCommandEveEgressBoundary,
  redactCommandEveSensitiveTextAtOrAbove,
  writeCommandEveEgressBoundaryReceipt,
  type CommandEveEgressPolicyAction,
  type CommandEveSensitivityClass,
} from './egressBoundaryCore';
import {
  evaluateWorkerDispatch,
  type EveTeamWorkerStatusMap,
} from '../../common/config/eveTeamControlsCore';
import { EVE_INFERENCE_TIERS } from '../../common/config/eveInferenceCore';

/**
 * The known EVE wire tiers (registry SSOT) — derived from EVE_INFERENCE_TIERS so
 * a new tier in eveInferenceCore is automatically valid here. The shim uses this
 * to REFUSE an active EVE route whose tier is missing/unknown rather than
 * silently downgrade it to the cheapest model (HONEST TIER ROUTING, 1.2.19).
 */
const KNOWN_EVE_WIRE_TIERS: ReadonlySet<string> = new Set(EVE_INFERENCE_TIERS.map((t) => t.tier));

const DEFAULT_SHIM_PORT = 25811;
const DEFAULT_OLLAMA_BASE_URL = 'http://127.0.0.1:11434';
const DEFAULT_NUM_CTX = 32_768;
const DEFAULT_MAX_TOKENS = 512;

/**
 * Resolved EVE Inference (cloud) route for the CURRENT chat. The shim is the
 * single OpenAI-compatible egress chokepoint Hermes points its inference at
 * (config.yaml `model.base_url` = this shim). Hermes always sends the same
 * local model ref, so it cannot itself signal "the user picked an EVE cloud
 * tier" — therefore the shim asks this resolver, per request, whether to route
 * the call to the eve-inference Edge Function instead of local Ollama.
 *
 * The resolver is injected at shim startup (main process) so it can read the
 * live picker selection + the keychain-at-rest CEVE license; the shim core
 * itself stays pure and unit-testable (the resolver is a plain function).
 *
 * Returning `undefined` (or `{ active: false }`) keeps the request on the local
 * Ollama lane. Returning `{ active: true, functionUrl, license, tier }` routes
 * it to the function with `Authorization: Bearer <license>` and `tier` in body.
 */
export type CommandEveEveCloudRoute = {
  active: boolean;
  /** Absolute https URL of the eve-inference Edge Function. */
  functionUrl?: string;
  /** The CEVE license wire string used verbatim as the bearer credential. */
  license?: string;
  /** Wire tier value POSTed in the body (e.g. "standard"). */
  tier?: string;
};

/**
 * Per-request resolver: is the active selection an EVE cloud tier?
 *
 * MAY be async: the live picker selection lives in the aioncore BACKEND settings
 * store (the renderer's configService writes `commandEve.inferenceSelection` to
 * `/api/settings/client`, NOT to the main-process ProcessConfig JSON), so the
 * resolver reads it over HTTP per request. The shim awaits the result. A sync
 * resolver (returning the route directly) is still accepted for tests / the
 * no-op default.
 */
export type CommandEveEveRoutingResolver = () =>
  | CommandEveEveCloudRoute
  | undefined
  | Promise<CommandEveEveCloudRoute | undefined>;

/**
 * Per-request resolver for the persisted "Dein Team" worker-status map
 * (`commandEve.teamWorkerStatus`). Injected at shim startup (main process) so
 * the shim can READ the live pause/throttle/fire state and actually gate a
 * delegated worker's dispatch (DUX-4). Returns the status map, or `undefined`
 * when there is none — in which case every worker defaults to active (no-op
 * gating, exactly as before this resolver existed).
 *
 * MONEY-BUG NOTE (S9 #1): this resolver is now allowed to be ASYNC. The live
 * status map is persisted by the renderer to the BACKEND settings store, so the
 * main-process resolver must do a per-request backend READ to reflect a fire the
 * instant it happens (a fired worker must stop spending on the VERY NEXT
 * dispatch). The shim `await`s it. A sync resolver (tests / the no-op default)
 * is still accepted — awaiting a plain value is a no-op.
 */
export type CommandEveTeamStatusResolver = () =>
  | EveTeamWorkerStatusMap
  | undefined
  | Promise<EveTeamWorkerStatusMap | undefined>;

/**
 * Per-request resolver for the PER-SEAT PII/DSGVO egress-redaction mode
 * (`commandEve.egressRedactionMode`) — S11. Injected at shim startup (main
 * process) so the shim can READ the live on/off switch the settings card writes
 * to the BACKEND store. Returns `'on'` (redact — the default) or `'off'` (the
 * operator turned the filter off for this seat; skip redaction, but record it on
 * the receipt).
 *
 * MAY be async (the value is a per-request backend read, seat-scoped-aware) — the
 * shim `await`s it. When omitted, the shim behaves EXACTLY as before this switch
 * existed: it always redacts (the default resolver returns `'on'`), so the toggle
 * is purely additive and fail-SAFE by construction.
 */
export type CommandEveEgressRedactionModeResolver = () =>
  | 'on'
  | 'off'
  | Promise<'on' | 'off'>;

/**
 * Per-request resolver for the OPAQUE active-seat id (A3 per-seat usage
 * attribution). Returns `getActiveSeatId()` = `'seat-1'` (legacy/founder) or a
 * sanitized seat UUID — NEVER the display LABEL (H3: the seat name must never
 * leave the device). The shim spreads the returned id into the cloud outbound
 * body as `seat_id` so `usage_events.seat_id` can attribute the spend per seat;
 * the server allowlist keeps `seat_id` upstream-invisible (it is NOT in
 * FORWARDABLE_BODY_KEYS).
 *
 * MAY be async. When omitted, the default resolver returns the legacy
 * `'seat-1'`, so a build without the id injected behaves byte-identically to
 * before this field existed (the server treats `'seat-1'` and absent alike).
 */
export type CommandEveActiveSeatIdResolver = () => string | Promise<string>;

/**
 * Optional dispatch-attribution resolver (SG-1 A1 — spoof-close). Maps the
 * inbound `X-EVE-Dispatch` header token to a TRUSTED roster `agent_id`,
 * seat-partitioned. The shim NEVER trusts a client-sent `body.agent_id` again:
 * identity is carried by this CODE-minted token only (eveAgentTaskRegistry). When
 * omitted, the default returns the system default `eve` — which is also the 1.7.0
 * steady state, because the header PRODUCER (Hermes stamping the token on each
 * model call) is the 1.8 wheel train. Fail-open by design: any token that does
 * not resolve returns `eve` so the main lane never breaks.
 */
export type CommandEveDispatchAttributionResolver = (
  dispatchToken: string | undefined,
  seatId: string
) => string | Promise<string>;

export type CommandEveOllamaShimOptions = {
  port?: number;
  ollamaBaseUrl?: string;
  numCtx?: number;
  maxTokens?: number;
  promptProofPath?: string;
  egressReceiptPath?: string;
  egressPolicyAction?: CommandEveEgressPolicyAction;
  /**
   * Optional EVE cloud routing resolver. When omitted, the shim behaves exactly
   * as before (local Ollama only) — EVE routing is purely additive.
   */
  eveRouting?: CommandEveEveRoutingResolver;
  /**
   * Optional "Dein Team" worker-status resolver (DUX-4). When provided, the
   * EVE-cloud send path checks the delegated worker's status BEFORE dispatch and
   * refuses to dispatch a paused/off worker. When omitted, no gating is applied
   * (every worker is treated as active), so this is purely additive.
   */
  teamWorkerStatus?: CommandEveTeamStatusResolver;
  /**
   * Optional PER-SEAT PII/DSGVO egress-redaction-mode resolver (S11). When it
   * resolves to `'off'` the shim SKIPS redaction on the CLOUD lane for this seat
   * and stamps the egress receipt `redaction: 'disabled_by_operator'` (evidence,
   * never silent). `'on'`/omitted ⇒ redact as before (fail-safe). The LOCAL lane
   * never egresses, so it is never gated by this resolver.
   */
  egressRedactionMode?: CommandEveEgressRedactionModeResolver;
  /**
   * Optional OPAQUE active-seat-id resolver (A3 per-seat usage attribution).
   * Read ONCE at the start of a cloud request and spread into the outbound body
   * as `seat_id` (opaque id only, never the label — H3). When omitted, the
   * default resolver returns the legacy `'seat-1'` ⇒ byte-identical to before.
   */
  activeSeatId?: CommandEveActiveSeatIdResolver;
  /**
   * Optional dispatch-attribution resolver (SG-1 A1 spoof-close). Given the
   * inbound `X-EVE-Dispatch` header token + the active seat, returns the TRUSTED
   * roster `agent_id`. The old spoofable `body.agent_id` channel is closed — this
   * is the ONLY attribution source now. Omitted ⇒ always `eve`.
   */
  attributionAgentId?: CommandEveDispatchAttributionResolver;
};

export type CommandEveModelWarmupOptions = {
  baseUrl?: string;
  model: string;
  timeoutMs?: number;
  maxTokens?: number;
};

export type CommandEveModelWarmupResult = {
  ok: boolean;
  elapsedMs: number;
  model: string;
  error?: string;
};

export type CommandEveEveLaneWarmupOptions = {
  /** Loopback shim base URL the request is sent through (defaults to the running shim). */
  baseUrl?: string;
  /** Wire tier value (e.g. "standard") POSTed so the function routes correctly. */
  tier?: string;
  timeoutMs?: number;
};

export type CommandEveEveLaneWarmupResult = {
  ok: boolean;
  elapsedMs: number;
  /** Wire tier the preflight exercised. */
  tier: string;
  /** HTTP status the shim/function returned, when a response was received. */
  status?: number;
  error?: string;
};

export type CommandEvePromptProof = {
  version: 'command-eve-prompt-proof/v0';
  ok: boolean;
  observed_at: string;
  model: string;
  message_count: number;
  system_message_count: number;
  marker:
    | 'eve_you_are_here'
    | 'eve_soul'
    | 'eve_operating_rule'
    | 'command_eve_chief_of_staff'
    | 'command_eve_founder_intent'
    | 'none';
  prompt_sha256: string;
  roles: string[];
};

/**
 * Pure builder for the per-request EVE cloud route. Given the active picker
 * selection, the function URL, and the resolved EVE tier + license, return a
 * route the shim acts on. Kept pure (no fs, no config singletons) so it is
 * unit-testable; the main process supplies the live selection / license / URL.
 *
 * Returns `{ active: false }` for any non-EVE (local) selection, so the shim
 * falls through to the local Ollama lane.
 */
export function buildEveCloudRoute(args: {
  /** True iff the active picker selection is an EVE Inference (cloud) tier. */
  isEveSelection: boolean;
  /** Wire tier value (e.g. "standard") parsed from the selection. */
  tier?: string;
  /** Absolute https URL of the eve-inference Edge Function. */
  functionUrl?: string;
  /** The CEVE license wire string (bearer credential), or undefined if absent. */
  license?: string;
}): CommandEveEveCloudRoute {
  if (!args.isEveSelection) return { active: false };
  return {
    active: true,
    functionUrl: args.functionUrl,
    license: args.license,
    tier: args.tier,
  };
}

let server: http.Server | undefined;
let serverUrl = '';

function isLoopbackHttpUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return (
      url.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]', '::1'].includes(url.hostname) && Boolean(url.port)
    );
  } catch {
    return false;
  }
}

function chatCompletionsUrl(baseUrl: string): string {
  const normalized = baseUrl.replace(/\/+$/, '');
  return `${normalized.endsWith('/v1') ? normalized : `${normalized}/v1`}/chat/completions`;
}

function jsonResponse(response: ServerResponse, status: number, payload: unknown): void {
  response.writeHead(status, { 'content-type': 'application/json' });
  response.end(JSON.stringify(payload));
}

function readBody(request: IncomingMessage): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    let raw = '';
    request.setEncoding('utf8');
    request.on('data', (chunk) => {
      raw += chunk;
      if (raw.length > 25_000_000) {
        reject(new Error('request body too large'));
        request.destroy();
      }
    });
    request.on('end', () => {
      try {
        resolve(raw ? (JSON.parse(raw) as Record<string, unknown>) : {});
      } catch (error) {
        reject(error);
      }
    });
    request.on('error', reject);
  });
}

function asMessages(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

// SG-1 A1: read the X-EVE-Dispatch header value as a single trimmed token. Node
// lowercases header names and may give an array for repeated headers; take the
// first. Empty/whitespace → undefined (treated as "no token" → attribution `eve`).
function headerToken(value: string | string[] | undefined): string | undefined {
  if (Array.isArray(value)) return headerToken(value[0]);
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function messageRole(message: unknown): string {
  if (!message || typeof message !== 'object') return 'unknown';
  const role = (message as Record<string, unknown>).role;
  return typeof role === 'string' && role.trim() ? role.trim().slice(0, 40) : 'unknown';
}

// The function-call arguments the model echoes back (e.g. crm_lookup({phone:"+49…"}))
// are part of the egress payload but live in tool_calls[].function.arguments, NOT in
// .content — so the scan must read them and the redactor must strip them, else a phone
// the user gave (redacted out of .content) re-leaks via the tool the model called with it.
function toolCallArgsText(message: Record<string, unknown>): string {
  const toolCalls = message.tool_calls;
  if (!Array.isArray(toolCalls)) return '';
  return toolCalls
    .map((tc) => {
      const fn = tc && typeof tc === 'object' ? (tc as Record<string, unknown>).function : undefined;
      const args = fn && typeof fn === 'object' ? (fn as Record<string, unknown>).arguments : undefined;
      return typeof args === 'string' ? args : '';
    })
    .filter(Boolean)
    .join('\n');
}

function messageText(message: unknown): string {
  if (!message || typeof message !== 'object') return '';
  const msg = message as Record<string, unknown>;
  const argsText = toolCallArgsText(msg);
  const content = msg.content;
  let contentText = '';
  if (typeof content === 'string') {
    contentText = content;
  } else if (Array.isArray(content)) {
    contentText = content
      .map((part) => {
        if (!part || typeof part !== 'object') return '';
        const text = (part as Record<string, unknown>).text;
        return typeof text === 'string' ? text : '';
      })
      .filter(Boolean)
      .join('\n');
  }
  return [contentText, argsText].filter(Boolean).join('\n');
}

/**
 * Redact PII from a message. `minClass` (S12) selects the class THRESHOLD:
 * `'S1'` (default) redacts everything (legacy / toggle-on behaviour); `'S3'`
 * redacts ONLY the hard-floor classes (secret/financial/health) so a toggle-off
 * turn still strips credentials while passing waived S1/S2 through.
 */
function redactMessageContent(message: unknown, minClass: CommandEveSensitivityClass = 'S1'): unknown {
  if (!message || typeof message !== 'object') return message;
  const nextMessage = { ...(message as Record<string, unknown>) };
  // Redact tool-call arguments too (the model can echo PII into a tool call it makes).
  const toolCalls = nextMessage.tool_calls;
  if (Array.isArray(toolCalls)) {
    nextMessage.tool_calls = toolCalls.map((tc) => {
      if (!tc || typeof tc !== 'object') return tc;
      const nextTc = { ...(tc as Record<string, unknown>) };
      const fn = nextTc.function;
      if (fn && typeof fn === 'object') {
        const nextFn = { ...(fn as Record<string, unknown>) };
        if (typeof nextFn.arguments === 'string') {
          nextFn.arguments = redactCommandEveSensitiveTextAtOrAbove(nextFn.arguments, minClass);
        }
        nextTc.function = nextFn;
      }
      return nextTc;
    });
  }
  const content = nextMessage.content;
  if (typeof content === 'string') {
    nextMessage.content = redactCommandEveSensitiveTextAtOrAbove(content, minClass);
    return nextMessage;
  }
  if (!Array.isArray(content)) return nextMessage;
  nextMessage.content = content.map((part) => {
    if (!part || typeof part !== 'object') return part;
    const nextPart = { ...(part as Record<string, unknown>) };
    if (typeof nextPart.text === 'string') {
      nextPart.text = redactCommandEveSensitiveTextAtOrAbove(nextPart.text, minClass);
    }
    return nextPart;
  });
  return nextMessage;
}

function classifyPromptMarker(promptText: string): CommandEvePromptProof['marker'] {
  // T4 YOU-ARE-HERE: the wheel appends `agent.environment_hint` VERBATIM to the
  // system prompt's environment-hints block (FACT hermes prompt_builder.py:989-1000
  // build_environment_hints). We anchor on the FIXED marker phrase both hint
  // variants carry (COMMAND_EVE_YOU_ARE_HERE_MARKER = "Company Brain (Index:
  // brain.json)") — it names the LIVE index file, so it can only come from OUR hint
  // (never from SOUL.md, the operating rule, or a user turn). Checked FIRST as the
  // most-specific signal: a missing hint is now self-detected (the marker downgrades
  // to eve_soul), matching the founder self-detection standard. A SOUL-only prompt
  // (no hint) does NOT contain this phrase, so it still falls through to eve_soul
  // below (backward-compatible).
  //
  // T7 (2026-07-02): the marker is now PATH-FREE (was "…: company-brain/ (Index…"),
  // because the relative `company-brain/` mis-anchored the agent to its workspace
  // cwd. The absolute brain path now rides in a separate hint clause; this anchor
  // only matches the fixed index-file phrase.
  if (/Company Brain \(Index: brain\.json\)/.test(promptText)) {
    return 'eve_you_are_here';
  }
  // SOUL.md now carries the doctrine voice (FACT runtimeBootstrapCore.ts:183
  // EVE_SOUL_MARKDOWN). Match its distinctive identity cues FIRST so the prompt-
  // proof self-detection gate stays green when the soul is in the system prompt
  // instead of (or alongside) the thin internal operating rule. Without this the
  // soul text would classify as 'none' and silently blind the gate.
  if (
    /\bEVE SOUL\b/i.test(promptText) ||
    /The Operator/i.test(promptText) ||
    /JARVIS for making money/i.test(promptText)
  ) {
    return 'eve_soul';
  }
  if (/\bEVE Operating Rule\b/i.test(promptText)) return 'eve_operating_rule';
  if (/Command EVE'?s Chief-of-Staff/i.test(promptText) || /Command EVE Chief of Staff/i.test(promptText)) {
    return 'command_eve_chief_of_staff';
  }
  if (/Founder Intent/i.test(promptText) && /\bEVE\b/.test(promptText)) return 'command_eve_founder_intent';
  return 'none';
}

export function buildCommandEvePromptProof(body: Record<string, unknown>): CommandEvePromptProof {
  const messages = asMessages(body.messages);
  const roles = messages.map(messageRole);
  const promptText = messages.map(messageText).join('\n\n');
  const marker = classifyPromptMarker(promptText);
  return {
    version: 'command-eve-prompt-proof/v0',
    ok: marker !== 'none',
    observed_at: new Date().toISOString(),
    model: String(body.model || ''),
    message_count: messages.length,
    system_message_count: roles.filter((role) => role === 'system').length,
    marker,
    prompt_sha256: crypto.createHash('sha256').update(promptText).digest('hex'),
    roles,
  };
}

export function isCommandEveWarmupRequest(body: Record<string, unknown>): boolean {
  const messages = asMessages(body.messages);
  if (messages.length !== 1) return false;
  const onlyMessage = messages[0] as Record<string, unknown> | undefined;
  const content = typeof onlyMessage?.content === 'string' ? onlyMessage.content.trim().toLowerCase() : '';
  const maxTokens = typeof body.max_tokens === 'number' ? body.max_tokens : 0;
  return messageRole(onlyMessage) === 'user' && content === 'ping' && maxTokens > 0 && maxTokens <= 4;
}

function writePromptProof(promptProofPath: string, proof: CommandEvePromptProof): void {
  if (!promptProofPath) return;
  fs.mkdirSync(path.dirname(promptProofPath), { recursive: true });
  const tempFile = `${promptProofPath}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tempFile, `${JSON.stringify(proof, null, 2)}\n`, { mode: 0o600 });
  fs.renameSync(tempFile, promptProofPath);
}

function contextLengthFromModel(model: string, fallback: number): number {
  const match = model.match(/-(\d+)k(?::|$)/i);
  if (!match) return fallback;
  const contextLength = Number(match[1]) * 1024;
  if (!Number.isFinite(contextLength)) return fallback;
  return Math.max(4_096, Math.min(262_144, Math.floor(contextLength)));
}

function nativeChatPayload(body: Record<string, unknown>, options: Required<CommandEveOllamaShimOptions>): unknown {
  const model = String(body.model || '');
  const maxTokens =
    typeof body.max_tokens === 'number' && Number.isFinite(body.max_tokens)
      ? Math.max(1, Math.min(Math.floor(body.max_tokens), options.maxTokens))
      : options.maxTokens;
  return {
    model,
    messages: asMessages(body.messages),
    stream: Boolean(body.stream),
    think: false,
    ...(Array.isArray(body.tools) ? { tools: body.tools } : {}),
    options: {
      num_ctx: contextLengthFromModel(model, options.numCtx),
      num_predict: maxTokens,
    },
  };
}

async function fetchOllama(
  path: string,
  init: RequestInit,
  options: Required<CommandEveOllamaShimOptions>
): Promise<Response> {
  return fetch(`${options.ollamaBaseUrl.replace(/\/+$/, '')}${path}`, init);
}

async function handleModels(response: ServerResponse, options: Required<CommandEveOllamaShimOptions>): Promise<void> {
  const upstream = await fetchOllama('/api/tags', { method: 'GET' }, options);
  const data = (await upstream.json()) as { models?: Array<{ name?: string; modified_at?: string }> };
  jsonResponse(response, 200, {
    object: 'list',
    data: (data.models || []).map((model) => ({
      id: model.name || '',
      object: 'model',
      created: model.modified_at ? Math.floor(Date.parse(model.modified_at) / 1000) : 0,
      owned_by: 'ollama',
    })),
  });
}

function writeStreamChunk(response: ServerResponse, model: string, content: string, toolCalls?: unknown): void {
  const delta: Record<string, unknown> = {};
  if (content) delta.content = content;
  if (toolCalls) delta.tool_calls = toolCalls;
  response.write(
    `data: ${JSON.stringify({
      id: `chatcmpl-${Date.now()}`,
      object: 'chat.completion.chunk',
      created: Math.floor(Date.now() / 1000),
      model,
      choices: [{ index: 0, delta, finish_reason: null }],
    })}\n\n`
  );
}

/**
 * The EVE function URL must be https in production. A loopback http URL is also
 * accepted (same trust model as the local-runtime loopback key) so the routing
 * is testable and a self-hosted loopback proxy stays possible; any other plain
 * http (a real remote host over cleartext) is rejected.
 */
function isAllowedEveFunctionUrl(value: string): boolean {
  try {
    const url = new URL(value);
    if (url.protocol === 'https:') return Boolean(url.hostname);
    if (url.protocol === 'http:') {
      return ['127.0.0.1', 'localhost', '[::1]', '::1'].includes(url.hostname);
    }
    return false;
  } catch {
    return false;
  }
}

/**
 * EVE Inference (cloud) lane. The same egress-boundary enforcement that guards
 * the local Ollama path runs FIRST (provider.kind: 'cloud' so the receipt is
 * truthful), then the OpenAI-compatible body — with the `tier` the function
 * routes on — is POSTed to the eve-inference Edge Function with the CEVE license
 * as the bearer credential. The function returns an OpenAI-compatible
 * completion (or SSE stream), the exact shape the local path already emits, so
 * we can passthrough verbatim.
 *
 * The license is sent ONLY in the Authorization header (never in the body,
 * never logged) — the egress redactor scans message CONTENT, not headers.
 */
async function handleEveCloudCompletions(
  body: Record<string, unknown>,
  response: ServerResponse,
  options: Required<CommandEveOllamaShimOptions>,
  route: CommandEveEveCloudRoute,
  dispatchToken: string | undefined
): Promise<void> {
  const functionUrl = typeof route.functionUrl === 'string' ? route.functionUrl.trim() : '';
  const license = typeof route.license === 'string' ? route.license.trim() : '';
  // HONEST TIER ROUTING (1.2.19): the wire tier is the user's ACTUAL picker
  // selection, forwarded VERBATIM — NO silent fall-through to 'standard'. The
  // routing resolver derives this from the live selection via
  // resolveWireTierFromSelection (eve-standard→'standard', eve-high→'high',
  // eve-max→'max'). If an ACTIVE EVE route arrives without a known wire tier the
  // selection→tier chain is broken; we FAIL LOUD (500) instead of metering the
  // cheapest model — the previous `: 'standard'` fallback was exactly the bug
  // that made a paid EVE-Max user silently bill DeepSeek V4 Flash (OpenRouter
  // logs: 100% Flash, GLM 5.2 + V4 Pro never called).
  const tier = typeof route.tier === 'string' ? route.tier.trim() : '';
  const model = String(body.model || '');
  const stream = Boolean(body.stream);

  // Fail closed: never make an unauthenticated request, never POST to a
  // disallowed (cleartext-remote) function URL.
  if (!isAllowedEveFunctionUrl(functionUrl)) {
    jsonResponse(response, 500, {
      error: { message: 'EVE Inference function URL is missing or not an allowed (https/loopback) URL.' },
    });
    return;
  }
  if (license.length === 0) {
    jsonResponse(response, 401, {
      error: { message: 'EVE Inference is unavailable: no CEVE license bearer credential.' },
    });
    return;
  }
  // HONEST TIER ROUTING (1.2.19): refuse an active EVE route with a missing or
  // unknown wire tier rather than silently downgrading to the cheapest model.
  // A correct route always carries one of the registry tiers (standard/high/max);
  // a missing/unknown value means the selection→tier resolution broke upstream.
  if (!KNOWN_EVE_WIRE_TIERS.has(tier)) {
    jsonResponse(response, 500, {
      error: {
        message:
          'EVE Inference routing error: the selected level could not be resolved to a billing tier. ' +
          'Re-pick the EVE level and try again.',
      },
    });
    return;
  }

  // PER-SEAT PII/DSGVO egress switch (S11). Read the live mode FRESH per request
  // BEFORE the boundary runs. FAIL-SAFE by construction: the resolver returns 'on'
  // on any read error (always redact — no last-known-good), so only a conscious,
  // successfully-read 'off' disables redaction, and only for THIS seat's cloud
  // lane. The local lane never egresses and is never reached here.
  const egressRedactionMode = await options.egressRedactionMode();
  const redactionDisabledByOperator = egressRedactionMode === 'off';

  // A3 per-seat usage attribution: resolve the OPAQUE active-seat id ONCE, here
  // at the request start, so BOTH terminal log paths (stream + non-stream) ride
  // it for free. Opaque id only ('seat-1' | uuid) — never the label (H3). It is
  // spread into the outbound body below; the server persists it to
  // usage_events.seat_id and keeps it upstream-invisible (not in
  // FORWARDABLE_BODY_KEYS). A default 'seat-1' keeps attribution byte-stable.
  const seatId = await options.activeSeatId();

  // Egress boundary — same gate as local, but the provider is a CLOUD lane.
  //
  // SENSITIVITY-GATE (S12) WRAPS S11 here. Instead of forcing 'allow' wholesale
  // when the operator disabled the filter (which would have leaked EVERYTHING,
  // including raw credentials/health/finance), we thread the toggle MODE into the
  // boundary. The boundary then applies the class-aware gate: toggle 'off' waives
  // S1/S2 (operator responsibility) but the S3 HARD FLOOR still redacts (or blocks)
  // credentials/health/finance — the DSGVO grantee the operator cannot switch off.
  // S11's structure (fresh per-request read, receipt stamp, off-badge header) is
  // untouched; only the wholesale 'allow' is replaced by the gate.
  const egressBoundary = await evaluateCommandEveEgressBoundary({
    text: asMessages(body.messages).map(messageText).join('\n\n'),
    provider: {
      kind: 'cloud',
      name: 'EVE Inference',
      model: tier,
      baseUrl: functionUrl,
    },
    policyAction: options.egressPolicyAction,
    toggleMode: egressRedactionMode,
  });
  // Stamp the honest evidence onto the receipt when the operator turned the filter
  // off — this is the audit trail for a deliberate DSGVO control-waiver.
  const egressReceipt = redactionDisabledByOperator
    ? { ...egressBoundary.receipt, redaction: 'disabled_by_operator' as const }
    : egressBoundary.receipt;
  try {
    writeCommandEveEgressBoundaryReceipt(options.egressReceiptPath, egressReceipt);
  } catch (error) {
    console.warn('[Command EVE] Failed to write egress boundary receipt:', error);
  }
  response.setHeader('x-command-eve-egress-decision', egressBoundary.decision);
  if (redactionDisabledByOperator) {
    response.setHeader('x-command-eve-egress-redaction', 'disabled_by_operator');
  }
  if (egressBoundary.decision === 'block') {
    jsonResponse(response, 451, {
      error: {
        message:
          'Command EVE blocked sensitive data before model egress. Move secrets into settings, an env file, or an approved vault flow.',
        receipt: egressReceipt,
      },
    });
    return;
  }
  let outboundMessages = asMessages(body.messages);
  if (egressBoundary.decision === 'redact') {
    // S12: redact the OUTBOUND messages at the SAME class threshold the boundary
    // used. Toggle 'off' + S3 hard floor ⇒ redact ONLY S3 here (S1/S2 waived);
    // toggle 'on' ⇒ redact all S1+ (identical to legacy). Deriving the threshold
    // from the toggle keeps the messages and the boundary decision consistent —
    // we never over-redact a waived S1/S2 nor under-redact an S3.
    const messageRedactThreshold: CommandEveSensitivityClass = redactionDisabledByOperator ? 'S3' : 'S1';
    outboundMessages = outboundMessages.map((message) => redactMessageContent(message, messageRedactThreshold));
  }

  const proof = buildCommandEvePromptProof({ ...body, messages: outboundMessages });
  try {
    writePromptProof(options.promptProofPath, proof);
  } catch (error) {
    console.warn('[Command EVE] Failed to write prompt proof receipt:', error);
  }
  response.setHeader('x-command-eve-persona-proof', proof.ok ? proof.prompt_sha256 : 'missing');

  // Forward only OpenAI-standard fields + the tier the function routes on. The
  // function STRIPS model/models/user/license itself, so the local Gemma model
  // ref Hermes sent is harmless, but we omit it to keep the request clean.
  //
  // agent_id (Dein Team attribution) — SG-1 A1 SPOOF-CLOSE. Identity is carried
  // by CODE, never by the model: the trusted source is the X-EVE-Dispatch header
  // TOKEN (minted per roster role by eveAgentTaskRegistry), resolved here to a
  // known roster id, SEAT-PARTITIONED against the live seat. A client-sent
  // `body.agent_id` is IGNORED entirely (the old spoof channel at :694). Anything
  // that does not resolve — including the 1.7.0 steady state, where no header
  // producer exists yet (that is the 1.8 wheel train) — degrades to the system
  // default `eve` (fail-open; the main lane never breaks). We only forward the id
  // for a delegated (non-default) role, so an un-delegated call's body keeps its
  // prior shape. The id is a kebab role string, never a secret — safe to forward.
  const attributionAgentId = await options.attributionAgentId(dispatchToken, seatId);

  // DUX-4 — ENFORCE the "Dein Team" pause/throttle/fire controls. The panel
  // WRITES `commandEve.teamWorkerStatus`; here is the ONE place the execution
  // path READS it. A delegated worker the user paused (throttled) or stopped /
  // let go (off) is NOT dispatched — we fail-closed with a clear, non-secret
  // error instead of silently spending on a worker the user turned off. The
  // un-delegated EVE (`eve`) and any unknown id are always allowed (fail-open),
  // so only a positively-known paused/off roster worker is blocked.
  // Fresh READ per dispatch evaluation (money control): the resolver reads the
  // live status map from the backend store the panel writes to, so a fired /
  // paused worker is refused on the very next dispatch — no TTL, no cache-warm
  // grace. `await` because the resolver is now backend-backed (async); a sync
  // resolver awaits to itself.
  const teamStatuses = (await options.teamWorkerStatus()) ?? {};
  const dispatch = evaluateWorkerDispatch(attributionAgentId, teamStatuses);
  if (!dispatch.allowed) {
    response.setHeader('x-command-eve-worker-dispatch', dispatch.reason);
    jsonResponse(response, 409, {
      error: {
        code: dispatch.reason,
        message:
          dispatch.reason === 'blocked-paused'
            ? `Dieser Mitarbeiter ist gedrosselt (pausiert) und wird nicht eingesetzt. Setze ihn in "Dein Team" fort, um ihn wieder arbeiten zu lassen.`
            : `Dieser Mitarbeiter ist aus (gestoppt bzw. entlassen) und wird nicht eingesetzt. Stelle ihn in "Dein Team" wieder ein, um ihn arbeiten zu lassen.`,
      },
    });
    return;
  }

  // AGENT TOOL-USE: forward the function-calling fields too. The Hermes agent
  // sends OpenAI-style `tools` so the model can actually call file/terminal/skill/
  // delegate tools. Previously this body was {messages,stream,tier} only, so the
  // model received ZERO tools on the cloud lane and could only emit prose
  // (tool_turns=0) — it would narrate a <bash>…</bash> string instead of calling a
  // tool. The local lane already forwards tools (nativeChatPayload); this brings
  // the cloud lane to parity. Conditional spreads so a tool-less turn stays
  // byte-identical to before.
  //
  // DOWNSTREAM CONTRACT: the DEPLOYED eve-inference re-filters by its own
  // FORWARDABLE_BODY_KEYS allowlist, which (verified 2026-06-24 on prod
  // unvbeothoimlzlolxucl) ALREADY includes tools/tool_choice/parallel_tool_calls/
  // response_format — so these survive to the model. NOTE: keep the Company.OS
  // eve-inference deploy line in sync; if a redeploy ships a FORWARDABLE_BODY_KEYS
  // that lacks these keys, tools get re-stripped server-side and EVE goes "deaf"
  // again. (supabase/functions/_shared/eve-inference-core.ts FORWARDABLE_BODY_KEYS)
  const outboundBody: Record<string, unknown> = {
    messages: outboundMessages,
    stream,
    tier,
    ...(attributionAgentId !== 'eve' ? { agent_id: attributionAgentId } : {}),
    // A3 per-seat attribution: the opaque active-seat id. Only emitted when a
    // non-empty id resolved (always true with the default 'seat-1' resolver);
    // a blank id is omitted so an old app + new server stays NULL ("Nicht
    // zugeordnet") rather than writing an empty-string seat. The server
    // sanitizes and persists it to usage_events.seat_id; it is NEVER in
    // FORWARDABLE_BODY_KEYS so it stays invisible to OpenRouter.
    ...(typeof seatId === 'string' && seatId.length > 0 ? { seat_id: seatId } : {}),
    ...(Array.isArray(body.tools) && body.tools.length > 0 ? { tools: body.tools } : {}),
    ...(body.tool_choice !== undefined ? { tool_choice: body.tool_choice } : {}),
    ...(body.parallel_tool_calls !== undefined ? { parallel_tool_calls: body.parallel_tool_calls } : {}),
    ...(body.response_format !== undefined ? { response_format: body.response_format } : {}),
  };

  let upstream: Response;
  try {
    upstream = await fetch(functionUrl, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        // The license rides ONLY here — never in the body, never logged.
        authorization: `Bearer ${license}`,
      },
      body: JSON.stringify(outboundBody),
    });
  } catch {
    // Generic 502 — never echo the error (could surface the bearer in some
    // runtimes), matching the function's own upstream-failure discipline.
    jsonResponse(response, 502, { error: { message: 'EVE Inference upstream unreachable.' } });
    return;
  }

  // Stream passthrough: the function already emits OpenAI-compatible SSE.
  if (stream && upstream.ok && upstream.body) {
    response.writeHead(200, {
      'content-type': upstream.headers.get('content-type') || 'text/event-stream',
      'cache-control': 'no-cache',
      connection: 'keep-alive',
    });
    const reader = upstream.body.getReader();
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      response.write(value);
    }
    response.end();
    return;
  }

  // Non-streaming (or upstream error): passthrough the JSON verbatim. The
  // function returns OpenAI-compatible completions on 200 and sanitized error
  // bodies otherwise.
  const text = await upstream.text().catch(() => '');

  // Friendly daily-cap (429): the raw upstream body is a terse
  // "rate_limit"/"daily cap reached" JSON that surfaces in chat as a cold
  // error. Rewrite it to a warm, operator-facing message that names WHY (the
  // free tier's daily fair-use budget) and the way forward, WITHOUT inventing a
  // cap number — if the function reported a concrete reset/limit we keep its
  // text, otherwise a generic friendly line. Stays OpenAI-error-shaped so the
  // chat renders message verbatim.
  if (upstream.status === 429) {
    let upstreamMessage = '';
    try {
      const parsed = JSON.parse(text) as { error?: { message?: string }; message?: string };
      upstreamMessage = (parsed?.error?.message || parsed?.message || '').trim();
    } catch {
      upstreamMessage = '';
    }
    const friendly =
      'EVE hat ihr kostenloses Tageskontingent für heute erreicht. ' +
      'Morgen läuft es automatisch wieder — oder du schaltest mehr Kontingent über die Credits frei.' +
      (upstreamMessage ? ` (${upstreamMessage})` : '');
    response.writeHead(429, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ error: { message: friendly, type: 'eve_daily_cap', code: 429 } }));
    return;
  }

  response.writeHead(upstream.status || 502, {
    'content-type': upstream.headers.get('content-type') || 'application/json',
  });
  response.end(text || JSON.stringify({ error: { message: `EVE Inference request failed (${upstream.status}).` } }));
}

async function handleChatCompletions(
  request: IncomingMessage,
  response: ServerResponse,
  options: Required<CommandEveOllamaShimOptions>
): Promise<void> {
  const body = await readBody(request);
  const model = String(body.model || '');
  const stream = Boolean(body.stream);

  // EVE Inference (cloud) lane takes precedence over the local Ollama path when
  // the active picker selection is an EVE tier. A warm-up ping ("ping") stays
  // local — it only ever exercises the bundled local model.
  if (!isCommandEveWarmupRequest(body)) {
    const eveRoute = await options.eveRouting();
    if (eveRoute?.active) {
      // SG-1 A1: the attribution token rides the X-EVE-Dispatch HEADER, never the
      // body — so a client that stuffs `body.agent_id` cannot spoof a role.
      const dispatchToken = headerToken(request.headers['x-eve-dispatch']);
      await handleEveCloudCompletions(body, response, options, eveRoute, dispatchToken);
      return;
    }
  }

  if (!isCommandEveWarmupRequest(body)) {
    const egressBoundary = await evaluateCommandEveEgressBoundary({
      text: asMessages(body.messages).map(messageText).join('\n\n'),
      provider: {
        kind: 'local',
        name: 'ollama',
        model,
        baseUrl: options.ollamaBaseUrl,
      },
      policyAction: options.egressPolicyAction,
    });
    try {
      writeCommandEveEgressBoundaryReceipt(options.egressReceiptPath, egressBoundary.receipt);
    } catch (error) {
      console.warn('[Command EVE] Failed to write egress boundary receipt:', error);
    }
    response.setHeader('x-command-eve-egress-decision', egressBoundary.decision);
    if (egressBoundary.decision === 'block') {
      jsonResponse(response, 451, {
        error: {
          message:
            'Command EVE blocked sensitive data before model egress. Move secrets into settings, an env file, or an approved vault flow.',
          receipt: egressBoundary.receipt,
        },
      });
      return;
    }
    if (egressBoundary.decision === 'redact') {
      // Local lane never egresses and never carries a toggle context, so it always
      // redacts at the full S1 threshold (legacy behaviour). Wrap so Array.map's
      // (value,index,array) never leaks the index into the minClass parameter.
      body.messages = asMessages(body.messages).map((message) => redactMessageContent(message));
    }

    const proof = buildCommandEvePromptProof(body);
    try {
      writePromptProof(options.promptProofPath, proof);
    } catch (error) {
      console.warn('[Command EVE] Failed to write prompt proof receipt:', error);
    }
    response.setHeader('x-command-eve-persona-proof', proof.ok ? proof.prompt_sha256 : 'missing');
    if (!proof.ok) {
      console.warn(`[Command EVE] Prompt proof missing EVE marker for model ${model || 'unknown'}.`);
    }
  }
  const upstream = await fetchOllama(
    '/api/chat',
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(nativeChatPayload(body, options)),
    },
    options
  );

  if (!upstream.ok || !upstream.body) {
    const text = await upstream.text().catch(() => '');
    jsonResponse(response, upstream.status || 502, { error: { message: text || 'Ollama request failed' } });
    return;
  }

  if (!stream) {
    const data = (await upstream.json()) as {
      message?: { content?: string; tool_calls?: unknown };
      done_reason?: string;
    };
    jsonResponse(response, 200, {
      id: `chatcmpl-${Date.now()}`,
      object: 'chat.completion',
      created: Math.floor(Date.now() / 1000),
      model,
      choices: [
        {
          index: 0,
          message: {
            role: 'assistant',
            content: data.message?.content || '',
            ...(data.message?.tool_calls ? { tool_calls: data.message.tool_calls } : {}),
          },
          finish_reason: data.done_reason === 'length' ? 'length' : 'stop',
        },
      ],
    });
    return;
  }

  response.writeHead(200, {
    'content-type': 'text/event-stream',
    'cache-control': 'no-cache',
    connection: 'keep-alive',
  });

  const reader = upstream.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let finishReason = 'stop';
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split(/\r?\n/);
    buffer = lines.pop() || '';
    for (const line of lines) {
      if (!line.trim()) continue;
      const chunk = JSON.parse(line) as {
        message?: { content?: string; tool_calls?: unknown };
        done?: boolean;
        done_reason?: string;
      };
      if (chunk.done) {
        finishReason = chunk.done_reason === 'length' ? 'length' : 'stop';
        continue;
      }
      writeStreamChunk(response, model, chunk.message?.content || '', chunk.message?.tool_calls);
    }
  }

  response.write(
    `data: ${JSON.stringify({
      id: `chatcmpl-${Date.now()}`,
      object: 'chat.completion.chunk',
      created: Math.floor(Date.now() / 1000),
      model,
      choices: [{ index: 0, delta: {}, finish_reason: finishReason }],
    })}\n\n`
  );
  response.write('data: [DONE]\n\n');
  response.end();
}

export async function startCommandEveOllamaOpenAiShim(shimOptions: CommandEveOllamaShimOptions = {}): Promise<string> {
  if (server?.listening) return serverUrl || `http://127.0.0.1:${DEFAULT_SHIM_PORT}`;
  const options: Required<CommandEveOllamaShimOptions> = {
    port: shimOptions.port ?? DEFAULT_SHIM_PORT,
    ollamaBaseUrl: shimOptions.ollamaBaseUrl || DEFAULT_OLLAMA_BASE_URL,
    numCtx: shimOptions.numCtx || DEFAULT_NUM_CTX,
    maxTokens: shimOptions.maxTokens || DEFAULT_MAX_TOKENS,
    promptProofPath: shimOptions.promptProofPath || '',
    egressReceiptPath: shimOptions.egressReceiptPath || '',
    // Redact-and-continue by default (see egressBoundaryCore): a hard block 451s
    // non-retryably and hangs the turn. PII is stripped before egress, never leaked.
    egressPolicyAction: shimOptions.egressPolicyAction || 'redact',
    // Default resolver keeps every request on the local lane.
    eveRouting: shimOptions.eveRouting || ((): undefined => undefined),
    // Default resolver returns no status map ⇒ every worker is treated active
    // (gating is a no-op until the main process injects the live status map).
    teamWorkerStatus: shimOptions.teamWorkerStatus || ((): undefined => undefined),
    // Default resolver returns 'on' ⇒ always redact (fail-SAFE). The switch is a
    // no-op (redaction unchanged) until the main process injects the live mode.
    egressRedactionMode: shimOptions.egressRedactionMode || ((): 'on' => 'on'),
    // Default resolver returns the legacy 'seat-1' ⇒ attribution is byte-stable
    // (server treats 'seat-1' and absent alike) until main injects getActiveSeatId.
    activeSeatId: shimOptions.activeSeatId || ((): string => 'seat-1'),
    // SG-1 A1: default attribution is the system `eve` (no header producer until
    // the 1.8 wheel train) ⇒ the un-delegated shape, byte-identical to before.
    attributionAgentId: shimOptions.attributionAgentId || ((): string => 'eve'),
  };
  server = http.createServer((request, response) => {
    void (async () => {
      const path = new URL(request.url || '/', `http://${request.headers.host || '127.0.0.1'}`).pathname;
      if (request.method === 'GET' && path === '/health') {
        jsonResponse(response, 200, { ok: true, upstream: options.ollamaBaseUrl });
        return;
      }
      if (request.method === 'GET' && path === '/v1/models') {
        await handleModels(response, options);
        return;
      }
      if (request.method === 'POST' && path === '/v1/chat/completions') {
        await handleChatCompletions(request, response, options);
        return;
      }
      jsonResponse(response, 404, { error: { message: `Unsupported Command EVE Ollama shim path: ${path}` } });
    })().catch((error) => {
      jsonResponse(response, 500, { error: { message: error instanceof Error ? error.message : String(error) } });
    });
  });
  await new Promise<void>((resolve, reject) => {
    server?.once('error', reject);
    server?.listen(options.port, '127.0.0.1', resolve);
  });
  const address = server.address();
  const port = address && typeof address !== 'string' ? address.port : options.port;
  serverUrl = `http://127.0.0.1:${port}`;
  return serverUrl;
}

export async function stopCommandEveOllamaOpenAiShimForTest(): Promise<void> {
  if (!server) return;
  await new Promise<void>((resolve, reject) => {
    server?.close((error) => (error ? reject(error) : resolve()));
  });
  server = undefined;
  serverUrl = '';
}

export async function warmCommandEveLocalModel(
  warmupOptions: CommandEveModelWarmupOptions
): Promise<CommandEveModelWarmupResult> {
  const startedAt = Date.now();
  const baseUrl = warmupOptions.baseUrl || serverUrl || `http://127.0.0.1:${DEFAULT_SHIM_PORT}`;
  const maxTokens = warmupOptions.maxTokens ?? 1;
  if (!warmupOptions.model.trim()) {
    return {
      ok: false,
      elapsedMs: Date.now() - startedAt,
      model: warmupOptions.model,
      error: 'missing model',
    };
  }
  if (!isLoopbackHttpUrl(baseUrl)) {
    return {
      ok: false,
      elapsedMs: Date.now() - startedAt,
      model: warmupOptions.model,
      error: 'Command EVE model warm-up is local-only and requires a loopback URL.',
    };
  }

  const abortController = new AbortController();
  const timeout = setTimeout(() => abortController.abort(), warmupOptions.timeoutMs ?? 60_000);
  try {
    const response = await fetch(chatCompletionsUrl(baseUrl), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      signal: abortController.signal,
      body: JSON.stringify({
        model: warmupOptions.model,
        messages: [{ role: 'user', content: 'ping' }],
        max_tokens: Math.max(1, Math.min(4, Math.floor(maxTokens))),
        stream: false,
      }),
    });
    if (!response.ok) {
      const text = await response.text().catch(() => '');
      return {
        ok: false,
        elapsedMs: Date.now() - startedAt,
        model: warmupOptions.model,
        error: text || `warm-up request failed (${response.status})`,
      };
    }
    await response.arrayBuffer().catch((): undefined => undefined);
    return {
      ok: true,
      elapsedMs: Date.now() - startedAt,
      model: warmupOptions.model,
    };
  } catch (error) {
    return {
      ok: false,
      elapsedMs: Date.now() - startedAt,
      model: warmupOptions.model,
      error: error instanceof Error ? error.message : String(error),
    };
  } finally {
    clearTimeout(timeout);
  }
}

/**
 * Light EVE Inference (cloud) lane preflight. Fired at startup when the active
 * picker selection is an EVE tier, INSTEAD of the local Ollama warm-up, so the
 * first real EVE turn does not pay the cold-start cost: it warms the TLS/edge
 * path to the eve-inference Edge Function and verifies the CEVE license +
 * reachability while the user is still typing.
 *
 * Unlike the local warm-up this is NOT a "ping" — a ping is classified as a
 * warm-up request by the shim and stays LOCAL by design. The preflight sends a
 * minimal *real* EVE-persona chat (tiny system + user message, max_tokens 1) so
 * `isCommandEveWarmupRequest` does NOT match and the shim routes it through the
 * live EVE cloud route (egress boundary → license bearer → function). The
 * eve-inference function returns an OpenAI-compatible completion exactly like a
 * normal turn; we only care that the route resolves and authenticates.
 *
 * Fail-soft: every failure mode (missing route/license, blocked egress,
 * unreachable function, timeout) is captured into the result — this never
 * throws and never blocks app start. A non-2xx status (e.g. 401 no-license,
 * 502 unreachable) is reported via `ok: false` + `status` so the caller can log
 * a gentle status, but it is still just a warm-up: the user's first real turn
 * surfaces the same error through the normal path.
 */
export async function warmCommandEveEveLane(
  warmupOptions: CommandEveEveLaneWarmupOptions = {}
): Promise<CommandEveEveLaneWarmupResult> {
  const startedAt = Date.now();
  const baseUrl = warmupOptions.baseUrl || serverUrl || `http://127.0.0.1:${DEFAULT_SHIM_PORT}`;
  const tier = warmupOptions.tier && warmupOptions.tier.trim() ? warmupOptions.tier.trim() : 'standard';

  if (!isLoopbackHttpUrl(baseUrl)) {
    return {
      ok: false,
      elapsedMs: Date.now() - startedAt,
      tier,
      error: 'Command EVE preflight must go through the loopback shim (no direct cloud egress).',
    };
  }

  const abortController = new AbortController();
  const timeout = setTimeout(() => abortController.abort(), warmupOptions.timeoutMs ?? 30_000);
  try {
    const response = await fetch(chatCompletionsUrl(baseUrl), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      signal: abortController.signal,
      body: JSON.stringify({
        // A tiny EVE-persona system message keeps the prompt-proof marker happy;
        // the non-"ping" user content ensures the request is NOT classified as a
        // local warm-up and is routed through the EVE cloud lane instead.
        messages: [
          { role: 'system', content: 'EVE Operating Rule: warm-up preflight.' },
          { role: 'user', content: 'warm up' },
        ],
        max_tokens: 1,
        stream: false,
      }),
    });
    if (!response.ok) {
      const text = await response.text().catch(() => '');
      return {
        ok: false,
        elapsedMs: Date.now() - startedAt,
        tier,
        status: response.status,
        error: text || `EVE preflight failed (${response.status})`,
      };
    }
    await response.arrayBuffer().catch((): undefined => undefined);
    return {
      ok: true,
      elapsedMs: Date.now() - startedAt,
      tier,
      status: response.status,
    };
  } catch (error) {
    return {
      ok: false,
      elapsedMs: Date.now() - startedAt,
      tier,
      error: error instanceof Error ? error.message : String(error),
    };
  } finally {
    clearTimeout(timeout);
  }
}

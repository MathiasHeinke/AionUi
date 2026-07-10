/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Command EVE HONCHO RUNTIME CONFIG core (1.7.0 / HONCHO-1 — the PURE per-seat
 * config descriptor).
 *
 * WHAT THIS OWNS. Given a seat + the local-model opt-in/readiness state, it
 * NAMES the per-seat boundary of a self-hosted, LOCAL Honcho memory server
 * (open-source dialectical user-model memory): the per-seat Postgres database,
 * the opaque Honcho workspace, the business/private peer split, the on-disk home
 * (under the seat's own HERMES_HOME so the memory DATA never leaves the machine),
 * AND the deriver-LLM routing decision (local Gemma vs the FREE cloud-Flash
 * fallback). It performs NO install, NO SQL, NO network, NO process spawn — those
 * are LATER increments. This module only DECIDES + NAMES; it is deterministic and
 * unit-testable in plain Node.
 *
 * FOUNDER-LOCKED DECISIONS (spec 2026-07-04):
 *   1. Honcho is LOCAL, No-Docker. The memory DATA always stays on the user's
 *      machine (per-seat Postgres). Per-seat isolation is a HARD requirement, and
 *      business-vs-private is separated WITHIN a seat's world.
 *   2. The Honcho DERIVER LLM (the reasoning that builds the user model — NOT the
 *      user's chat) routes:
 *        - LOCAL Gemma E4B (via Ollama) ONLY when the user OPTED IN (~4 GB,
 *          consent-gated) AND the model is READY. Local ⇒ nothing egresses.
 *        - ELSE the FREE "DeepSeek V4 Flash" lane (EVE Standard tier). The
 *          default fallback — "nicht mal Cent-Beträge".
 *   3. (2026-07-05) The deriver is USER-SWITCHABLE via `deriverMode`:
 *        - 'auto'  (default) ⇒ the founder-locked rule above (local when
 *          opted-in+ready, else free cloud-Flash).
 *        - 'local' ⇒ PRIVACY-LOCK: the deriver ALWAYS routes to loopback Ollama
 *          and NEVER to the cloud shim, even when the model is cold. A cold model
 *          means derivation simply does not succeed yet (the readiness probe keeps
 *          Honcho un-advertised until warm) — memory falls back to Company Brain,
 *          but NOTHING ever egresses. The switch is the explicit opt-in.
 *        - 'cloud' ⇒ force the free cloud-Flash lane (convenience over locality).
 *
 * THE THREE INVARIANTS THIS CORE MAKES STRUCTURAL (not merely defaulted):
 *   A. NEVER A DIRECT EDGE CALL. The cloud-Flash deriver base is the LOOPBACK
 *      shim (ollamaOpenAiShim, 127.0.0.1), NEVER the raw eve-inference edge
 *      function. This module imports no edge URL and exposes no field that could
 *      carry one; {@link requireLoopbackShimBase} THROWS on any non-loopback base.
 *      So the deriver's derivation text re-enters the shim's egress boundary
 *      (S11/S13 PII redaction) before a byte leaves the machine — identical to
 *      chat. A source-level grep-gate test pins that this file never string-
 *      references the edge URL / the backend host, so a future edit can not add a
 *      direct-to-edge bypass.
 *   B. NEVER THE USER'S PAID TIER. The cloud branch's forced tier is the literal
 *      {@link HONCHO_DERIVER_FORCED_TIER} ('standard' = FREE). {@link
 *      resolveHonchoDeriverConfig} takes NO picker/selection parameter, so no code
 *      path can reach 'high'/'max'. An operator sitting on eve-max can not make
 *      the deriver bill a paid tier — it is unrepresentable, not defended.
 *   C. NO CLOUD CREDENTIAL IN HONCHO'S HANDS. The config's api key stays EMPTY on
 *      the cloud branch. At process launch Honcho receives only the random local
 *      shim nonce; the CEVE bearer remains downstream inside the shim. `ready` is
 *      false when the cloud branch is chosen but no license exists (fail-closed).
 *
 * DEVIATION FROM THE DESIGN SKETCH (deliberate, more correct): the per-seat
 * Postgres database name is an OPAQUE HASH of the sanitized seat id, not a
 * dash-folded copy of it. Folding `-`→`_` for PG-identifier grammar is NOT
 * injective — a canonical uuid and its underscore-twin slug fold to the same
 * string, which would MERGE two seats' memory (the worst failure). Hashing is the
 * only branch-free way to guarantee injectivity, and it also honours H3 (the DB
 * name never leaks even the seat id, let alone the human label). The Honcho
 * workspace id stays the readable sanitized id (`ws_<id>`) — Honcho workspace ids
 * have no grammar constraint, the sanitized id is already opaque (a uuid, never
 * the label), and keeping it readable lets support map a workspace back to a seat.
 */

import path from 'path';
import crypto from 'crypto';
import { assertSeatId, isLegacySeatId, LEGACY_SEAT_ID, resolveSeatHome, type SeatHomePaths } from './seatContextCore';

// ---------------------------------------------------------------------------
// Constants (local to this module — do NOT import any edge-function URL here;
// invariant A depends on this file never naming the edge lane).
// ---------------------------------------------------------------------------

/** Loopback Ollama base the LOCAL deriver talks to (OpenAI-compatible `/v1`). */
export const HONCHO_DEFAULT_OLLAMA_BASE_URL = 'http://127.0.0.1:11434';

/**
 * Loopback base of the local OpenAI shim (ollamaOpenAiShim `DEFAULT_SHIM_PORT`).
 * The cloud-Flash deriver rides THIS (never the edge fn) so it inherits the
 * shim's egress boundary. No `/v1` here — the resolver appends it.
 */
export const HONCHO_DEFAULT_SHIM_BASE_URL = 'http://127.0.0.1:25811';

/** Default local deriver model ref (= runtimeBootstrapCore DEFAULT_MODEL_REF). */
export const HONCHO_DEFAULT_LOCAL_MODEL_REF = 'gemma4:e4b';

/**
 * The tier the cloud deriver is HARD-PINNED to — the FREE Standard/Flash lane.
 * A literal, never derived from the user's picker selection (invariant B).
 */
export const HONCHO_DERIVER_FORCED_TIER = 'standard';

/** Postgres NAMEDATALEN — an identifier must be 63 bytes or fewer. */
export const HONCHO_PG_MAX_IDENT = 63;

/** Legacy/founder single-seat Postgres database name (byte-stable, no migration). */
export const HONCHO_LEGACY_DB_NAME = 'honcho_seat_1';

/** Legacy/founder single-seat Honcho workspace id (byte-stable). */
export const HONCHO_LEGACY_WORKSPACE_ID = 'seat-1';

/** Fixed, PII-free peer ids for the business/private split within a seat. */
export const HONCHO_BUSINESS_PEER_ID = 'biz';
export const HONCHO_PRIVATE_PEER_ID = 'priv';

/** Deriver branch discriminants (plain strings — strictNullChecks is OFF). */
export const HONCHO_DERIVER_BRANCH_LOCAL = 'local-ollama';
export const HONCHO_DERIVER_BRANCH_CLOUD = 'cloud-flash-via-shim';

// ---------------------------------------------------------------------------
// Flat interfaces (OPTIONAL fields, plain-string discriminants — strictNullChecks
// is OFF in this repo, so NO discriminated unions).
// ---------------------------------------------------------------------------

export interface HonchoDeriverConfig {
  /** {@link HONCHO_DERIVER_BRANCH_LOCAL} | {@link HONCHO_DERIVER_BRANCH_CLOUD}. */
  branch?: string;
  /** local: `<ollama>/v1` ; cloud: `<loopback shim>/v1` (NEVER the edge fn). */
  baseUrl?: string;
  /** local: the Gemma ref ; cloud: '' (the shim's deriver ingress pins the model). */
  model?: string;
  /** local: 'ollama' placeholder ; cloud: '' (bearer injected by the shim, never baked). */
  apiKey?: string;
  /** cloud: {@link HONCHO_DERIVER_FORCED_TIER} ALWAYS ; local: undefined. */
  forcedTier?: string;
  /** true on the cloud branch ⇒ the deriver MUST ride the shim egress path (S11/S13). */
  behindEgressBoundary?: boolean;
  /** non-secret reason string: 'local-opt-in-ready' | 'fallback-free-flash' | 'opt-in-not-ready'. */
  routeReason?: string;
}

export interface HonchoRuntimeConfig {
  /** Sanitized/opaque seat id ('seat-1' | uuid | slug). */
  seatId?: string;
  legacy?: boolean;
  /** Per-seat Postgres database on the shared local cluster (opaque hash for real seats). */
  dbName?: string;
  /** Loopback Postgres host (local-only, No-Docker). */
  pgHost?: string;
  pgPort?: number;
  /** `postgresql://<host>:<port>/<dbName>` — NEVER a password literal (peer/socket auth). */
  dbUri?: string;
  /** Opaque Honcho workspace id (never the human label — H3). */
  workspaceId?: string;
  /** business/private peer split within the seat's own workspace. */
  businessPeerId?: string;
  privatePeerId?: string;
  /** `<seatHome.hermesHome>/honcho` — memory data stays local + per-seat. */
  honchoHome?: string;
  deriver?: HonchoDeriverConfig;
  /** false when the deriver is cloud-flash AND no license exists (fail-closed). */
  ready?: boolean;
}

export interface HonchoRuntimeConfigInput {
  /** RAW seat id; sanitized INSIDE via assertSeatId (never trust the caller). */
  seatId?: string | null;
  /** From resolveSeatHome() — provides hermesHome (+ legacy, for reference). */
  seatHome: SeatHomePaths;
  /** Consent-gated Gemma E4B opt-in. */
  localModelOptedIn?: boolean;
  /** Local model download+warm PROVEN (caller-observed; this core does NOT probe). */
  localModelReady?: boolean;
  /** A CEVE bearer exists for the cloud-flash deriver path (gates `ready`). */
  hasLicense?: boolean;
  /** Local Ollama loopback base (default {@link HONCHO_DEFAULT_OLLAMA_BASE_URL}). */
  ollamaBaseUrl?: string;
  /** Local deriver model ref (default {@link HONCHO_DEFAULT_LOCAL_MODEL_REF}). */
  localModelRef?: string;
  /** Loopback shim base for the cloud deriver (default {@link HONCHO_DEFAULT_SHIM_BASE_URL}). */
  shimBaseUrl?: string;
  /** Loopback Postgres host (default '127.0.0.1'). */
  pgHost?: string;
  /** Loopback Postgres port (default 5432). */
  pgPort?: number;
  /**
   * (2026-07-05) The USER-SWITCHABLE deriver mode. 'auto' (default) = the
   * founder-locked local-when-ready-else-cloud rule; 'local' = privacy-lock (never
   * cloud, even cold); 'cloud' = force free cloud-Flash. Absent ⇒ 'auto'.
   */
  deriverMode?: HonchoDeriverMode;
}

/** The user-facing deriver switch (config key `commandEve.honchoDeriverMode`). */
export type HonchoDeriverMode = 'auto' | 'local' | 'cloud';

/** The subset {@link resolveHonchoDeriverConfig} reads — NO selection/tier field by design. */
export type HonchoDeriverInput = Pick<
  HonchoRuntimeConfigInput,
  'localModelOptedIn' | 'localModelReady' | 'ollamaBaseUrl' | 'localModelRef' | 'shimBaseUrl' | 'deriverMode'
>;

// ---------------------------------------------------------------------------
// Identifier derivation (pure — deterministic string math, no I/O).
// ---------------------------------------------------------------------------

/** Strip a trailing slash (or slashes) from a base URL. */
function stripTrailingSlash(value: string): string {
  return value.replace(/\/+$/, '');
}

/**
 * The opaque, injective, PG-identifier-safe BODY of a real seat's database name:
 * the first 16 hex chars of sha256(sanitizedSeatId). Always ≤63 with its prefix,
 * always `[0-9a-f]` (a valid identifier tail), deterministic, and — unlike a
 * dash-fold — collision-free over the seat allowlist AND opaque (H3). The full
 * dbName ({@link honchoDbNameForSeat}) prepends `honcho_` so the identifier
 * always starts with a letter.
 */
export function hardenPgIdent(sanitizedSeatId: string): string {
  return crypto.createHash('sha256').update(sanitizedSeatId).digest('hex').slice(0, 16);
}

/**
 * The per-seat Postgres database name. Legacy/founder ⇒ byte-stable
 * {@link HONCHO_LEGACY_DB_NAME}; a real seat ⇒ `honcho_<16-hex opaque hash>`.
 * `sanitizedSeatId` MUST already be sanitized (this is not the guard boundary).
 */
export function honchoDbNameForSeat(sanitizedSeatId: string, legacy: boolean): string {
  if (legacy) return HONCHO_LEGACY_DB_NAME;
  return `honcho_${hardenPgIdent(sanitizedSeatId)}`;
}

/**
 * The per-seat Honcho workspace id. Legacy/founder ⇒ byte-stable
 * {@link HONCHO_LEGACY_WORKSPACE_ID}; a real seat ⇒ `ws_<sanitizedSeatId>`
 * (readable, already opaque — a uuid, never the label — so support can map a
 * workspace back to a seat). `sanitizedSeatId` MUST already be sanitized.
 */
export function honchoWorkspaceIdForSeat(sanitizedSeatId: string, legacy: boolean): string {
  if (legacy) return HONCHO_LEGACY_WORKSPACE_ID;
  return `ws_${sanitizedSeatId}`;
}

/**
 * The ONLY shape a cloud-deriver shim base may take: plain `http`, a CANONICAL
 * loopback host (dotted `127.0.0.1`, `localhost`, or bracketed `[::1]`), an
 * explicit port, and nothing else — no userinfo, no path, no query.
 *
 * Deliberately a STRICT string form, not a `new URL(...).hostname` allowlist: the
 * WHATWG URL parser normalizes exotic host encodings (hex `0x7f000001`, decimal
 * `2130706433`, IPv4-mapped IPv6, a `user@host` userinfo trick) so a hostname
 * check would silently ACCEPT them. The deriver base is an internal value that is
 * ALWAYS the shim's canonical address, so anything exotic is a misconfig or an
 * attempt to slip past the egress boundary and must be refused outright.
 */
const CANONICAL_LOOPBACK_BASE_RE = /^http:\/\/(?:127\.0\.0\.1|localhost|\[::1\]):\d{1,5}\/?$/i;

/**
 * Guard a candidate deriver base URL against {@link CANONICAL_LOOPBACK_BASE_RE}:
 * plain http, a CANONICAL loopback host, an explicit port, nothing else. THROWS
 * on anything else — the raw eve-inference edge URL (https, a remote host, no
 * port), a `user@evil.com` userinfo trick, a hex/decimal/mapped-IPv6 loopback
 * encoding, a look-alike sub-domain. Used for BOTH deriver bases:
 *  - the cloud fallback's loopback SHIM (so the cloud deriver rides the egress
 *    boundary and never reaches the edge fn directly), AND
 *  - the LOCAL branch's Ollama base (so `behindEgressBoundary: false` is only ever
 *    emitted for a base that genuinely stays on the machine — a remote "local"
 *    base would be a direct UNREDACTED egress; Codex HIGH #3).
 * Returns the base with any trailing slash stripped.
 */
export function requireLoopbackBase(value: string | undefined, fallback: string): string {
  const raw = typeof value === 'string' ? value.trim() : '';
  const candidate = raw.length > 0 ? raw : fallback;
  if (!CANONICAL_LOOPBACK_BASE_RE.test(candidate)) {
    throw new Error(
      `Honcho deriver base must be a canonical loopback (http://127.0.0.1:<port>); refused ${JSON.stringify(candidate)} — a non-loopback or exotic base would egress unredacted / bypass the egress boundary`
    );
  }
  return stripTrailingSlash(candidate);
}

/** Cloud-deriver SHIM base guard (back-compat name; defaults to the shim base). */
export function requireLoopbackShimBase(value?: string): string {
  return requireLoopbackBase(value, HONCHO_DEFAULT_SHIM_BASE_URL);
}

// ---------------------------------------------------------------------------
// Deriver routing — the ONLY branch point. NO selection/tier parameter (B).
// ---------------------------------------------------------------------------

/**
 * Route the Honcho deriver LLM. Exactly two branches on ONE boolean discriminant
 * (`optedIn && ready`), default-deny: both must be explicitly true to go local;
 * every other state (not opted in, opted-in-but-not-ready, unknown) falls to the
 * FREE cloud-Flash lane.
 *
 * There is intentionally NO picker/selection/tier input — the cloud branch's
 * tier is the literal {@link HONCHO_DERIVER_FORCED_TIER}, so the deriver can never
 * ride the user's paid chat tier (invariant B). The cloud base is force-guarded
 * to the loopback shim (invariant A); the api key is empty (invariant C).
 */
export function resolveHonchoDeriverConfig(input: HonchoDeriverInput): HonchoDeriverConfig {
  const mode: HonchoDeriverMode = input.deriverMode || 'auto';
  // 'local' ⇒ ALWAYS local (privacy-lock, even cold — never cloud). 'cloud' ⇒ never
  // local. 'auto' ⇒ the founder-locked rule (local only when opted-in AND ready).
  const useLocal =
    mode === 'local' || (mode === 'auto' && input.localModelOptedIn === true && input.localModelReady === true);

  if (useLocal) {
    // The LOCAL branch emits behindEgressBoundary:false — that is ONLY safe if the
    // base genuinely stays on the machine. Guard it to a canonical loopback so a
    // remote "local" base can never become a direct UNREDACTED egress (Codex #3).
    const base = requireLoopbackBase(input.ollamaBaseUrl, HONCHO_DEFAULT_OLLAMA_BASE_URL);
    return {
      branch: HONCHO_DERIVER_BRANCH_LOCAL,
      baseUrl: `${base}/v1`,
      model: input.localModelRef || HONCHO_DEFAULT_LOCAL_MODEL_REF,
      apiKey: 'ollama', // Ollama ignores the key; a placeholder, never a real secret.
      forcedTier: undefined,
      behindEgressBoundary: false,
      routeReason: mode === 'local' ? 'local-locked' : 'local-opt-in-ready',
    };
  }

  // Fallback: the FREE cloud-Flash lane, always behind the loopback shim.
  const shimBase = requireLoopbackShimBase(input.shimBaseUrl || HONCHO_DEFAULT_SHIM_BASE_URL);
  return {
    branch: HONCHO_DERIVER_BRANCH_CLOUD,
    baseUrl: `${shimBase}/v1`,
    model: '', // the shim's dedicated deriver ingress pins the free-tier model server-side
    apiKey: '', // bearer is the shim's job (Authorization header only) — NEVER baked here
    forcedTier: HONCHO_DERIVER_FORCED_TIER,
    behindEgressBoundary: true,
    routeReason:
      mode === 'cloud' ? 'forced-cloud' : input.localModelOptedIn === true ? 'opt-in-not-ready' : 'fallback-free-flash',
  };
}

// ---------------------------------------------------------------------------
// The whole per-seat descriptor.
// ---------------------------------------------------------------------------

/**
 * Build the full per-seat Honcho runtime config descriptor.
 *
 * The RAW `input.seatId` is sanitized INSIDE (assertSeatId THROWS on any
 * traversal/separator/NUL/absolute id — it can never become a db name or path).
 * `input.seatHome.hermesHome` roots the per-seat honcho data dir so the memory
 * DATA stays local + isolated. PURE: `path.join` + a sha256 hash only, no fs/net.
 */
export function buildHonchoRuntimeConfig(input: HonchoRuntimeConfigInput): HonchoRuntimeConfig {
  const legacy = isLegacySeatId(input.seatId);
  // assertSeatId returns LEGACY_SEAT_ID for legacy ids and THROWS on unsafe ones.
  const sanitized = legacy ? LEGACY_SEAT_ID : assertSeatId(input.seatId);

  // Defense-in-depth (Codex #4): the caller MUST pass a seatHome resolved from the
  // SAME seat. A mismatch (e.g. seatId A + resolveSeatHome(B)) would give this seat
  // A's db/workspace but B's on-disk honchoHome — a cross-seat memory-FS merge, the
  // worst failure. resolveSeatHome always sets a sanitized `seatId`, so compare and
  // fail LOUD rather than silently build a Frankenstein config.
  if (input.seatHome && input.seatHome.seatId !== sanitized) {
    throw new Error(
      `Honcho: seatId/seatHome mismatch (config seat ${JSON.stringify(sanitized)} vs seatHome seat ${JSON.stringify(input.seatHome.seatId)}) — refusing to build a cross-seat config`
    );
  }

  const dbName = honchoDbNameForSeat(sanitized, legacy);
  const workspaceId = honchoWorkspaceIdForSeat(sanitized, legacy);
  const pgHost = input.pgHost || '127.0.0.1';
  const pgPort = input.pgPort || 5432;
  const dbUri = `postgresql://${pgHost}:${pgPort}/${dbName}`;
  const honchoHome = path.join(input.seatHome.hermesHome, 'honcho');

  const deriver = resolveHonchoDeriverConfig(input);
  const ready = deriver.branch === HONCHO_DERIVER_BRANCH_CLOUD ? input.hasLicense === true : true;

  return {
    seatId: sanitized,
    legacy,
    dbName,
    pgHost,
    pgPort,
    dbUri,
    workspaceId,
    businessPeerId: HONCHO_BUSINESS_PEER_ID,
    privatePeerId: HONCHO_PRIVATE_PEER_ID,
    honchoHome,
    deriver,
    ready,
  };
}

/**
 * The ONE per-seat honchoHome resolver (COMPA-624 Inc.3, H-INT-2). BOTH the
 * writer (runtimeBootstrapCore → runHonchoBootstrap/writeHonchoReadyState) and the
 * reader (index.ts shim `readHonchoSeatReady` → readHonchoReadyState) MUST resolve
 * a seat's honchoHome through THIS function so the readiness file the writer writes
 * is byte-for-byte the file the reader reads. A divergence here = a permanently-inert
 * deriver lane (a silent dead feature), which is exactly the drift H-INT-2 forbids —
 * so there is a single source of truth for the path, not two derivations.
 *
 * Fail-soft: an unsafe/mismatched seat id (which buildHonchoRuntimeConfig throws on)
 * or any resolution error yields `undefined` — the caller then treats the seat as
 * not-provisioned (fail-closed), never crashing the shim/bootstrap.
 */
export function resolveHonchoHomeForSeat(userDataPath: string, seatId?: string | null): string | undefined {
  try {
    const seatHome = resolveSeatHome(userDataPath, seatId);
    return buildHonchoRuntimeConfig({ seatId: seatId ?? undefined, seatHome }).honchoHome;
  } catch {
    return undefined;
  }
}

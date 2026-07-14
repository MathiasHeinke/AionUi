// Command EVE license-code core — server-side port (Deno + node compatible).
//
// This is a 1:1 port of scripts/licensing/license-code-core.mjs (W10's canonical
// pure core). It MUST stay byte-compatible: a code signed here verifies with the
// canonical core's verifyLicenseCode under the same keypair, and vice versa. The
// node test supabase/functions/_shared/license-code-core.test.mjs proves this
// cross-compatibility on every run.
//
// We import from "node:crypto" rather than Web Crypto so the signed bytes and the
// Ed25519 scheme are identical to the canonical core (crypto.sign(null, ...) over
// the exact canonical payload JSON). Deno 2.x ships node:crypto; node runs it
// natively; so a single source of truth covers both the Edge Function runtime and
// the node cross-verification test.
//
// Wire format (identical to the canonical core):
//   CEVE.v1.<base64url(payload-json)>.<base64url(ed25519-sig-over-payload-json)>

import crypto from 'node:crypto';
import { Buffer } from 'node:buffer';

export const LICENSE_CODE_VERSION = 'command-eve-license/v1';

// CEVE.v2 — additive superset of v1 (trial_ends_at + seat_count appended). See
// docs/specs/command-eve-ceve-v2-payload-lock.md. v1 stays frozen; a v2-aware
// verifier accepts BOTH wire versions, dispatching on the wire-version segment.
export const LICENSE_CODE_VERSION_V2 = 'command-eve-license/v2';

export const LICENSE_CODE_PREFIX = 'CEVE';
export const LICENSE_CODE_WIRE_VERSION = 'v1';
export const LICENSE_CODE_WIRE_VERSION_V2 = 'v2';

// Wire versions a v2-aware verifier accepts. v1-only verifiers (old desktops)
// keep LICENSE_CODE_WIRE_VERSION as their sole supported version and fail closed
// on "v2" (LICENSE_VERSION_UNSUPPORTED) — the rollout-order guarantee in the lock.
export const SUPPORTED_WIRE_VERSIONS = Object.freeze([
  LICENSE_CODE_WIRE_VERSION,
  LICENSE_CODE_WIRE_VERSION_V2,
]) as readonly string[];

export const LICENSE_EDITIONS = Object.freeze(['pilot', 'standard']) as readonly string[];

export const LICENSE_REASON_CODES = Object.freeze({
  MALFORMED: 'LICENSE_MALFORMED',
  VERSION_UNSUPPORTED: 'LICENSE_VERSION_UNSUPPORTED',
  SIGNATURE_INVALID: 'LICENSE_SIGNATURE_INVALID',
  EXPIRED: 'LICENSE_EXPIRED',
  NOT_YET_VALID: 'LICENSE_NOT_YET_VALID',
});

export interface LicensePayload {
  license_version: string;
  edition: string;
  serial: string;
  tenant_serial: string;
  issued_at: string;
  expires_at: string | null;
}

// CEVE.v2 payload = the v1 keys UNCHANGED + trial_ends_at + seat_count appended.
export interface LicensePayloadV2 extends LicensePayload {
  trial_ends_at: string | null;
  seat_count: number;
}

export type AnyLicensePayload = LicensePayload | LicensePayloadV2;

export type BuildResult =
  | { ok: true; payload: LicensePayload }
  | { ok: false; reason_code: string; evidence: Record<string, unknown> };

export type BuildResultV2 =
  | { ok: true; payload: LicensePayloadV2 }
  | { ok: false; reason_code: string; evidence: Record<string, unknown> };

// ---------------------------------------------------------------------------
// base64url helpers (no padding) — identical to the canonical core.
// ---------------------------------------------------------------------------

function toBase64Url(buffer: Buffer | Uint8Array): string {
  return Buffer.from(buffer).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

function fromBase64Url(value: string): Buffer | null {
  if (typeof value !== 'string' || value.length === 0 || /[^A-Za-z0-9_-]/.test(value)) {
    return null;
  }
  const pad = value.length % 4 === 0 ? '' : '='.repeat(4 - (value.length % 4));
  const normalized = value.replace(/-/g, '+').replace(/_/g, '/') + pad;
  try {
    return Buffer.from(normalized, 'base64');
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Canonical payload — fixed key order is part of the signed-bytes contract.
// ---------------------------------------------------------------------------

const CANONICAL_PAYLOAD_KEYS = Object.freeze([
  'license_version',
  'edition',
  'serial',
  'tenant_serial',
  'issued_at',
  'expires_at',
]) as readonly (keyof LicensePayload)[];

// CEVE.v2 canonical key order: the v1 keys UNCHANGED, then the two new keys
// APPENDED (never reorder, never insert between). This is the v2 signed-bytes
// contract. trial_ends_at: ISO-8601 string | null. seat_count: integer >= 1.
const CANONICAL_PAYLOAD_KEYS_V2 = Object.freeze([
  'license_version',
  'edition',
  'serial',
  'tenant_serial',
  'issued_at',
  'expires_at',
  'trial_ends_at',
  'seat_count',
]) as readonly (keyof LicensePayloadV2)[];

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

function normalizeSerial(serial: unknown): string | null {
  if (typeof serial === 'number' && Number.isFinite(serial)) return String(serial);
  if (isNonEmptyString(serial)) return serial.trim();
  return null;
}

export function buildLicensePayload(
  input: {
    edition?: string;
    serial?: string | number;
    tenant_serial?: string | number;
    issued_at?: string;
    expires_at?: string | null;
  } = {}
): BuildResult {
  const { edition, serial, tenant_serial, issued_at, expires_at } = input;
  const evidence: Record<string, unknown> = {};

  if (!edition || !LICENSE_EDITIONS.includes(edition)) {
    evidence.edition = edition ?? null;
    evidence.allowed_editions = LICENSE_EDITIONS;
    return { ok: false, reason_code: LICENSE_REASON_CODES.MALFORMED, evidence };
  }

  const normalizedSerial = normalizeSerial(serial);
  if (normalizedSerial === null) {
    evidence.serial = serial ?? null;
    return { ok: false, reason_code: LICENSE_REASON_CODES.MALFORMED, evidence };
  }

  const normalizedTenantSerial = normalizeSerial(tenant_serial);
  if (normalizedTenantSerial === null) {
    evidence.tenant_serial = tenant_serial ?? null;
    return { ok: false, reason_code: LICENSE_REASON_CODES.MALFORMED, evidence };
  }

  if (!isNonEmptyString(issued_at) || Number.isNaN(Date.parse(issued_at))) {
    evidence.issued_at = issued_at ?? null;
    return { ok: false, reason_code: LICENSE_REASON_CODES.MALFORMED, evidence };
  }

  let normalizedExpiresAt: string | null = null;
  if (expires_at !== undefined && expires_at !== null && expires_at !== '') {
    if (!isNonEmptyString(expires_at) || Number.isNaN(Date.parse(expires_at))) {
      evidence.expires_at = expires_at;
      return { ok: false, reason_code: LICENSE_REASON_CODES.MALFORMED, evidence };
    }
    normalizedExpiresAt = expires_at;
  }

  const payload: LicensePayload = {
    license_version: LICENSE_CODE_VERSION,
    edition,
    serial: normalizedSerial,
    tenant_serial: normalizedTenantSerial,
    issued_at,
    expires_at: normalizedExpiresAt,
  };

  return { ok: true, payload };
}

function isPositiveInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 1;
}

/**
 * Build a canonical CEVE.v2 license payload (additive superset of v1).
 *
 * The v1 fields are validated EXACTLY as buildLicensePayload does (re-used, not
 * re-implemented), then the two new fields are validated and appended in fixed
 * key order:
 *   - trial_ends_at: ISO-8601 string | null  (null = paid / non-trial license)
 *   - seat_count:    integer >= 1            (offline-informational; server gates)
 */
export function buildLicensePayloadV2(
  input: {
    edition?: string;
    serial?: string | number;
    tenant_serial?: string | number;
    issued_at?: string;
    expires_at?: string | null;
    trial_ends_at?: string | null;
    seat_count?: number;
  } = {}
): BuildResultV2 {
  const { edition, serial, tenant_serial, issued_at, expires_at, trial_ends_at, seat_count } = input;

  // Re-use the v1 validation for the shared fields so the two stay in lockstep.
  const base = buildLicensePayload({ edition, serial, tenant_serial, issued_at, expires_at });
  if (!base.ok) return base;

  const evidence: Record<string, unknown> = {};

  // trial_ends_at is optional: null / undefined / "" means a paid (non-trial)
  // license. When present it must be a valid ISO-8601 string.
  let normalizedTrialEndsAt: string | null = null;
  if (trial_ends_at !== undefined && trial_ends_at !== null && trial_ends_at !== '') {
    if (!isNonEmptyString(trial_ends_at) || Number.isNaN(Date.parse(trial_ends_at))) {
      evidence.trial_ends_at = trial_ends_at;
      return { ok: false, reason_code: LICENSE_REASON_CODES.MALFORMED, evidence };
    }
    normalizedTrialEndsAt = trial_ends_at;
  }

  // seat_count is optional and defaults to 1; when present it must be an integer >= 1.
  let normalizedSeatCount = 1;
  if (seat_count !== undefined && seat_count !== null) {
    if (!isPositiveInteger(seat_count)) {
      evidence.seat_count = seat_count;
      return { ok: false, reason_code: LICENSE_REASON_CODES.MALFORMED, evidence };
    }
    normalizedSeatCount = seat_count;
  }

  const payload: LicensePayloadV2 = {
    license_version: LICENSE_CODE_VERSION_V2,
    edition: base.payload.edition,
    serial: base.payload.serial,
    tenant_serial: base.payload.tenant_serial,
    issued_at: base.payload.issued_at,
    expires_at: base.payload.expires_at,
    trial_ends_at: normalizedTrialEndsAt,
    seat_count: normalizedSeatCount,
  };

  return { ok: true, payload };
}

/**
 * Serialize a payload to its canonical JSON string (stable key order).
 *
 * Dispatches on payload.license_version: the v2 version selects the 8-key v2 key
 * order; everything else uses the frozen 6-key v1 order (byte-identical to
 * before this v2 addition existed).
 */
export function canonicalPayloadJson(payload: Partial<AnyLicensePayload>): string {
  const keys: readonly string[] =
    payload.license_version === LICENSE_CODE_VERSION_V2 ? CANONICAL_PAYLOAD_KEYS_V2 : CANONICAL_PAYLOAD_KEYS;
  const ordered: Record<string, unknown> = {};
  for (const key of keys) {
    ordered[key] = key in payload ? (payload as Record<string, unknown>)[key] : null;
  }
  return JSON.stringify(ordered);
}

// ---------------------------------------------------------------------------
// Sign
// ---------------------------------------------------------------------------

function coercePrivateKey(privateKeyPem: string | crypto.KeyObject): crypto.KeyObject {
  if (privateKeyPem && typeof privateKeyPem === 'object' && (privateKeyPem as crypto.KeyObject).asymmetricKeyType) {
    return privateKeyPem as crypto.KeyObject;
  }
  return crypto.createPrivateKey(privateKeyPem as string);
}

function coercePublicKey(publicKeyPem: string | crypto.KeyObject): crypto.KeyObject {
  if (publicKeyPem && typeof publicKeyPem === 'object' && (publicKeyPem as crypto.KeyObject).asymmetricKeyType) {
    return publicKeyPem as crypto.KeyObject;
  }
  return crypto.createPublicKey(publicKeyPem as string);
}

export function signLicenseCode(args: {
  payload: AnyLicensePayload;
  privateKeyPem: string | crypto.KeyObject;
}): string {
  const { payload, privateKeyPem } = args ?? ({} as typeof args);
  if (!payload || typeof payload !== 'object') {
    throw new Error('signLicenseCode: payload object is required');
  }
  const key = coercePrivateKey(privateKeyPem);
  if (key.asymmetricKeyType !== 'ed25519') {
    throw new Error(`signLicenseCode: expected ed25519 private key, got ${key.asymmetricKeyType}`);
  }

  // Wire version is derived from the payload's license_version so v2 payloads
  // get the "v2" wire segment and v1 payloads stay byte-identical to before.
  const wireVersion =
    payload.license_version === LICENSE_CODE_VERSION_V2 ? LICENSE_CODE_WIRE_VERSION_V2 : LICENSE_CODE_WIRE_VERSION;

  const payloadJson = canonicalPayloadJson(payload);
  const payloadBytes = Buffer.from(payloadJson, 'utf8');
  // Ed25519: algorithm MUST be null; crypto.sign hashes internally.
  const signature = crypto.sign(null, payloadBytes, key);

  return [LICENSE_CODE_PREFIX, wireVersion, toBase64Url(payloadBytes), toBase64Url(signature)].join('.');
}

// ---------------------------------------------------------------------------
// Verify (ported for symmetry / self-check; the desktop app owns user-facing
// verification, but the mint function self-verifies before persisting).
// ---------------------------------------------------------------------------

export type VerifyResult =
  | { ok: true; payload: AnyLicensePayload }
  | { ok: false; reason_code: string; evidence: Record<string, unknown> };

function fail(reason_code: string, evidence: Record<string, unknown> = {}): VerifyResult {
  return { ok: false, reason_code, evidence };
}

export function verifyLicenseCode(args: {
  code: string;
  publicKeyPem: string | crypto.KeyObject;
  now?: Date | number | string;
}): VerifyResult {
  const { code, publicKeyPem, now } = args ?? ({} as typeof args);
  if (!isNonEmptyString(code)) {
    return fail(LICENSE_REASON_CODES.MALFORMED, { detail: 'code is empty or not a string' });
  }

  const parts = code.trim().split('.');
  if (parts.length !== 4) {
    return fail(LICENSE_REASON_CODES.MALFORMED, {
      detail: 'expected 4 dot-separated segments',
      segments: parts.length,
    });
  }

  const [prefix, wireVersion, payloadB64, sigB64] = parts;

  if (prefix !== LICENSE_CODE_PREFIX) {
    return fail(LICENSE_REASON_CODES.MALFORMED, { detail: 'unknown code prefix', prefix });
  }

  // Dispatch on the wire-version segment. A v2-aware verifier accepts BOTH "v1"
  // and "v2"; each wire version pins the exact payload license_version it
  // requires (so a "v1" wire carrying a v2 payload — or vice versa — is rejected
  // as VERSION_UNSUPPORTED, never silently cross-parsed). An old v1-only verifier
  // keeps a single supported version and fails closed on "v2".
  if (!SUPPORTED_WIRE_VERSIONS.includes(wireVersion)) {
    return fail(LICENSE_REASON_CODES.VERSION_UNSUPPORTED, {
      detail: 'unsupported wire version',
      wire_version: wireVersion,
      supported: SUPPORTED_WIRE_VERSIONS,
    });
  }
  const expectedPayloadVersion =
    wireVersion === LICENSE_CODE_WIRE_VERSION_V2 ? LICENSE_CODE_VERSION_V2 : LICENSE_CODE_VERSION;

  const payloadBytes = fromBase64Url(payloadB64);
  const signature = fromBase64Url(sigB64);
  if (!payloadBytes || !signature) {
    return fail(LICENSE_REASON_CODES.MALFORMED, {
      detail: 'payload or signature is not valid base64url',
    });
  }

  let payload: AnyLicensePayload;
  try {
    payload = JSON.parse(payloadBytes.toString('utf8'));
  } catch {
    return fail(LICENSE_REASON_CODES.MALFORMED, { detail: 'payload is not valid JSON' });
  }
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    return fail(LICENSE_REASON_CODES.MALFORMED, { detail: 'payload is not a JSON object' });
  }

  // The payload's license_version MUST match the version pinned by the wire
  // segment. This binds the two together so neither can be swapped independently.
  if (payload.license_version !== expectedPayloadVersion) {
    return fail(LICENSE_REASON_CODES.VERSION_UNSUPPORTED, {
      detail: 'unsupported payload license_version',
      license_version: payload.license_version ?? null,
      wire_version: wireVersion,
      supported: expectedPayloadVersion,
    });
  }

  let key: crypto.KeyObject;
  try {
    key = coercePublicKey(publicKeyPem);
  } catch (error) {
    throw new Error(`verifyLicenseCode: invalid public key: ${(error as Error).message}`);
  }
  if (key.asymmetricKeyType !== 'ed25519') {
    throw new Error(`verifyLicenseCode: expected ed25519 public key, got ${key.asymmetricKeyType}`);
  }

  let signatureOk = false;
  try {
    signatureOk = crypto.verify(null, payloadBytes, key, signature);
  } catch {
    signatureOk = false;
  }
  if (!signatureOk) {
    return fail(LICENSE_REASON_CODES.SIGNATURE_INVALID, {
      detail: 'ed25519 signature did not verify',
    });
  }

  const nowMs = now === undefined ? Date.now() : new Date(now).getTime();
  if (Number.isNaN(nowMs)) {
    throw new Error("verifyLicenseCode: 'now' is not a valid date");
  }

  const issuedMs = Date.parse(payload.issued_at);
  if (Number.isNaN(issuedMs)) {
    return fail(LICENSE_REASON_CODES.MALFORMED, {
      detail: 'issued_at is not a valid date',
      issued_at: payload.issued_at ?? null,
    });
  }
  if (nowMs < issuedMs) {
    return fail(LICENSE_REASON_CODES.NOT_YET_VALID, {
      detail: 'issued_at is in the future',
      issued_at: payload.issued_at,
      now: new Date(nowMs).toISOString(),
    });
  }

  // CEVE.v2 trial branch (offline semantics from the lock doc):
  //   trial_ends_at != null -> TRIAL : valid iff now < trial_ends_at
  //   trial_ends_at == null -> PAID  : fall through to the v1 expires_at check
  // A trial code is gated by trial_ends_at, NOT expires_at. seat_count is
  // informational offline (the server is the binding seat gate) and is not
  // checked here.
  const v2 = payload as LicensePayloadV2;
  if (
    payload.license_version === LICENSE_CODE_VERSION_V2 &&
    v2.trial_ends_at !== null &&
    v2.trial_ends_at !== undefined
  ) {
    const trialEndsMs = Date.parse(v2.trial_ends_at);
    if (Number.isNaN(trialEndsMs)) {
      return fail(LICENSE_REASON_CODES.MALFORMED, {
        detail: 'trial_ends_at is not a valid date',
        trial_ends_at: v2.trial_ends_at,
      });
    }
    // Inclusive expiry: at-or-after the trial end instant the trial is over.
    if (nowMs >= trialEndsMs) {
      return fail(LICENSE_REASON_CODES.EXPIRED, {
        detail: 'trial license is past its trial_ends_at',
        trial_ends_at: v2.trial_ends_at,
        now: new Date(nowMs).toISOString(),
      });
    }
    return { ok: true, payload };
  }

  if (payload.expires_at !== null && payload.expires_at !== undefined) {
    const expiresMs = Date.parse(payload.expires_at);
    if (Number.isNaN(expiresMs)) {
      return fail(LICENSE_REASON_CODES.MALFORMED, {
        detail: 'expires_at is not a valid date',
        expires_at: payload.expires_at,
      });
    }
    if (nowMs >= expiresMs) {
      return fail(LICENSE_REASON_CODES.EXPIRED, {
        detail: 'license is past its expires_at',
        expires_at: payload.expires_at,
        now: new Date(nowMs).toISOString(),
      });
    }
  }

  return { ok: true, payload };
}

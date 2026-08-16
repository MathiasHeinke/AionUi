/**
 * Command EVE — MAT-1774 — account-authenticated Seed lifecycle requests.
 *
 * MAIN owns the Supabase session. The renderer sends only a display name,
 * stable seed id and/or idempotency key; access/refresh tokens never cross IPC.
 */

import { COMMAND_EVE_SUPABASE_URL, resolveSupabaseAnonKey, type CommandEveAccountSession } from './desktopAuthLoopback';
import { getFreshSession } from './accountSessionAtRest';

export const CREATE_SEED_FUNCTION_URL = `${COMMAND_EVE_SUPABASE_URL}/functions/v1/create-seat`;
export const RENAME_SEED_FUNCTION_URL = `${COMMAND_EVE_SUPABASE_URL}/functions/v1/rename-seed`;
// Product contract is unlimited/free. This constant is only the server's
// non-commercial safety valve and must never be rendered as a quota.
export const ACCOUNT_SEED_ABUSE_CEILING = 1000;

const REQUEST_TIMEOUT_MS = 20_000;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export interface SeedLifecycleDeps {
  fetch?: typeof fetch;
  getFreshSession?: (
    userDataPath: string
  ) => Promise<{ ok: boolean; session?: CommandEveAccountSession; reason_code?: string }>;
  anonKey?: string;
  timeoutMs?: number;
}

export interface SeedCreateInput {
  displayName: string;
  clientRequestId: string;
}

export interface SeedCreateResult {
  ok: boolean;
  seedId?: string;
  created?: boolean;
  seedCount?: number;
  seedLimit: number | null;
  reasonCode?: string;
}

export interface SeedRenameInput {
  seedId: string;
  displayName: string;
}

export interface SeedRenameResult {
  ok: boolean;
  seedId?: string;
  displayName?: string;
  reasonCode?: string;
}

function validUuid(value: unknown): value is string {
  return typeof value === 'string' && UUID_RE.test(value);
}

function positiveInt(value: unknown): number | undefined {
  if (value === null || value === undefined || value === '') return undefined;
  const number = Number(value);
  return Number.isInteger(number) && number >= 0 ? number : undefined;
}

function mapReason(raw: Record<string, unknown> | null, status: number): string {
  const server = typeof raw?.reason_code === 'string' ? raw.reason_code : '';
  if (/ABUSE_CEILING_REACHED/i.test(server) || raw?.error === 'seat_abuse_ceiling_reached' || status === 429) {
    return 'SEED_ABUSE_CEILING_REACHED';
  }
  if (/NOT_ACCOUNT_ADMIN|FORBIDDEN/i.test(server) || status === 403) return 'SEED_NOT_ACCOUNT_ADMIN';
  if (/NOT_FOUND/i.test(server) || status === 404) return 'SEED_NOT_FOUND';
  if (/INVALID/i.test(server) || status === 400) return 'SEED_INVALID_INPUT';
  return `SEED_HTTP_${status}`;
}

async function postSeedFunction(
  userDataPath: string,
  url: string,
  body: Record<string, unknown>,
  deps: SeedLifecycleDeps
): Promise<{ ok: boolean; raw?: Record<string, unknown>; reasonCode?: string }> {
  const fetchImpl = deps.fetch ?? (globalThis.fetch as typeof fetch);
  const freshSession = deps.getFreshSession ?? ((path: string) => getFreshSession(path));
  const anonKey = deps.anonKey ?? resolveSupabaseAnonKey();
  const timeoutMs = deps.timeoutMs ?? REQUEST_TIMEOUT_MS;

  const session = await freshSession(userDataPath);
  if (!session.ok || !session.session?.access_token) {
    return { ok: false, reasonCode: session.reason_code ?? 'SEED_NOT_AUTHENTICATED' };
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    let response: Response;
    try {
      response = await fetchImpl(url, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          apikey: anonKey,
          Authorization: `Bearer ${session.session.access_token}`,
          Accept: 'application/json',
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
    } catch (error) {
      return {
        ok: false,
        reasonCode: error instanceof Error && error.name === 'AbortError' ? 'SEED_PROVISION_TIMEOUT' : 'SEED_NETWORK',
      };
    }
    const raw = (await response.json().catch((): null => null)) as Record<string, unknown> | null;
    if (!response.ok) return { ok: false, reasonCode: mapReason(raw, response.status) };
    if (!raw || raw.ok !== true) return { ok: false, reasonCode: 'SEED_MALFORMED_RESPONSE' };
    return { ok: true, raw };
  } finally {
    clearTimeout(timer);
  }
}

export async function createSeed(
  userDataPath: string,
  input: SeedCreateInput,
  deps: SeedLifecycleDeps = {}
): Promise<SeedCreateResult> {
  const name = input.displayName.trim();
  if (!name || name.length > 200 || !validUuid(input.clientRequestId)) {
    return { ok: false, seedLimit: null, reasonCode: 'SEED_INVALID_INPUT' };
  }
  const response = await postSeedFunction(
    userDataPath,
    CREATE_SEED_FUNCTION_URL,
    { name, client_request_id: input.clientRequestId },
    deps
  );
  if (!response.ok || !response.raw) {
    return { ok: false, seedLimit: null, reasonCode: response.reasonCode };
  }
  const seedId = response.raw.seed_id ?? response.raw.tenant_id;
  if (!validUuid(seedId)) {
    return { ok: false, seedLimit: null, reasonCode: 'SEED_MALFORMED_RESPONSE' };
  }
  return {
    ok: true,
    seedId,
    created: response.raw.created !== false,
    seedCount: positiveInt(response.raw.seed_count ?? response.raw.seats_used),
    seedLimit:
      response.raw.unlimited === true
        ? null
        : (positiveInt(response.raw.seed_limit ?? response.raw.client_seat_count) ?? null),
  };
}

export async function renameSeed(
  userDataPath: string,
  input: SeedRenameInput,
  deps: SeedLifecycleDeps = {}
): Promise<SeedRenameResult> {
  const displayName = input.displayName.trim();
  if (!validUuid(input.seedId) || !displayName || displayName.length > 200) {
    return { ok: false, reasonCode: 'SEED_INVALID_INPUT' };
  }
  const response = await postSeedFunction(
    userDataPath,
    RENAME_SEED_FUNCTION_URL,
    { seed_id: input.seedId, display_name: displayName },
    deps
  );
  if (!response.ok || !response.raw) return { ok: false, reasonCode: response.reasonCode };
  const seedId = response.raw.seed_id;
  const returnedName = response.raw.display_name;
  if (!validUuid(seedId) || typeof returnedName !== 'string' || !returnedName.trim()) {
    return { ok: false, reasonCode: 'SEED_MALFORMED_RESPONSE' };
  }
  return { ok: true, seedId, displayName: returnedName.trim() };
}

const createInFlightByRequest = new Map<string, Promise<SeedCreateResult>>();

/** MAIN-level single-flight is the second belt behind the renderer button/ref.
 * A timeout releases the flight; the renderer retries with the SAME request id,
 * so the server RPC reconciles to the committed seed instead of minting another. */
export function createSeedSingleFlight(
  userDataPath: string,
  input: SeedCreateInput,
  deps: SeedLifecycleDeps = {}
): Promise<SeedCreateResult> {
  const existing = createInFlightByRequest.get(input.clientRequestId);
  if (existing) return existing;
  const pending = createSeed(userDataPath, input, deps);
  createInFlightByRequest.set(input.clientRequestId, pending);
  void pending.finally(() => {
    if (createInFlightByRequest.get(input.clientRequestId) === pending) {
      createInFlightByRequest.delete(input.clientRequestId);
    }
  });
  return pending;
}

export function resetSeedCreateSingleFlightForTests(): void {
  createInFlightByRequest.clear();
}

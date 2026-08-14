import { useCallback, useRef, useState } from 'react';

import { commandEve } from '@/common/adapter/ipcBridge';

export interface SeedCreateOutcome {
  ok: boolean;
  seedId?: string;
  created?: boolean;
  seedCount?: number;
  seedLimit: number | null;
  reasonCode?: string;
}

// A commit-uncertain create must retain one idempotency key across component
// unmounts and across both shipped create surfaces (SeatRail + Account). The
// display name is the user's stable retry handle; different names remain
// independent and MAIN still coalesces identical request IDs.
const pendingRequestIdByDisplayName = new Map<string, string>();

const TERMINAL_CREATE_FAILURES = new Set([
  'SEED_INVALID_INPUT',
  'SEED_NOT_ACCOUNT_ADMIN',
  'SEED_ABUSE_CEILING_REACHED',
  'SEED_NOT_AUTHENTICATED',
]);

function attemptKey(displayName: string): string {
  return displayName.trim();
}

function newRequestId(): string | null {
  if (typeof globalThis.crypto?.randomUUID === 'function') return globalThis.crypto.randomUUID();
  if (typeof globalThis.crypto?.getRandomValues !== 'function') return null;
  const bytes = new Uint8Array(16);
  globalThis.crypto.getRandomValues(bytes);
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = Array.from(bytes, (value) => value.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function requestIdFor(displayName: string): string | null {
  const key = attemptKey(displayName);
  const existing = pendingRequestIdByDisplayName.get(key);
  if (existing) return existing;
  const created = newRequestId();
  if (created) pendingRequestIdByDisplayName.set(key, created);
  return created;
}

function clearAttempt(displayName: string, requestId: string): void {
  const key = attemptKey(displayName);
  if (pendingRequestIdByDisplayName.get(key) === requestId) pendingRequestIdByDisplayName.delete(key);
}

function isCommitUncertain(reasonCode?: string): boolean {
  return !reasonCode || !TERMINAL_CREATE_FAILURES.has(reasonCode);
}

export function resetSeedLifecycleAttemptsForTests(): void {
  pendingRequestIdByDisplayName.clear();
}

export function useSeedLifecycle() {
  const [provisioning, setProvisioning] = useState(false);
  const [retryPending, setRetryPending] = useState(false);
  const inFlightRef = useRef<Promise<SeedCreateOutcome> | null>(null);

  const createSeed = useCallback((displayName: string): Promise<SeedCreateOutcome> => {
    if (inFlightRef.current) return inFlightRef.current;
    const requestId = requestIdFor(displayName);
    if (!requestId) {
      setRetryPending(false);
      return Promise.resolve({ ok: false, seedLimit: null, reasonCode: 'SEED_REQUEST_ID_UNAVAILABLE' });
    }
    setProvisioning(true);

    const pending = (async (): Promise<SeedCreateOutcome> => {
      try {
        const response = await commandEve.seedCreate.invoke({ displayName, clientRequestId: requestId });
        const data = response.data;
        const outcome: SeedCreateOutcome = {
          ok: data?.ok === true,
          ...(data?.seed_id ? { seedId: data.seed_id } : {}),
          ...(data?.created !== undefined ? { created: data.created } : {}),
          ...(data?.seed_count !== undefined ? { seedCount: data.seed_count } : {}),
          seedLimit: data?.seed_limit ?? null,
          ...(data?.reason_code ? { reasonCode: data.reason_code } : {}),
        };
        if (outcome.ok) {
          clearAttempt(displayName, requestId);
          setRetryPending(false);
        } else {
          const uncertain = isCommitUncertain(outcome.reasonCode);
          if (!uncertain) clearAttempt(displayName, requestId);
          setRetryPending(uncertain);
        }
        return outcome;
      } catch {
        setRetryPending(true);
        return { ok: false, seedLimit: null, reasonCode: 'SEED_PROVISION_TIMEOUT' };
      } finally {
        setProvisioning(false);
      }
    })();

    inFlightRef.current = pending;
    void pending.finally(() => {
      if (inFlightRef.current === pending) inFlightRef.current = null;
    });
    return pending;
  }, []);

  const resetCreateAttempt = useCallback(() => {
    if (inFlightRef.current) return;
    // Do not erase a commit-uncertain shared key. A different display name gets
    // its own key; the same name must reconcile the original server request.
    setRetryPending(false);
  }, []);

  return { provisioning, retryPending, createSeed, resetCreateAttempt };
}

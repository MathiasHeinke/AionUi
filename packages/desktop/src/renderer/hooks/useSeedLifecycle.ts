import { useCallback, useEffect, useRef, useState } from 'react';

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
type SharedSeedAttempt = {
  requestId: string;
  commitUncertain: boolean;
};

type LocalRetryAttempt = {
  key: string;
  requestId: string;
};

const pendingAttemptByDisplayName = new Map<string, SharedSeedAttempt>();
// A successful replay can settle an attempt from the other mounted surface.
// Keep a small process-local receipt by request id so a stale retry click is a
// no-op reconciliation, never a fresh create. At most the technical Seat
// ceiling worth of distinct successful attempts can accumulate in one process.
const settledAttemptByRequestId = new Map<string, SeedCreateOutcome>();
const attemptResolutionListeners = new Set<(key: string, requestId: string) => void>();

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
  const existing = pendingAttemptByDisplayName.get(key);
  if (existing) return existing.requestId;
  const created = newRequestId();
  if (created) pendingAttemptByDisplayName.set(key, { requestId: created, commitUncertain: false });
  return created;
}

function markAttemptUncertain(displayName: string, requestId: string): void {
  const key = attemptKey(displayName);
  const attempt = pendingAttemptByDisplayName.get(key);
  if (attempt?.requestId === requestId) attempt.commitUncertain = true;
}

function notifyAttemptResolved(key: string, requestId: string): void {
  for (const listener of attemptResolutionListeners) listener(key, requestId);
}

function clearAttempt(displayName: string, requestId: string): void {
  const key = attemptKey(displayName);
  if (pendingAttemptByDisplayName.get(key)?.requestId === requestId) {
    pendingAttemptByDisplayName.delete(key);
    notifyAttemptResolved(key, requestId);
  }
}

function settleAttempt(displayName: string, requestId: string, outcome: SeedCreateOutcome): void {
  const key = attemptKey(displayName);
  const attempt = pendingAttemptByDisplayName.get(key);
  if (attempt?.requestId !== requestId) return;
  pendingAttemptByDisplayName.delete(key);
  settledAttemptByRequestId.set(requestId, { ...outcome, created: false });
  notifyAttemptResolved(key, requestId);
}

function isCommitUncertain(reasonCode?: string): boolean {
  return !reasonCode || !TERMINAL_CREATE_FAILURES.has(reasonCode);
}

export function resetSeedLifecycleAttemptsForTests(): void {
  pendingAttemptByDisplayName.clear();
  settledAttemptByRequestId.clear();
}
export function useSeedLifecycle() {
  const [provisioning, setProvisioning] = useState(false);
  const [retryPending, setRetryPending] = useState(false);
  const inFlightRef = useRef<Promise<SeedCreateOutcome> | null>(null);
  const retryAttemptRef = useRef<LocalRetryAttempt | null>(null);

  useEffect(() => {
    const onResolved = (key: string, requestId: string): void => {
      const retry = retryAttemptRef.current;
      if (retry?.key === key && retry.requestId === requestId) setRetryPending(false);
    };
    attemptResolutionListeners.add(onResolved);
    return () => {
      attemptResolutionListeners.delete(onResolved);
    };
  }, []);

  const createSeed = useCallback((displayName: string): Promise<SeedCreateOutcome> => {
    if (inFlightRef.current) return inFlightRef.current;
    const key = attemptKey(displayName);
    const localRetry = retryAttemptRef.current;
    const externallySettled = localRetry?.key === key ? settledAttemptByRequestId.get(localRetry.requestId) : null;
    if (externallySettled) {
      retryAttemptRef.current = null;
      setRetryPending(false);
      return Promise.resolve({ ...externallySettled, created: false });
    }
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
          settleAttempt(displayName, requestId, outcome);
          if (retryAttemptRef.current?.requestId === requestId) retryAttemptRef.current = null;
          setRetryPending(false);
        } else {
          const uncertain = isCommitUncertain(outcome.reasonCode);
          if (uncertain) {
            const externalSuccess = settledAttemptByRequestId.get(requestId);
            if (externalSuccess) {
              retryAttemptRef.current = null;
              setRetryPending(false);
              return { ...externalSuccess, created: false };
            }
            markAttemptUncertain(displayName, requestId);
            retryAttemptRef.current = { key, requestId };
          } else {
            clearAttempt(displayName, requestId);
            if (retryAttemptRef.current?.requestId === requestId) retryAttemptRef.current = null;
          }
          setRetryPending(uncertain);
        }
        return outcome;
      } catch {
        const externalSuccess = settledAttemptByRequestId.get(requestId);
        if (externalSuccess) {
          retryAttemptRef.current = null;
          setRetryPending(false);
          return { ...externalSuccess, created: false };
        }
        markAttemptUncertain(displayName, requestId);
        retryAttemptRef.current = { key, requestId };
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
    // Clearing only this hook's stale receipt is the explicit boundary between
    // acknowledging an externally-settled retry and a later deliberate create.
    retryAttemptRef.current = null;
    setRetryPending(false);
  }, []);

  return { provisioning, retryPending, createSeed, resetCreateAttempt };
}

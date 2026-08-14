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

function newRequestId(): string {
  if (typeof globalThis.crypto?.randomUUID === 'function') return globalThis.crypto.randomUUID();
  const bytes = new Uint8Array(16);
  globalThis.crypto?.getRandomValues?.(bytes);
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = Array.from(bytes, (value) => value.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export function useSeedLifecycle() {
  const [provisioning, setProvisioning] = useState(false);
  const [retryPending, setRetryPending] = useState(false);
  const inFlightRef = useRef<Promise<SeedCreateOutcome> | null>(null);
  const requestIdRef = useRef<string | null>(null);

  const createSeed = useCallback((displayName: string): Promise<SeedCreateOutcome> => {
    if (inFlightRef.current) return inFlightRef.current;
    const requestId = requestIdRef.current ?? newRequestId();
    requestIdRef.current = requestId;
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
          requestIdRef.current = null;
          setRetryPending(false);
        } else {
          setRetryPending(outcome.reasonCode === 'SEED_PROVISION_TIMEOUT');
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
    requestIdRef.current = null;
    setRetryPending(false);
  }, []);

  return { provisioning, retryPending, createSeed, resetCreateAttempt };
}

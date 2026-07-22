/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import { httpRequest, isBackendHttpError } from '@/common/adapter/httpBridge';
import {
  COMMAND_EVE_LOCAL_RUNTIME_PROVIDER_ID,
  COMMAND_EVE_SHELL_ENABLED,
  getCommandEveLocalRuntimeProvider,
} from '@/common/config/commandEveShell';
import type { IProvider } from '@/common/config/storage';
import type { CreateProviderRequest } from '@/common/types/provider/providerApi';

const DEFAULT_MAX_ATTEMPTS = 3;
const DEFAULT_RETRY_DELAY_MS = 150;
const DEFAULT_REQUEST_TIMEOUT_MS = 2_500;

export type CommandEveLocalProviderBootstrapResult = {
  status: 'disabled' | 'ready';
  attempts: number;
  created: boolean;
  conflict: boolean;
  provider?: IProvider;
};

export type CommandEveLocalProviderBootstrapOptions = {
  shellEnabled?: boolean;
  maxAttempts?: number;
  retryDelayMs?: number;
  requestTimeoutMs?: number;
  sleep?: (delayMs: number) => Promise<void>;
};

function normalizePositiveInteger(value: number | undefined, fallback: number): number {
  return Number.isInteger(value) && Number(value) > 0 ? Number(value) : fallback;
}

function sleep(delayMs: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, delayMs));
}

function localRuntimeCreateRequest(): CreateProviderRequest {
  const { use_model, ...provider } = getCommandEveLocalRuntimeProvider();
  return {
    ...provider,
    models: [use_model],
    enabled: true,
  };
}

async function readLocalRuntimeProvider(requestTimeoutMs: number): Promise<IProvider | undefined> {
  const providers =
    (await httpRequest<IProvider[]>('GET', '/api/providers', undefined, { timeoutMs: requestTimeoutMs })) || [];
  return providers.find((provider) => provider.id === COMMAND_EVE_LOCAL_RUNTIME_PROVIDER_ID);
}

function isProviderAlreadyExistsError(error: unknown): boolean {
  // This bootstrap talks directly to httpBridge, whose structured error keeps
  // the HTTP status across dev and packaged contexts. Do not parse arbitrary
  // message text: a model name or backend message containing "409" is not a
  // duplicate-provider proof.
  return isBackendHttpError(error) && error.status === 409;
}

/**
 * Ensures the seat-scoped backend has the synthetic Command EVE local provider.
 *
 * The operation is deliberately independent from the one-shot migration latch:
 * every backend start (including a seat respawn) can call it. A failed GET never
 * becomes an empty list, so an unknown backend state cannot trigger a blind POST.
 * Successful create/conflict paths are read back before reporting readiness.
 */
export async function ensureCommandEveLocalRuntimeProvider(
  options: CommandEveLocalProviderBootstrapOptions = {}
): Promise<CommandEveLocalProviderBootstrapResult> {
  if ((options.shellEnabled ?? COMMAND_EVE_SHELL_ENABLED) !== true) {
    return { status: 'disabled', attempts: 0, created: false, conflict: false };
  }

  const maxAttempts = normalizePositiveInteger(options.maxAttempts, DEFAULT_MAX_ATTEMPTS);
  const retryDelayMs = Math.max(0, options.retryDelayMs ?? DEFAULT_RETRY_DELAY_MS);
  const requestTimeoutMs = normalizePositiveInteger(options.requestTimeoutMs, DEFAULT_REQUEST_TIMEOUT_MS);
  const wait = options.sleep ?? sleep;
  let lastError: unknown;

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      const existing = await readLocalRuntimeProvider(requestTimeoutMs);
      if (existing) {
        return { status: 'ready', attempts: attempt, created: false, conflict: false, provider: existing };
      }

      let conflict = false;
      try {
        await httpRequest<IProvider>('POST', '/api/providers', localRuntimeCreateRequest(), {
          timeoutMs: requestTimeoutMs,
          silentStatuses: [409],
        });
      } catch (error) {
        if (!isProviderAlreadyExistsError(error)) {
          throw error;
        }
        conflict = true;
      }

      const persisted = await readLocalRuntimeProvider(requestTimeoutMs);
      if (!persisted) {
        throw new Error('Command EVE local runtime provider create completed without a persisted readback row.');
      }

      console.info(
        conflict
          ? '[CommandEVE] Local runtime provider already existed after a concurrent seed (readback verified).'
          : '[CommandEVE] Local runtime provider seeded (readback verified).'
      );
      return {
        status: 'ready',
        attempts: attempt,
        created: !conflict,
        conflict,
        provider: persisted,
      };
    } catch (error) {
      lastError = error;
      if (attempt < maxAttempts) {
        await wait(retryDelayMs * attempt);
      }
    }
  }

  const failure = new Error(
    `Command EVE local runtime provider is not ready after ${maxAttempts} bounded attempt${maxAttempts === 1 ? '' : 's'}.`
  );
  (failure as Error & { cause?: unknown }).cause = lastError;
  throw failure;
}

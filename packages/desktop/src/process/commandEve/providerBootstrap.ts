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
import type { CreateProviderRequest, UpdateProviderRequest } from '@/common/types/provider/providerApi';
import { ensureCommandEveShimAuthToken, getCommandEveOllamaOpenAiShimBaseUrl } from './ollamaOpenAiShim';

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
  shimOpenAiBaseUrl?: string;
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

function normalizeShimOpenAiBaseUrl(candidate: string): string {
  const parsed = new URL(candidate);
  const port = Number(parsed.port);
  if (
    parsed.protocol !== 'http:' ||
    parsed.hostname !== '127.0.0.1' ||
    !Number.isInteger(port) ||
    port < 1 ||
    port > 65_535 ||
    parsed.pathname.replace(/\/+$/, '') !== '/v1' ||
    parsed.username ||
    parsed.password ||
    parsed.search ||
    parsed.hash
  ) {
    throw new Error('Command EVE local runtime provider requires an exact 127.0.0.1 OpenAI /v1 shim URL.');
  }
  return `http://127.0.0.1:${port}/v1`;
}

function localRuntimeCreateRequest(shimOpenAiBaseUrl?: string): CreateProviderRequest {
  const { use_model, ...provider } = getCommandEveLocalRuntimeProvider();
  return {
    ...provider,
    // In normal builds this is :25811. Explicit E2E/multi-instance launches
    // bind an ephemeral port; persisting the fixed port would address a foreign
    // app's shim and correctly fail its nonce check with 401.
    base_url: normalizeShimOpenAiBaseUrl(shimOpenAiBaseUrl ?? getCommandEveOllamaOpenAiShimBaseUrl()),
    // AionCore resolves credentials from the provider DB, not from the
    // renderer's conversation payload. Persist the same process-local nonce
    // enforced by the loopback shim; the static common-config value is only a
    // non-secret renderer placeholder.
    api_key: ensureCommandEveShimAuthToken(),
    models: [use_model],
    enabled: true,
    is_full_url: false,
  };
}

async function readLocalRuntimeProvider(requestTimeoutMs: number): Promise<IProvider | undefined> {
  const providers =
    (await httpRequest<IProvider[]>('GET', '/api/providers', undefined, { timeoutMs: requestTimeoutMs })) || [];
  return providers.find((provider) => provider.id === COMMAND_EVE_LOCAL_RUNTIME_PROVIDER_ID);
}

/**
 * Security-owned fields for the app-managed provider row.
 *
 * The boot nonce must never be paired with an operator-edited remote URL: that
 * would turn the next inference request into a credential disclosure. Models,
 * labels, capabilities and other non-security fields remain untouched.
 */
function localRuntimeSecurityPatch(
  existing: IProvider,
  desired: CreateProviderRequest
): UpdateProviderRequest | undefined {
  const patch: UpdateProviderRequest = {};
  if (existing.platform !== desired.platform) patch.platform = desired.platform;
  if (existing.base_url !== desired.base_url) patch.base_url = desired.base_url;
  if (existing.api_key !== desired.api_key) patch.api_key = desired.api_key;
  if (existing.enabled !== true) patch.enabled = true;
  if (existing.is_full_url === true) patch.is_full_url = false;
  return Object.keys(patch).length > 0 ? patch : undefined;
}

async function reconcileLocalRuntimeProvider(
  existing: IProvider,
  desired: CreateProviderRequest,
  requestTimeoutMs: number
): Promise<IProvider> {
  const patch = localRuntimeSecurityPatch(existing, desired);
  if (!patch) return existing;

  await httpRequest<IProvider>(
    'PUT',
    `/api/providers/${encodeURIComponent(COMMAND_EVE_LOCAL_RUNTIME_PROVIDER_ID)}`,
    patch,
    { timeoutMs: requestTimeoutMs }
  );

  const persisted = await readLocalRuntimeProvider(requestTimeoutMs);
  if (!persisted) {
    throw new Error('Command EVE local runtime provider reconcile completed without a persisted readback row.');
  }
  if (localRuntimeSecurityPatch(persisted, desired)) {
    throw new Error('Command EVE local runtime provider reconcile readback did not match its security contract.');
  }

  console.info('[CommandEVE] Local runtime provider security fields reconciled (readback verified).');
  return persisted;
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
      const desired = localRuntimeCreateRequest(options.shimOpenAiBaseUrl);
      const existing = await readLocalRuntimeProvider(requestTimeoutMs);
      if (existing) {
        const provider = await reconcileLocalRuntimeProvider(existing, desired, requestTimeoutMs);
        return { status: 'ready', attempts: attempt, created: false, conflict: false, provider };
      }

      let conflict = false;
      try {
        await httpRequest<IProvider>('POST', '/api/providers', desired, {
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
      const provider = await reconcileLocalRuntimeProvider(persisted, desired, requestTimeoutMs);

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
        provider,
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

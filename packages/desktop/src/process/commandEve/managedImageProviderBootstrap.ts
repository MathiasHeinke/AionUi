/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import { httpRequest, isBackendHttpError } from '@/common/adapter/httpBridge';
import {
  COMMAND_EVE_MANAGED_IMAGE_PROVIDER_ID,
  getCommandEveManagedImageProvider,
} from '@/common/config/eveManagedImageGenerationCore';
import type { IProvider } from '@/common/config/storage';
import type { CreateProviderRequest, UpdateProviderRequest } from '@/common/types/provider/providerApi';
import { ensureCommandEveShimAuthToken, getCommandEveOllamaOpenAiShimBaseUrl } from './ollamaOpenAiShim';

const MAX_ATTEMPTS = 3;
const REQUEST_TIMEOUT_MS = 2_500;

export type CommandEveManagedImageProviderBootstrapResult = {
  status: 'ready';
  attempts: number;
  created: boolean;
  conflict: boolean;
  provider: IProvider;
};

function normalizeShimBaseUrl(value: string): string {
  const parsed = new URL(value);
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
    throw new Error('Managed image provider requires an exact 127.0.0.1 OpenAI /v1 shim URL.');
  }
  return `http://127.0.0.1:${port}/v1`;
}

function desiredProvider(shimBaseUrl?: string): CreateProviderRequest {
  const { use_model, ...provider } = getCommandEveManagedImageProvider();
  return {
    ...provider,
    base_url: normalizeShimBaseUrl(shimBaseUrl ?? getCommandEveOllamaOpenAiShimBaseUrl()),
    api_key: ensureCommandEveShimAuthToken(),
    models: [use_model],
    enabled: true,
    is_full_url: false,
  };
}

async function readProvider(): Promise<IProvider | undefined> {
  const providers =
    (await httpRequest<IProvider[]>('GET', '/api/providers', undefined, { timeoutMs: REQUEST_TIMEOUT_MS })) || [];
  return providers.find((provider) => provider.id === COMMAND_EVE_MANAGED_IMAGE_PROVIDER_ID);
}

function stringArraysEqual(left: string[] | undefined, right: string[] | undefined): boolean {
  const a = left || [];
  const b = right || [];
  return a.length === b.length && a.every((value, index) => value === b[index]);
}

function managedPatch(existing: IProvider, desired: CreateProviderRequest): UpdateProviderRequest | undefined {
  const patch: UpdateProviderRequest = {};
  if (existing.name !== desired.name) patch.name = desired.name;
  if (existing.platform !== desired.platform) patch.platform = desired.platform;
  if (existing.base_url !== desired.base_url) patch.base_url = desired.base_url;
  if (existing.api_key !== desired.api_key) patch.api_key = desired.api_key;
  if (!stringArraysEqual(existing.models, desired.models)) patch.models = desired.models;
  if (existing.enabled !== true) patch.enabled = true;
  if (existing.is_full_url === true) patch.is_full_url = false;
  return Object.keys(patch).length > 0 ? patch : undefined;
}

async function reconcile(existing: IProvider, desired: CreateProviderRequest): Promise<IProvider> {
  const patch = managedPatch(existing, desired);
  if (patch) {
    await httpRequest<IProvider>(
      'PUT',
      `/api/providers/${encodeURIComponent(COMMAND_EVE_MANAGED_IMAGE_PROVIDER_ID)}`,
      patch,
      { timeoutMs: REQUEST_TIMEOUT_MS }
    );
  }
  const persisted = await readProvider();
  if (!persisted || managedPatch(persisted, desired)) {
    throw new Error('Managed image provider readback did not match its loopback-only contract.');
  }
  return persisted;
}

function isConflict(error: unknown): boolean {
  return isBackendHttpError(error) && error.status === 409;
}

export async function ensureCommandEveManagedImageProvider(
  options: {
    shimOpenAiBaseUrl?: string;
    sleep?: (delayMs: number) => Promise<void>;
  } = {}
): Promise<CommandEveManagedImageProviderBootstrapResult> {
  const sleep = options.sleep ?? ((delayMs: number) => new Promise<void>((resolve) => setTimeout(resolve, delayMs)));
  let lastError: unknown;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
    try {
      const desired = desiredProvider(options.shimOpenAiBaseUrl);
      const existing = await readProvider();
      if (existing) {
        return {
          status: 'ready',
          attempts: attempt,
          created: false,
          conflict: false,
          provider: await reconcile(existing, desired),
        };
      }
      let conflict = false;
      try {
        await httpRequest<IProvider>('POST', '/api/providers', desired, {
          timeoutMs: REQUEST_TIMEOUT_MS,
          silentStatuses: [409],
        });
      } catch (error) {
        if (!isConflict(error)) throw error;
        conflict = true;
      }
      const persisted = await readProvider();
      if (!persisted) throw new Error('Managed image provider create completed without readback.');
      return {
        status: 'ready',
        attempts: attempt,
        created: !conflict,
        conflict,
        provider: await reconcile(persisted, desired),
      };
    } catch (error) {
      lastError = error;
      if (attempt < MAX_ATTEMPTS) await sleep(150 * attempt);
    }
  }
  const failure = new Error('Managed image provider is not ready after three bounded attempts.');
  (failure as Error & { cause?: unknown }).cause = lastError;
  throw failure;
}

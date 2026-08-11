/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import { decryptSecret } from '@/common/config/keychain';
import { resolveSeatHome } from '@process/commandEve/seatContextCore';
import type { SecretMaterialResolveContext, SecretMaterialResolver } from './secretUseBroker';

export type HermesSecretSourceProvider = 'onepassword' | 'bitwarden' | 'command';

export interface HermesSecretSourceReadRequest {
  provider: HermesSecretSourceProvider;
  alias: string;
  hermesHome: string;
  accountId: string;
  seedId: string;
}

/**
 * Implemented by the already-running Hermes/AionCore profile boundary. The
 * port returns a value that SecretSource has already hydrated for that exact
 * profile; this module deliberately does not reimplement `op`, `bws`, config
 * precedence, bootstrap tokens or caches.
 */
export interface HermesSecretSourceReadPort {
  read(request: HermesSecretSourceReadRequest): Promise<Uint8Array | null>;
}

let mainHermesPort: HermesSecretSourceReadPort | null = null;

/** Main-process registration only. There is no renderer-facing setter. */
export function registerHermesSecretSourceReadPort(port: HermesSecretSourceReadPort | null): void {
  mainHermesPort = port;
}

function parseHermesSourceRef(
  source: SecretMaterialResolveContext['source'],
  sourceRef: string
): { provider: HermesSecretSourceProvider; alias: string } | null {
  if (source === 'eve_keychain') return null;
  const provider = source.slice('hermes_'.length) as HermesSecretSourceProvider;
  const prefix = `secret-source:v1:${provider}:`;
  if (!sourceRef.startsWith(prefix)) return null;
  const alias = sourceRef.slice(prefix.length);
  if (!/^[A-Za-z0-9][A-Za-z0-9:_/-]{0,127}$/.test(alias)) return null;
  return { provider, alias };
}

/**
 * Native resolver used by the one-use broker. It either decrypts an AionUI
 * safeStorage ref locally or delegates an opaque alias to the existing Hermes
 * profile port. It never accepts plaintext and never invokes a vault CLI on
 * its own.
 */
export class NativeSecretMaterialResolver implements SecretMaterialResolver {
  constructor(
    private readonly userDataPath: string,
    private readonly hermesPort: () => HermesSecretSourceReadPort | null = () => mainHermesPort
  ) {}

  async resolve(context: SecretMaterialResolveContext): Promise<Uint8Array> {
    if (context.source === 'eve_keychain') {
      const decrypted = decryptSecret(context.sourceRef);
      if (!decrypted.ok || typeof decrypted.value !== 'string' || decrypted.value.length === 0) {
        throw new Error('EXTERNAL_KEYCHAIN_RESOLVE_FAILED');
      }
      return new TextEncoder().encode(decrypted.value);
    }

    if (context.handleType !== 'service_credential' && context.handleType !== 'oauth_token') {
      throw new Error('EXTERNAL_HERMES_SOURCE_TYPE_BLOCKED');
    }
    const parsed = parseHermesSourceRef(context.source, context.sourceRef);
    const port = this.hermesPort();
    if (!parsed || !port) throw new Error('EXTERNAL_HERMES_SOURCE_UNAVAILABLE');
    const hermesHome = resolveSeatHome(this.userDataPath, context.ownerBinding.seedId).hermesHome;
    const value = await port.read({
      provider: parsed.provider,
      alias: parsed.alias,
      hermesHome,
      accountId: context.ownerBinding.accountId,
      seedId: context.ownerBinding.seedId,
    });
    if (!(value instanceof Uint8Array) || value.byteLength === 0) {
      throw new Error('EXTERNAL_HERMES_SOURCE_RESOLVE_FAILED');
    }
    return value;
  }
}

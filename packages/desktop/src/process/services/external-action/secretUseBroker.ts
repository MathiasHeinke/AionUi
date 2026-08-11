/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import { normalizeEveExternalDomain, type EveExternalActionBinding } from '@/common/config/eveExternalActionPolicyCore';
import type { ExternalActionStore } from './externalActionStore';

export interface SecretMaterialResolver {
  resolve(source: 'eve_keychain' | 'hermes_secret_source', sourceRef: string): Promise<Uint8Array>;
}

export interface SecretMaterialInjector {
  inject(material: Uint8Array): Promise<void>;
}

export interface ExternalSecretUseRequest {
  binding: EveExternalActionBinding;
  reservationId: string;
  claimId: string;
  handleId: string;
  actionKind:
    | 'account_create'
    | 'software_install'
    | 'purchase'
    | 'recurring_payment'
    | 'browser_submit'
    | 'desktop_action'
    | 'artifact_modify'
    | 'communication_send';
  domain?: string;
}

export type ExternalSecretUseResult =
  | {
      ok: true;
      status: 'injected';
      handleId: string;
      reservationId: string;
      claimId: string;
    }
  | {
      ok: false;
      status: 'blocked' | 'unknown';
      reasonCode: string;
      reservationId: string;
    };

const BROKER_UNKNOWN_DIGEST = 'sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc';
const BROKER_REVERSED_DIGEST = 'sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';

/**
 * Main-only one-use broker. Secret bytes exist only between resolver and the
 * trusted injector callback, are never returned, and are overwritten in a
 * finally block. Errors are deliberately reduced to fixed reason codes so an
 * adapter exception cannot echo secret material into logs or renderer state.
 */
export class ExternalSecretUseBroker {
  constructor(private readonly store: ExternalActionStore) {}

  async use(
    request: ExternalSecretUseRequest,
    resolver: SecretMaterialResolver,
    injector: SecretMaterialInjector
  ): Promise<ExternalSecretUseResult> {
    const reservation = this.store.getReservation(request.binding, request.reservationId);
    if (!reservation || reservation.state !== 'claimed' || reservation.claimId !== request.claimId) {
      return {
        ok: false,
        status: 'blocked',
        reasonCode: 'EXTERNAL_SECRET_USE_CLAIM_INVALID',
        reservationId: request.reservationId,
      };
    }
    const handle = this.store.getSecretHandle(request.binding, request.handleId);
    if (!handle || handle.revokedAt || Date.parse(handle.expiresAt) <= Date.now()) {
      return {
        ok: false,
        status: 'blocked',
        reasonCode: 'EXTERNAL_SECRET_HANDLE_NOT_ACTIVE',
        reservationId: request.reservationId,
      };
    }
    if (!handle.actionKinds.includes(request.actionKind)) {
      return {
        ok: false,
        status: 'blocked',
        reasonCode: 'EXTERNAL_SECRET_HANDLE_SCOPE_BLOCKED',
        reservationId: request.reservationId,
      };
    }
    if (request.domain) {
      const domain = normalizeEveExternalDomain(request.domain);
      if (!domain || !handle.domains.includes(domain)) {
        return {
          ok: false,
          status: 'blocked',
          reasonCode: 'EXTERNAL_SECRET_HANDLE_DOMAIN_BLOCKED',
          reservationId: request.reservationId,
        };
      }
    }

    const consumed = this.store.consumeSecretUsePermit(request.binding, request.reservationId, request.claimId);
    if ('reasonCode' in consumed) {
      return {
        ok: false,
        status: 'blocked',
        reasonCode: consumed.reasonCode,
        reservationId: request.reservationId,
      };
    }

    let material: Uint8Array | undefined;
    try {
      material = await resolver.resolve(handle.source, handle.sourceRef);
      if (!(material instanceof Uint8Array) || material.byteLength === 0) {
        this.store.reverse({
          binding: request.binding,
          reservationId: request.reservationId,
          claimId: request.claimId,
          outcomeDigest: BROKER_REVERSED_DIGEST,
        });
        return {
          ok: false,
          status: 'blocked',
          reasonCode: 'EXTERNAL_SECRET_RESOLVE_FAILED',
          reservationId: request.reservationId,
        };
      }
    } catch {
      this.store.reverse({
        binding: request.binding,
        reservationId: request.reservationId,
        claimId: request.claimId,
        outcomeDigest: BROKER_REVERSED_DIGEST,
      });
      return {
        ok: false,
        status: 'blocked',
        reasonCode: 'EXTERNAL_SECRET_RESOLVE_FAILED',
        reservationId: request.reservationId,
      };
    }

    try {
      await injector.inject(material);
      return {
        ok: true,
        status: 'injected',
        handleId: request.handleId,
        reservationId: request.reservationId,
        claimId: request.claimId,
      };
    } catch {
      this.store.markUnknown({
        binding: request.binding,
        reservationId: request.reservationId,
        claimId: request.claimId,
        outcomeDigest: BROKER_UNKNOWN_DIGEST,
      });
      return {
        ok: false,
        status: 'unknown',
        reasonCode: 'EXTERNAL_SECRET_INJECTION_UNKNOWN',
        reservationId: request.reservationId,
      };
    } finally {
      material.fill(0);
    }
  }
}

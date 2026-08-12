/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import type {
  EveExternalActionBinding,
  EveExternalActionKind,
  EveSecretHandleSource,
  EveSecretHandleType,
  EveSecretFieldSlot,
} from '@/common/config/eveExternalActionPolicyCore';
import type { ExternalActionExecutionContractExpectation, ExternalActionStore } from './externalActionStore';
import { externalActionTerminalReason } from './externalActionStore';

export interface SecretMaterialResolveContext {
  source: EveSecretHandleSource;
  sourceRef: string;
  handleType: EveSecretHandleType;
  ownerBinding: EveExternalActionBinding;
  useBinding: EveExternalActionBinding;
  actionKind: EveExternalActionKind;
  targetOrigin: string;
  slot: EveSecretFieldSlot;
  reservationId: string;
  claimId: string;
  executionContractDigest: string;
  adapterId: string;
  authMode: ExternalActionExecutionContractExpectation['authMode'];
  domain: ExternalActionExecutionContractExpectation['domain'];
  domainAction: string;
  origins: readonly string[];
}

export interface SecretMaterialResolver {
  resolve(context: SecretMaterialResolveContext): Promise<Uint8Array>;
}

export interface SecretMaterialInjector {
  preflight?(): Promise<{ ok: true } | { ok: false; reasonCode: string }>;
  inject(material: Uint8Array): Promise<void>;
}

export interface ExternalSecretUseRequest {
  binding: EveExternalActionBinding;
  reservationId: string;
  claimId: string;
  slot: EveSecretFieldSlot;
  executionContract: ExternalActionExecutionContractExpectation;
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
const FIXED_REASON_RE = /^[A-Z][A-Z0-9_]{0,95}$/;

function fixedReason(reasonCode: unknown, fallback: string): string {
  return typeof reasonCode === 'string' && FIXED_REASON_RE.test(reasonCode) ? reasonCode : fallback;
}

/**
 * Main-only one-use broker. Secret bytes exist only between resolver and the
 * trusted injector callback, are never returned, and are overwritten in a
 * finally block. Errors are deliberately reduced to fixed reason codes so an
 * adapter exception cannot echo secret material into logs or renderer state.
 */
export class ExternalSecretUseBroker {
  constructor(
    private readonly store: ExternalActionStore,
    private readonly now: () => Date = () => new Date()
  ) {}

  async use(
    request: ExternalSecretUseRequest,
    resolver: SecretMaterialResolver,
    injector: SecretMaterialInjector
  ): Promise<ExternalSecretUseResult> {
    const consumed = this.store.consumeSecretUsePermit(
      request.binding,
      request.reservationId,
      request.claimId,
      request.slot,
      request.executionContract
    );
    if ('reasonCode' in consumed) {
      const replayUnsafe = consumed.reasonCode === 'EXTERNAL_SECRET_USE_REPLAY_BLOCKED';
      const transition = replayUnsafe
        ? this.store.markUnknown({
            binding: request.binding,
            reservationId: request.reservationId,
            claimId: request.claimId,
            authMode: request.executionContract.authMode,
            reasonCode: 'UNKNOWN_EXTERNAL_EFFECT',
            outcomeDigest: BROKER_UNKNOWN_DIGEST,
          })
        : this.store.reverse({
          binding: request.binding,
          reservationId: request.reservationId,
          claimId: request.claimId,
          authMode: request.executionContract.authMode,
          terminalState: 'denied',
          reasonCode: externalActionTerminalReason(consumed.reasonCode),
          outcomeDigest: BROKER_REVERSED_DIGEST,
        });
      const unknown = replayUnsafe || transition.state === 'unknown' || transition.state === 'resuming';
      return {
        ok: false,
        status: unknown ? 'unknown' : 'blocked',
        reasonCode: consumed.reasonCode,
        reservationId: request.reservationId,
      };
    }
    const handle = consumed.handle;
    if (handle.revokedAt || Date.parse(handle.expiresAt) <= this.now().getTime()) {
      this.store.reverse({
        binding: request.binding,
        reservationId: request.reservationId,
        claimId: request.claimId,
        authMode: request.executionContract.authMode,
        terminalState: 'denied',
        reasonCode: externalActionTerminalReason('EXTERNAL_SECRET_HANDLE_NOT_ACTIVE'),
        outcomeDigest: BROKER_REVERSED_DIGEST,
      });
      return {
        ok: false,
        status: 'blocked',
        reasonCode: 'EXTERNAL_SECRET_HANDLE_NOT_ACTIVE',
        reservationId: request.reservationId,
      };
    }

    let material: Uint8Array | undefined;
    try {
      material = await resolver.resolve({
        source: handle.source,
        sourceRef: handle.sourceRef,
        handleType: handle.type,
        ownerBinding: handle.binding,
        useBinding: request.binding,
        actionKind: request.executionContract.actionKind,
        targetOrigin: request.executionContract.targetOrigin,
        slot: request.slot,
        reservationId: request.reservationId,
        claimId: request.claimId,
        executionContractDigest: request.executionContract.executionContractDigest,
        adapterId: request.executionContract.adapterId,
        authMode: request.executionContract.authMode,
        domain: request.executionContract.domain,
        domainAction: request.executionContract.domainAction,
        origins:
          request.executionContract.domain === 'commerce'
            ? [request.executionContract.merchantOrigin!, request.executionContract.checkoutOrigin!]
            : [request.executionContract.providerOrigin!],
      });
      if (!(material instanceof Uint8Array) || material.byteLength === 0) {
        this.store.reverse({
          binding: request.binding,
          reservationId: request.reservationId,
          claimId: request.claimId,
          authMode: request.executionContract.authMode,
          terminalState: 'denied',
          reasonCode: externalActionTerminalReason('EXTERNAL_SECRET_RESOLVE_FAILED'),
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
        authMode: request.executionContract.authMode,
        terminalState: 'denied',
        reasonCode: externalActionTerminalReason('EXTERNAL_SECRET_RESOLVE_FAILED'),
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
      const recheckedBeforeAuthority = this.store.recheckSecretUseForInjection(
        request.binding,
        request.reservationId,
        request.claimId,
        request.slot,
        request.executionContract,
        handle
      );
      if ('reasonCode' in recheckedBeforeAuthority) {
        this.store.reverse({
          binding: request.binding,
          reservationId: request.reservationId,
          claimId: request.claimId,
          authMode: request.executionContract.authMode,
          terminalState: 'denied',
          reasonCode: externalActionTerminalReason(recheckedBeforeAuthority.reasonCode),
          outcomeDigest: BROKER_REVERSED_DIGEST,
        });
        return {
          ok: false,
          status: 'blocked',
          reasonCode: recheckedBeforeAuthority.reasonCode,
          reservationId: request.reservationId,
        };
      }
      if (injector.preflight) {
        let trustedPreflight: { ok: true } | { ok: false; reasonCode: string };
        try {
          trustedPreflight = await injector.preflight();
        } catch {
          trustedPreflight = { ok: false, reasonCode: 'EXTERNAL_TRUSTED_PREFLIGHT_UNAVAILABLE' };
        }
        if ('reasonCode' in trustedPreflight) {
          this.store.reverse({
            binding: request.binding,
            reservationId: request.reservationId,
            claimId: request.claimId,
            authMode: request.executionContract.authMode,
            terminalState: 'denied',
            reasonCode: externalActionTerminalReason(
              fixedReason(trustedPreflight.reasonCode, 'EXTERNAL_TRUSTED_PREFLIGHT_BLOCKED')
            ),
            outcomeDigest: BROKER_REVERSED_DIGEST,
          });
          return {
            ok: false,
            status: 'blocked',
            reasonCode: fixedReason(trustedPreflight.reasonCode, 'EXTERNAL_TRUSTED_PREFLIGHT_BLOCKED'),
            reservationId: request.reservationId,
          };
        }
      }
      const recheckedAfterAuthority = this.store.recheckSecretUseForInjection(
        request.binding,
        request.reservationId,
        request.claimId,
        request.slot,
        request.executionContract,
        handle
      );
      if ('reasonCode' in recheckedAfterAuthority) {
        this.store.reverse({
          binding: request.binding,
          reservationId: request.reservationId,
          claimId: request.claimId,
          authMode: request.executionContract.authMode,
          terminalState: 'denied',
          reasonCode: externalActionTerminalReason(recheckedAfterAuthority.reasonCode),
          outcomeDigest: BROKER_REVERSED_DIGEST,
        });
        return {
          ok: false,
          status: 'blocked',
          reasonCode: recheckedAfterAuthority.reasonCode,
          reservationId: request.reservationId,
        };
      }
      await injector.inject(material);
      return {
        ok: true,
        status: 'injected',
        handleId: handle.handleId,
        reservationId: request.reservationId,
        claimId: request.claimId,
      };
    } catch {
      this.store.markUnknown({
        binding: request.binding,
        reservationId: request.reservationId,
        claimId: request.claimId,
        authMode: request.executionContract.authMode,
        reasonCode: 'UNKNOWN_EXTERNAL_EFFECT',
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

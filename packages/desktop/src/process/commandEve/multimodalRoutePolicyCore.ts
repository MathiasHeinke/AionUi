/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Command EVE multimodal route policy (1.7.8 SG-13).
 *
 * The provider contract lives in common/config/eveMultimodalGatewayCore. This
 * process-side core translates that contract into a visible artifact-first
 * decision and keeps the MoA/Codex experiments explicit spikes instead of
 * hidden auto-enable paths.
 */

import {
  resolveCommandEveMultimodalGate,
  type CommandEveMultimodalArtifactKind,
  type CommandEveMultimodalCapability,
  type CommandEveMultimodalContract,
  type CommandEveMultimodalProvider,
  type CommandEvePrivacyLane,
} from '@/common/config/eveMultimodalGatewayCore';
import {
  buildFailureArtifact,
  type GeneratedArtifactPayload,
  type GeneratedArtifactType,
} from './artifactContractCore';
import {
  decideRuntimeGate,
  type CapabilityState,
  type RuntimeGateHumanGate,
  type RuntimeGatePrivacyMode,
  type SensitivityClass,
} from './runtimeGateCore';
import { decidePrivacyRoute, type PrivacyLaneConfig, type PrivacyLaneId } from './privacyLaneConfigCore';

export type CommandEveMultimodalSmokeStatus = 'pass' | 'fail' | 'not_run';

export type CommandEveMultimodalRouteReasonCode =
  | 'multimodal.route-pass'
  | 'multimodal.provider-blocked'
  | 'multimodal.privacy-lane-blocked'
  | 'multimodal.runtime-blocked';

export type CommandEveMultimodalRouteArtifactContract = {
  artifactType: GeneratedArtifactType;
  artifactKind: CommandEveMultimodalArtifactKind;
  title: string;
};

export type CommandEveMultimodalRouteReceipt = {
  requestId: string;
  provider: CommandEveMultimodalProvider;
  model: string;
  capability: CommandEveMultimodalCapability;
  functionUrl: string;
  execution: CommandEveMultimodalContract['execution'];
  requiresPoll: boolean;
  requiresEphemeralClientToken: boolean;
  residencyLane: CommandEveMultimodalContract['residencyLane'];
  residencyConfirmation: 'explicit-us-cloud' | 'server-must-confirm-us-cloud';
  directProviderKeyPresentInDesktop: false;
};

export type CommandEveMultimodalRouteDecision =
  | {
      ok: true;
      reasonCode: 'multimodal.route-pass';
      humanGate: 'HG-0';
      artifactContract: CommandEveMultimodalRouteArtifactContract;
      pendingArtifact: GeneratedArtifactPayload;
      receipt: CommandEveMultimodalRouteReceipt;
    }
  | {
      ok: false;
      reasonCode: Exclude<CommandEveMultimodalRouteReasonCode, 'multimodal.route-pass'>;
      providerReasonCode: string;
      humanGate: RuntimeGateHumanGate;
      failureArtifact: GeneratedArtifactPayload;
    };

export type CommandEveMultimodalRouteInput = {
  requestId: string;
  provider: CommandEveMultimodalProvider;
  capability: CommandEveMultimodalCapability;
  privacyLane: CommandEvePrivacyLane;
  hasServerGateway: boolean;
  hasLicense: boolean;
  directProviderKeyPresentInDesktop: boolean;
  providerSmoke: CommandEveMultimodalSmokeStatus;
  dataClass: SensitivityClass;
  userConsent: boolean;
  privacyConfig?: PrivacyLaneConfig;
};

export type CommandEveSpikeDecision =
  | {
      ok: true;
      reasonCode: 'spike.pass';
      humanGate: 'HG-0';
    }
  | {
      ok: false;
      reasonCode:
        | 'spike.deferred'
        | 'spike.needs-approval'
        | 'spike.needs-smoke'
        | 'spike.missing-acp-tool'
        | 'spike.provider-rewrite-required';
      humanGate: RuntimeGateHumanGate;
      blockedBy: string;
    };

export function commandEveArtifactTypeForMultimodalKind(kind: CommandEveMultimodalArtifactKind): GeneratedArtifactType {
  if (kind === 'text') return 'report';
  return kind;
}

function privacyModeForMultimodalLane(lane: CommandEvePrivacyLane): RuntimeGatePrivacyMode {
  if (lane === 'local_only') return 'local_only';
  if (lane === 'cloud_eu' || lane === 'cloud_de') return 'privacy_first';
  return 'cloud_balanced';
}

function smokeStateForProvider(status: CommandEveMultimodalSmokeStatus): CapabilityState {
  if (status === 'pass') return 'active';
  if (status === 'fail') return 'smoke_failed';
  return 'deferred';
}

export function privacyLaneIdForMultimodalCapability(
  capability: CommandEveMultimodalCapability
): Extract<PrivacyLaneId, 'vision_cloud' | 'image_cloud' | 'video_cloud' | 'tts_cloud' | 'stt_cloud'> {
  switch (capability) {
    case 'vision':
      return 'vision_cloud';
    case 'image_generation':
      return 'image_cloud';
    case 'video_generation':
      return 'video_cloud';
    case 'tts':
    case 'realtime_voice':
      return 'tts_cloud';
    case 'stt':
      return 'stt_cloud';
  }
}

function titleForCapability(capability: CommandEveMultimodalCapability): string {
  switch (capability) {
    case 'vision':
      return 'Vision result';
    case 'image_generation':
      return 'Generated image';
    case 'video_generation':
      return 'Generated video';
    case 'tts':
      return 'Generated audio';
    case 'stt':
      return 'Speech transcript';
    case 'realtime_voice':
      return 'Realtime voice session';
  }
}

function buildBlockedMultimodalArtifact(input: {
  requestId: string;
  title: string;
  error: string;
  dataClass: SensitivityClass;
  humanGate: RuntimeGateHumanGate;
  provider?: CommandEveMultimodalProvider;
  model?: string;
  blocked?: boolean;
}): GeneratedArtifactPayload {
  return buildFailureArtifact({
    requestId: input.requestId,
    title: input.title,
    description: 'Command EVE could not create a visible multimodal artifact for this request.',
    error: input.error,
    dataClass: input.dataClass,
    humanGate: input.humanGate,
    route: input.provider === 'xai' ? 'xai' : 'unknown',
    provider: input.provider,
    model: input.model,
    blocked: input.blocked ?? true,
  });
}

function humanGateForProviderBlock(reason: string): RuntimeGateHumanGate {
  if (reason === 'direct-provider-key-in-desktop') return 'HG-4';
  if (reason === 'missing-server-gateway' || reason === 'missing-license') return 'HG-2.5';
  return 'HG-2';
}

function pendingArtifactForContract(input: {
  requestId: string;
  contract: CommandEveMultimodalContract;
  artifactType: GeneratedArtifactType;
  title: string;
  dataClass: SensitivityClass;
}): GeneratedArtifactPayload {
  return {
    artifactType: input.artifactType,
    title: input.title,
    description:
      input.contract.execution === 'async_poll'
        ? 'The provider job is running; Command EVE must poll the server-side gateway before rendering the final artifact.'
        : 'Command EVE is waiting for the server-side gateway response before rendering the final artifact.',
    receipt: {
      requestId: input.requestId,
      provider: input.contract.provider,
      model: input.contract.model,
      route: 'xai',
      costLabel: 'app-metered',
      dataClass: input.dataClass,
      humanGate: 'HG-0',
      status: 'pending',
    },
  };
}

export function decideCommandEveMultimodalRoute(
  input: CommandEveMultimodalRouteInput
): CommandEveMultimodalRouteDecision {
  const gate = resolveCommandEveMultimodalGate({
    provider: input.provider,
    capability: input.capability,
    privacyLane: input.privacyLane,
    hasServerGateway: input.hasServerGateway,
    hasLicense: input.hasLicense,
    directProviderKeyPresentInDesktop: input.directProviderKeyPresentInDesktop,
  });

  if (gate.ok === false) {
    const humanGate = humanGateForProviderBlock(gate.reason);
    return {
      ok: false,
      reasonCode: 'multimodal.provider-blocked',
      providerReasonCode: gate.reason,
      humanGate,
      failureArtifact: buildBlockedMultimodalArtifact({
        requestId: input.requestId,
        title: `${titleForCapability(input.capability)} blocked`,
        error: gate.message,
        dataClass: input.dataClass,
        humanGate,
        provider: gate.contract?.provider,
        model: gate.contract?.model,
      }),
    };
  }

  if (input.privacyConfig) {
    const privacyDecision = decidePrivacyRoute(
      input.privacyConfig,
      privacyLaneIdForMultimodalCapability(input.capability),
      input.dataClass
    );
    if (!privacyDecision.ok) {
      return {
        ok: false,
        reasonCode: 'multimodal.privacy-lane-blocked',
        providerReasonCode: privacyDecision.reasonCode,
        humanGate: privacyDecision.humanGate,
        failureArtifact: buildBlockedMultimodalArtifact({
          requestId: input.requestId,
          title: `${titleForCapability(input.capability)} blocked`,
          error: `Privacy lane blocked multimodal execution: ${privacyDecision.reasonCode}`,
          dataClass: input.dataClass,
          humanGate: privacyDecision.humanGate,
          provider: gate.contract.provider,
          model: gate.contract.model,
        }),
      };
    }
  }

  const runtimeGate = decideRuntimeGate({
    capabilityId: `multimodal:${input.provider}:${input.capability}`,
    requestedAction: 'cloud_inference',
    sensitivity: input.dataClass,
    autonomyLevel: 'L1',
    privacyMode: privacyModeForMultimodalLane(input.privacyLane),
    userConsent: input.userConsent,
    smokeState: smokeStateForProvider(input.providerSmoke),
  });

  if (!runtimeGate.ok) {
    return {
      ok: false,
      reasonCode: 'multimodal.runtime-blocked',
      providerReasonCode: runtimeGate.reasonCode,
      humanGate: runtimeGate.humanGate,
      failureArtifact: buildBlockedMultimodalArtifact({
        requestId: input.requestId,
        title: `${titleForCapability(input.capability)} unavailable`,
        error: `Runtime gate blocked multimodal execution: ${runtimeGate.reasonCode}`,
        dataClass: input.dataClass,
        humanGate: runtimeGate.humanGate,
        provider: gate.contract.provider,
        model: gate.contract.model,
      }),
    };
  }

  const artifactType = commandEveArtifactTypeForMultimodalKind(gate.contract.artifactKind);
  const title = titleForCapability(input.capability);

  return {
    ok: true,
    reasonCode: 'multimodal.route-pass',
    humanGate: 'HG-0',
    artifactContract: {
      artifactType,
      artifactKind: gate.contract.artifactKind,
      title,
    },
    pendingArtifact: pendingArtifactForContract({
      requestId: input.requestId,
      contract: gate.contract,
      artifactType,
      title,
      dataClass: input.dataClass,
    }),
    receipt: {
      requestId: input.requestId,
      provider: gate.contract.provider,
      model: gate.contract.model,
      capability: gate.contract.capability,
      functionUrl: gate.functionUrl,
      execution: gate.contract.execution,
      requiresPoll: gate.contract.execution === 'async_poll',
      requiresEphemeralClientToken: gate.contract.requiresEphemeralClientToken,
      residencyLane: gate.contract.residencyLane,
      residencyConfirmation: gate.residencyConfirmation,
      directProviderKeyPresentInDesktop: false,
    },
  };
}

export function decideMoaSpike(input: {
  userApproved: boolean;
  acpToolAvailable: boolean;
  acpSmoke: CommandEveMultimodalSmokeStatus;
}): CommandEveSpikeDecision {
  if (!input.userApproved) {
    return { ok: false, reasonCode: 'spike.needs-approval', humanGate: 'HG-2', blockedBy: 'human-approval' };
  }
  if (!input.acpToolAvailable) {
    return { ok: false, reasonCode: 'spike.missing-acp-tool', humanGate: 'HG-2', blockedBy: 'acp-tool' };
  }
  if (input.acpSmoke !== 'pass') {
    return { ok: false, reasonCode: 'spike.needs-smoke', humanGate: 'HG-1', blockedBy: 'acp-smoke' };
  }
  return { ok: true, reasonCode: 'spike.pass', humanGate: 'HG-0' };
}

export function decideCodexDelegateSpike(input: {
  userApproved: boolean;
  codexSmoke: CommandEveMultimodalSmokeStatus;
  customProviderRewriteSupported: boolean;
}): CommandEveSpikeDecision {
  if (!input.userApproved) {
    return { ok: false, reasonCode: 'spike.needs-approval', humanGate: 'HG-2', blockedBy: 'human-approval' };
  }
  if (input.codexSmoke !== 'pass') {
    return { ok: false, reasonCode: 'spike.needs-smoke', humanGate: 'HG-1', blockedBy: 'codex-smoke' };
  }
  if (!input.customProviderRewriteSupported) {
    return {
      ok: false,
      reasonCode: 'spike.provider-rewrite-required',
      humanGate: 'HG-2.5',
      blockedBy: 'custom-provider-rewrite',
    };
  }
  return { ok: true, reasonCode: 'spike.pass', humanGate: 'HG-0' };
}

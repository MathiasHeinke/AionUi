/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';

import {
  buildDefaultPrivacyLaneConfig,
  type PrivacyLaneConfig,
} from '@/process/commandEve/privacyLaneConfigCore';
import {
  commandEveArtifactTypeForMultimodalKind,
  decideCodexDelegateSpike,
  decideCommandEveMultimodalRoute,
  decideMoaSpike,
  privacyLaneIdForMultimodalCapability,
} from '@/process/commandEve/multimodalRoutePolicyCore';

describe('Command EVE multimodal route policy core', () => {
  it('routes xAI image generation only through the server gateway with a pending visible artifact contract', () => {
    const decision = decideCommandEveMultimodalRoute({
      requestId: 'mm-image-1',
      provider: 'xai',
      capability: 'image_generation',
      privacyLane: 'cloud_us',
      hasServerGateway: true,
      hasLicense: true,
      directProviderKeyPresentInDesktop: false,
      providerSmoke: 'pass',
      dataClass: 'S1-internal-low',
      userConsent: true,
    });

    expect(decision).toMatchObject({
      ok: true,
      reasonCode: 'multimodal.route-pass',
      artifactContract: {
        artifactType: 'image',
        artifactKind: 'image',
        title: 'Generated image',
      },
      pendingArtifact: {
        artifactType: 'image',
        receipt: {
          requestId: 'mm-image-1',
          provider: 'xai',
          route: 'xai',
          status: 'pending',
          humanGate: 'HG-0',
        },
      },
      receipt: {
        provider: 'xai',
        capability: 'image_generation',
        execution: 'sync',
        requiresPoll: false,
        residencyLane: 'us_cloud',
        residencyConfirmation: 'explicit-us-cloud',
        directProviderKeyPresentInDesktop: false,
      },
    });
  });

  it('keeps text outputs renderable by mapping them to report artifacts', () => {
    expect(commandEveArtifactTypeForMultimodalKind('text')).toBe('report');

    const decision = decideCommandEveMultimodalRoute({
      requestId: 'mm-vision-1',
      provider: 'xai',
      capability: 'vision',
      privacyLane: 'cloud_auto',
      hasServerGateway: true,
      hasLicense: true,
      directProviderKeyPresentInDesktop: false,
      providerSmoke: 'pass',
      dataClass: 'S1-internal-low',
      userConsent: true,
    });

    expect(decision).toMatchObject({
      ok: true,
      artifactContract: {
        artifactType: 'report',
        artifactKind: 'text',
        title: 'Vision result',
      },
      receipt: {
        residencyConfirmation: 'server-must-confirm-us-cloud',
      },
    });
  });

  it('marks video generation as async polling instead of pretending the media is ready', () => {
    const decision = decideCommandEveMultimodalRoute({
      requestId: 'mm-video-1',
      provider: 'xai',
      capability: 'video_generation',
      privacyLane: 'cloud_us',
      hasServerGateway: true,
      hasLicense: true,
      directProviderKeyPresentInDesktop: false,
      providerSmoke: 'pass',
      dataClass: 'S1-internal-low',
      userConsent: true,
    });

    expect(decision).toMatchObject({
      ok: true,
      artifactContract: { artifactType: 'video' },
      pendingArtifact: {
        artifactType: 'video',
        description: expect.stringContaining('poll'),
        receipt: { status: 'pending' },
      },
      receipt: {
        execution: 'async_poll',
        requiresPoll: true,
      },
    });
  });

  it('maps multimodal capabilities into concrete Datenschutz Hub lanes', () => {
    expect(privacyLaneIdForMultimodalCapability('vision')).toBe('vision_cloud');
    expect(privacyLaneIdForMultimodalCapability('image_generation')).toBe('image_cloud');
    expect(privacyLaneIdForMultimodalCapability('video_generation')).toBe('video_cloud');
    expect(privacyLaneIdForMultimodalCapability('tts')).toBe('tts_cloud');
    expect(privacyLaneIdForMultimodalCapability('stt')).toBe('stt_cloud');
    expect(privacyLaneIdForMultimodalCapability('realtime_voice')).toBe('tts_cloud');
  });

  it('lets the Datenschutz Hub allow a specific multimodal lane without changing the provider gate', () => {
    const privacyConfig: PrivacyLaneConfig = {
      ...buildDefaultPrivacyLaneConfig('cloud_balanced'),
      lanes: {
        ...buildDefaultPrivacyLaneConfig('cloud_balanced').lanes,
        image_cloud: 'allow',
      },
    };

    const decision = decideCommandEveMultimodalRoute({
      requestId: 'mm-image-privacy-pass',
      provider: 'xai',
      capability: 'image_generation',
      privacyLane: 'cloud_us',
      privacyConfig,
      hasServerGateway: true,
      hasLicense: true,
      directProviderKeyPresentInDesktop: false,
      providerSmoke: 'pass',
      dataClass: 'S1-internal-low',
      userConsent: true,
    });

    expect(decision).toMatchObject({
      ok: true,
      reasonCode: 'multimodal.route-pass',
      receipt: {
        provider: 'xai',
        capability: 'image_generation',
        directProviderKeyPresentInDesktop: false,
      },
    });
  });

  it('turns Datenschutz Hub ask/block states into visible failure artifacts before runtime execution', () => {
    const askDecision = decideCommandEveMultimodalRoute({
      requestId: 'mm-image-privacy-ask',
      provider: 'xai',
      capability: 'image_generation',
      privacyLane: 'cloud_us',
      privacyConfig: buildDefaultPrivacyLaneConfig('cloud_balanced'),
      hasServerGateway: true,
      hasLicense: true,
      directProviderKeyPresentInDesktop: false,
      providerSmoke: 'pass',
      dataClass: 'S1-internal-low',
      userConsent: true,
    });

    expect(askDecision).toMatchObject({
      ok: false,
      reasonCode: 'multimodal.privacy-lane-blocked',
      providerReasonCode: 'privacy.ask',
      humanGate: 'HG-2',
      failureArtifact: {
        artifactType: 'failure',
        title: 'Generated image blocked',
        receipt: {
          requestId: 'mm-image-privacy-ask',
          route: 'xai',
          status: 'blocked',
          humanGate: 'HG-2',
        },
      },
    });

    const blockDecision = decideCommandEveMultimodalRoute({
      requestId: 'mm-vision-privacy-block',
      provider: 'xai',
      capability: 'vision',
      privacyLane: 'cloud_us',
      privacyConfig: {
        ...buildDefaultPrivacyLaneConfig('cloud_balanced'),
        lanes: { vision_cloud: 'block' },
      },
      hasServerGateway: true,
      hasLicense: true,
      directProviderKeyPresentInDesktop: false,
      providerSmoke: 'pass',
      dataClass: 'S1-internal-low',
      userConsent: true,
    });

    expect(blockDecision).toMatchObject({
      ok: false,
      reasonCode: 'multimodal.privacy-lane-blocked',
      providerReasonCode: 'privacy.blocked',
      humanGate: 'HG-2',
    });
  });

  it('keeps restricted S3 data out of cloud multimodal lanes even if the hub lane is allow', () => {
    const decision = decideCommandEveMultimodalRoute({
      requestId: 'mm-vision-s3-cloud',
      provider: 'xai',
      capability: 'vision',
      privacyLane: 'cloud_us',
      privacyConfig: {
        ...buildDefaultPrivacyLaneConfig('cloud_balanced'),
        lanes: { vision_cloud: 'allow' },
      },
      hasServerGateway: true,
      hasLicense: true,
      directProviderKeyPresentInDesktop: false,
      providerSmoke: 'pass',
      dataClass: 'S3-restricted',
      userConsent: true,
    });

    expect(decision).toMatchObject({
      ok: false,
      reasonCode: 'multimodal.privacy-lane-blocked',
      providerReasonCode: 'privacy.s3-cloud-block',
      humanGate: 'HG-3',
      failureArtifact: {
        receipt: {
          status: 'blocked',
          humanGate: 'HG-3',
        },
      },
    });
  });

  it('returns a visible failure artifact when privacy blocks the cloud lane', () => {
    const decision = decideCommandEveMultimodalRoute({
      requestId: 'mm-audio-1',
      provider: 'xai',
      capability: 'tts',
      privacyLane: 'local_only',
      hasServerGateway: true,
      hasLicense: true,
      directProviderKeyPresentInDesktop: false,
      providerSmoke: 'pass',
      dataClass: 'S1-internal-low',
      userConsent: true,
    });

    expect(decision).toMatchObject({
      ok: false,
      reasonCode: 'multimodal.provider-blocked',
      providerReasonCode: 'local-only-privacy',
      humanGate: 'HG-2',
      failureArtifact: {
        artifactType: 'failure',
        title: 'Generated audio blocked',
        receipt: {
          requestId: 'mm-audio-1',
          route: 'xai',
          status: 'blocked',
          humanGate: 'HG-2',
        },
      },
    });
  });

  it('fails closed when the server gateway or license is missing', () => {
    expect(
      decideCommandEveMultimodalRoute({
        requestId: 'mm-gateway-1',
        provider: 'xai',
        capability: 'image_generation',
        privacyLane: 'cloud_us',
        hasServerGateway: false,
        hasLicense: true,
        directProviderKeyPresentInDesktop: false,
        providerSmoke: 'pass',
        dataClass: 'S1-internal-low',
        userConsent: true,
      })
    ).toMatchObject({
      ok: false,
      providerReasonCode: 'missing-server-gateway',
      humanGate: 'HG-2.5',
      failureArtifact: { receipt: { status: 'blocked' } },
    });

    expect(
      decideCommandEveMultimodalRoute({
        requestId: 'mm-license-1',
        provider: 'xai',
        capability: 'image_generation',
        privacyLane: 'cloud_us',
        hasServerGateway: true,
        hasLicense: false,
        directProviderKeyPresentInDesktop: false,
        providerSmoke: 'pass',
        dataClass: 'S1-internal-low',
        userConsent: true,
      })
    ).toMatchObject({
      ok: false,
      providerReasonCode: 'missing-license',
      humanGate: 'HG-2.5',
    });
  });

  it('keeps raw provider keys in desktop as a founder-level tripwire', () => {
    expect(
      decideCommandEveMultimodalRoute({
        requestId: 'mm-key-1',
        provider: 'xai',
        capability: 'tts',
        privacyLane: 'local_only',
        hasServerGateway: true,
        hasLicense: true,
        directProviderKeyPresentInDesktop: true,
        providerSmoke: 'pass',
        dataClass: 'S1-internal-low',
        userConsent: true,
      })
    ).toMatchObject({
      ok: false,
      providerReasonCode: 'direct-provider-key-in-desktop',
      humanGate: 'HG-4',
      failureArtifact: {
        receipt: {
          status: 'blocked',
          humanGate: 'HG-4',
        },
      },
    });
  });

  it('requires consent and provider smoke before routing cloud multimodal work', () => {
    expect(
      decideCommandEveMultimodalRoute({
        requestId: 'mm-consent-1',
        provider: 'xai',
        capability: 'stt',
        privacyLane: 'cloud_us',
        hasServerGateway: true,
        hasLicense: true,
        directProviderKeyPresentInDesktop: false,
        providerSmoke: 'pass',
        dataClass: 'S1-internal-low',
        userConsent: false,
      })
    ).toMatchObject({
      ok: false,
      reasonCode: 'multimodal.runtime-blocked',
      providerReasonCode: 'gate.needs-consent',
      humanGate: 'HG-2',
    });

    expect(
      decideCommandEveMultimodalRoute({
        requestId: 'mm-smoke-1',
        provider: 'xai',
        capability: 'stt',
        privacyLane: 'cloud_us',
        hasServerGateway: true,
        hasLicense: true,
        directProviderKeyPresentInDesktop: false,
        providerSmoke: 'not_run',
        dataClass: 'S1-internal-low',
        userConsent: true,
      })
    ).toMatchObject({
      ok: false,
      reasonCode: 'multimodal.runtime-blocked',
      providerReasonCode: 'gate.smoke-not-active',
      humanGate: 'HG-1',
    });
  });

  it('does not activate MoA unless the ACP tool is available, approved, and smoke-green', () => {
    expect(decideMoaSpike({ userApproved: false, acpToolAvailable: true, acpSmoke: 'pass' })).toMatchObject({
      ok: false,
      reasonCode: 'spike.needs-approval',
    });
    expect(decideMoaSpike({ userApproved: true, acpToolAvailable: false, acpSmoke: 'pass' })).toMatchObject({
      ok: false,
      reasonCode: 'spike.missing-acp-tool',
    });
    expect(decideMoaSpike({ userApproved: true, acpToolAvailable: true, acpSmoke: 'fail' })).toMatchObject({
      ok: false,
      reasonCode: 'spike.needs-smoke',
    });
    expect(decideMoaSpike({ userApproved: true, acpToolAvailable: true, acpSmoke: 'pass' })).toEqual({
      ok: true,
      reasonCode: 'spike.pass',
      humanGate: 'HG-0',
    });
  });

  it('keeps Codex delegation deferred until smoke and custom provider rewrite are both proven', () => {
    expect(
      decideCodexDelegateSpike({
        userApproved: true,
        codexSmoke: 'not_run',
        customProviderRewriteSupported: true,
      })
    ).toMatchObject({
      ok: false,
      reasonCode: 'spike.needs-smoke',
      blockedBy: 'codex-smoke',
    });

    expect(
      decideCodexDelegateSpike({
        userApproved: true,
        codexSmoke: 'pass',
        customProviderRewriteSupported: false,
      })
    ).toMatchObject({
      ok: false,
      reasonCode: 'spike.provider-rewrite-required',
      humanGate: 'HG-2.5',
    });

    expect(
      decideCodexDelegateSpike({
        userApproved: true,
        codexSmoke: 'pass',
        customProviderRewriteSupported: true,
      })
    ).toEqual({
      ok: true,
      reasonCode: 'spike.pass',
      humanGate: 'HG-0',
    });
  });
});

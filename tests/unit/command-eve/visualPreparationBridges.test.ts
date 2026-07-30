/*
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

const {
  inspectLocalImageMock,
  prepareImageWithVisionMock,
  inspectLocalPresentationMock,
  preparePresentationWithVisionMock,
  readLicenseWireMock,
} = vi.hoisted(() => ({
  inspectLocalImageMock: vi.fn(),
  prepareImageWithVisionMock: vi.fn(),
  inspectLocalPresentationMock: vi.fn(),
  preparePresentationWithVisionMock: vi.fn(),
  readLicenseWireMock: vi.fn(() => ({ ok: true, wire: 'CEVE.v2.synthetic.test' })),
}));

vi.mock('@/common/config/licenseWireAtRest', () => ({
  readLicenseWire: (...args: unknown[]) => readLicenseWireMock(...args),
}));

vi.mock('@process/utils/utils', () => ({
  getDataPath: () => '/tmp/command-eve-visual-bridge-tests',
}));

vi.mock('@process/commandEve/document/imageIntelligenceService', async (importOriginal) => {
  const original = await importOriginal<typeof import('@process/commandEve/document/imageIntelligenceService')>();
  return {
    ...original,
    inspectLocalImage: (...args: unknown[]) => inspectLocalImageMock(...args),
    prepareImageWithVision: (...args: unknown[]) => prepareImageWithVisionMock(...args),
  };
});

vi.mock('@process/commandEve/document/presentationIntelligenceService', async (importOriginal) => {
  const original =
    await importOriginal<typeof import('@process/commandEve/document/presentationIntelligenceService')>();
  return {
    ...original,
    inspectLocalPresentation: (...args: unknown[]) => inspectLocalPresentationMock(...args),
    preparePresentationWithVision: (...args: unknown[]) => preparePresentationWithVisionMock(...args),
  };
});

import type { CommandEveCloudVisualPolicyState } from '@/common/config/visual/cloudVisualPolicyCore';
import { handleCommandEveImagePrepare, type CommandEveImageBridgeDeps } from '@process/bridge/commandEveImageBridge';
import {
  handleCommandEvePresentationPrepare,
  type CommandEvePresentationBridgeDeps,
} from '@process/bridge/commandEvePresentationBridge';

const SEAT_ID = 'a1b2c3d4-e5f6-4789-aabb-ccddeeff0011';
const FLOW_ID = 'visual_flow_0123456789abcdef';
const RECEIPT_ID = 'r'.repeat(43);
const RECEIPT = {
  version: 'command-eve-cloud-visual-policy/v1' as const,
  receiptId: RECEIPT_ID,
  flowId: FLOW_ID,
  expiresAt: new Date(301_000).toISOString(),
};
const ENABLED_POLICY: CommandEveCloudVisualPolicyState = {
  status: 'enabled',
  reason: 'enabled_by_product_default',
  seatId: SEAT_ID,
  physicalKey: `seat:${SEAT_ID}:commandEve.cloudVisualAnalysisEnabled`,
};
const VERIFIED_RECEIPT = {
  ok: true as const,
  seatId: SEAT_ID,
  seatContextRevision: 7,
  flowId: FLOW_ID,
  expiresAtMs: 301_000,
};

function imageHarness() {
  let revision = 7;
  const fetchMock = vi.fn<typeof fetch>();
  const deps: CommandEveImageBridgeDeps = {
    getActiveSeatId: () => SEAT_ID,
    getActiveSeatContextRevision: () => revision,
    resolveSeatHome: () => ({
      seatId: SEAT_ID,
      legacy: false,
      hermesRoot: '/tmp/command-eve-visual-bridge-tests/hermes',
      hermesHome: '/tmp/command-eve-visual-bridge-tests/hermes/home',
    }),
    getDataPath: () => '/tmp/command-eve-visual-bridge-tests',
    areFileSelectionPathsGranted: () => true,
    readVisualPolicy: async () => ENABLED_POLICY,
    verifyVisualPolicyReceipt: () => VERIFIED_RECEIPT,
    fetch: fetchMock,
  };
  return {
    deps,
    fetchMock,
    bumpRevision: () => {
      revision += 1;
    },
  };
}

function presentationHarness() {
  let revision = 7;
  const fetchMock = vi.fn<typeof fetch>();
  const deps: CommandEvePresentationBridgeDeps = {
    getActiveSeatId: () => SEAT_ID,
    getActiveSeatContextRevision: () => revision,
    resolveSeatHome: () => ({
      seatId: SEAT_ID,
      legacy: false,
      hermesRoot: '/tmp/command-eve-visual-bridge-tests/hermes',
      hermesHome: '/tmp/command-eve-visual-bridge-tests/hermes/home',
    }),
    getDataPath: () => '/tmp/command-eve-visual-bridge-tests',
    areFileSelectionPathsGranted: () => true,
    readVisualPolicy: async () => ENABLED_POLICY,
    verifyVisualPolicyReceipt: () => VERIFIED_RECEIPT,
    fetch: fetchMock,
  };
  return {
    deps,
    fetchMock,
    bumpRevision: () => {
      revision += 1;
    },
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  readLicenseWireMock.mockReturnValue({ ok: true, wire: 'CEVE.v2.synthetic.test' });
  inspectLocalImageMock.mockReturnValue({
    sourcePath: '/tmp/selected.png',
    sourceName: 'selected.png',
    sourceBytes: 8,
    sourceMimeType: 'image/png',
    sha256: 'a'.repeat(64),
    cacheDirectory: '/tmp/command-eve-visual-bridge-tests/image-cache',
  });
  inspectLocalPresentationMock.mockResolvedValue({
    sourcePath: '/tmp/selected.pptx',
    sourceName: 'selected.pptx',
    sourceBytes: 128,
    sha256: 'c'.repeat(64),
    slideCount: 1,
    slideTexts: [{ slideNumber: 1, text: 'Local slide text.' }],
    cacheDirectory: '/tmp/command-eve-visual-bridge-tests/presentation-cache',
  });
  prepareImageWithVisionMock.mockImplementation(async (input) => {
    await input.analyze({
      requestId: 'image-request-1',
      fileName: 'selected.png',
      fileSha256: 'a'.repeat(64),
      locale: 'de-DE',
      image: {
        mimeType: 'image/jpeg',
        sha256: 'b'.repeat(64),
        bytes: new Uint8Array([0xff, 0xd8, 0xff, 0xd9]),
      },
    });
    throw new Error('negative test unexpectedly passed the image egress gate');
  });
  preparePresentationWithVisionMock.mockImplementation(async (input) => {
    await input.analyzeBatch({
      requestId: 'presentation-request-1',
      fileName: 'selected.pptx',
      fileSha256: 'c'.repeat(64),
      slideCount: 1,
      contextText: 'Local slide text.',
      locale: 'de-DE',
      images: [
        {
          slideNumber: 1,
          mimeType: 'image/jpeg',
          sha256: 'd'.repeat(64),
          bytes: new Uint8Array([0xff, 0xd8, 0xff, 0xd9]),
        },
      ],
    });
    throw new Error('negative test unexpectedly passed the presentation egress gate');
  });
});

describe('Command EVE image preparation bridge authority', () => {
  it('does not treat historical allowCloudVision as authority', async () => {
    const state = imageHarness();
    state.deps.verifyVisualPolicyReceipt = () => ({ ok: false, reason: 'receipt_unknown' });

    const result = await handleCommandEveImagePrepare(
      { filePaths: ['/tmp/selected.png'], allowCloudVision: true, privacyLane: 'cloud_auto' },
      state.deps
    );

    expect(result).toMatchObject({
      success: false,
      data: { reason_code: 'EVE_IMAGE_CLOUD_VISUAL_POLICY_REQUIRED' },
    });
    expect(readLicenseWireMock).not.toHaveBeenCalled();
    expect(state.fetchMock).not.toHaveBeenCalled();
  });

  it('does not expose cached image documents before every pending image has receipt authority', async () => {
    const state = imageHarness();
    state.deps.verifyVisualPolicyReceipt = () => ({ ok: false, reason: 'receipt_unknown' });
    inspectLocalImageMock
      .mockReturnValueOnce({
        sourcePath: '/tmp/cached.png',
        sourceName: 'cached.png',
        sourceBytes: 8,
        sourceMimeType: 'image/png',
        sha256: 'a'.repeat(64),
        cacheDirectory: '/tmp/command-eve-visual-bridge-tests/image-cache',
        cachedDocument: {
          source_path: '/tmp/cached.png',
          source_name: 'cached.png',
          sha256: 'a'.repeat(64),
          bytes: 8,
          extraction_mode: 'cloud_vision',
          sidecar_path: '/tmp/cached.image-context.md',
          prompt_context: 'cached image context',
          citation_format: '[Image 1]',
          model: 'synthetic-vision',
          cache_hit: true,
        },
      })
      .mockReturnValueOnce({
        sourcePath: '/tmp/pending.png',
        sourceName: 'pending.png',
        sourceBytes: 8,
        sourceMimeType: 'image/png',
        sha256: 'b'.repeat(64),
        cacheDirectory: '/tmp/command-eve-visual-bridge-tests/image-cache',
      });

    const result = await handleCommandEveImagePrepare(
      { filePaths: ['/tmp/cached.png', '/tmp/pending.png'], privacyLane: 'cloud_auto' },
      state.deps
    );

    expect(result).toMatchObject({
      success: false,
      data: {
        reason_code: 'EVE_IMAGE_CLOUD_VISUAL_POLICY_REQUIRED',
        documents: [],
        prepared_files: [],
        pending_source_names: ['pending.png'],
      },
    });
    expect(readLicenseWireMock).not.toHaveBeenCalled();
    expect(state.fetchMock).not.toHaveBeenCalled();
  });

  it.each([
    {
      name: 'disabled',
      policy: {
        status: 'disabled',
        reason: 'disabled_by_operator',
        seatId: SEAT_ID,
        physicalKey: `seat:${SEAT_ID}:commandEve.cloudVisualAnalysisEnabled`,
      } satisfies CommandEveCloudVisualPolicyState,
      reasonCode: 'EVE_IMAGE_CLOUD_VISUAL_POLICY_DISABLED',
    },
    {
      name: 'unavailable',
      policy: {
        status: 'unavailable',
        reason: 'settings_read_failed',
        seatId: SEAT_ID,
      } satisfies CommandEveCloudVisualPolicyState,
      reasonCode: 'EVE_IMAGE_CLOUD_VISUAL_POLICY_UNAVAILABLE',
    },
  ])('performs no fetch when the fresh policy is $name', async ({ policy, reasonCode }) => {
    const state = imageHarness();
    state.deps.readVisualPolicy = async () => policy;

    const result = await handleCommandEveImagePrepare(
      {
        filePaths: ['/tmp/selected.png'],
        flowId: FLOW_ID,
        visualPolicyReceipt: RECEIPT,
        privacyLane: 'cloud_auto',
      },
      state.deps
    );

    expect(result).toMatchObject({ success: false, data: { reason_code: reasonCode } });
    expect(state.fetchMock).not.toHaveBeenCalled();
  });

  it('performs no fetch when the seat revision changes during the final policy read', async () => {
    const state = imageHarness();
    state.deps.readVisualPolicy = async () => {
      state.bumpRevision();
      return ENABLED_POLICY;
    };

    const result = await handleCommandEveImagePrepare(
      {
        filePaths: ['/tmp/selected.png'],
        flowId: FLOW_ID,
        visualPolicyReceipt: RECEIPT,
        privacyLane: 'cloud_auto',
      },
      state.deps
    );

    expect(result).toMatchObject({
      success: false,
      data: { reason_code: 'EVE_IMAGE_CLOUD_VISUAL_POLICY_UNAVAILABLE' },
    });
    expect(state.fetchMock).not.toHaveBeenCalled();
  });

  it('requires a live file-selection grant before local inspection or policy work', async () => {
    const state = imageHarness();
    state.deps.areFileSelectionPathsGranted = () => false;

    const result = await handleCommandEveImagePrepare(
      {
        filePaths: ['/tmp/selected.png'],
        flowId: FLOW_ID,
        visualPolicyReceipt: RECEIPT,
      },
      state.deps
    );

    expect(result).toMatchObject({
      success: false,
      data: { reason_code: 'EVE_IMAGE_SOURCE_NOT_USER_SELECTED' },
    });
    expect(inspectLocalImageMock).not.toHaveBeenCalled();
    expect(state.fetchMock).not.toHaveBeenCalled();
  });
});

describe('Command EVE presentation preparation bridge authority', () => {
  it('does not treat historical allowCloudVision as authority', async () => {
    const state = presentationHarness();
    state.deps.verifyVisualPolicyReceipt = () => ({ ok: false, reason: 'receipt_expired' });

    const result = await handleCommandEvePresentationPrepare(
      { filePaths: ['/tmp/selected.pptx'], allowCloudVision: true, privacyLane: 'cloud_auto' },
      state.deps
    );

    expect(result).toMatchObject({
      success: false,
      data: { reason_code: 'EVE_PRESENTATION_CLOUD_VISUAL_POLICY_REQUIRED' },
    });
    expect(readLicenseWireMock).not.toHaveBeenCalled();
    expect(state.fetchMock).not.toHaveBeenCalled();
  });

  it('does not expose cached presentation documents before every pending deck has receipt authority', async () => {
    const state = presentationHarness();
    state.deps.verifyVisualPolicyReceipt = () => ({ ok: false, reason: 'receipt_expired' });
    inspectLocalPresentationMock
      .mockResolvedValueOnce({
        sourcePath: '/tmp/cached.pptx',
        sourceName: 'cached.pptx',
        sourceBytes: 128,
        sha256: 'c'.repeat(64),
        slideCount: 1,
        slideTexts: [{ slideNumber: 1, text: 'Cached slide text.' }],
        cacheDirectory: '/tmp/command-eve-visual-bridge-tests/presentation-cache',
        cachedDocument: {
          source_path: '/tmp/cached.pptx',
          source_name: 'cached.pptx',
          sha256: 'c'.repeat(64),
          bytes: 128,
          slide_count: 1,
          analyzed_slides: 1,
          extraction_mode: 'cloud_vision',
          sidecar_path: '/tmp/cached.presentation-context.md',
          prompt_context: 'cached presentation context',
          citation_format: '[PPTX slide N]',
          model: 'synthetic-vision',
          cache_hit: true,
        },
      })
      .mockResolvedValueOnce({
        sourcePath: '/tmp/pending.pptx',
        sourceName: 'pending.pptx',
        sourceBytes: 128,
        sha256: 'd'.repeat(64),
        slideCount: 1,
        slideTexts: [{ slideNumber: 1, text: 'Pending slide text.' }],
        cacheDirectory: '/tmp/command-eve-visual-bridge-tests/presentation-cache',
      });

    const result = await handleCommandEvePresentationPrepare(
      { filePaths: ['/tmp/cached.pptx', '/tmp/pending.pptx'], privacyLane: 'cloud_auto' },
      state.deps
    );

    expect(result).toMatchObject({
      success: false,
      data: {
        reason_code: 'EVE_PRESENTATION_CLOUD_VISUAL_POLICY_REQUIRED',
        documents: [],
        prepared_files: [],
        pending_source_names: ['pending.pptx'],
      },
    });
    expect(readLicenseWireMock).not.toHaveBeenCalled();
    expect(state.fetchMock).not.toHaveBeenCalled();
  });

  it.each([
    {
      name: 'disabled',
      policy: {
        status: 'disabled',
        reason: 'disabled_by_operator',
        seatId: SEAT_ID,
        physicalKey: `seat:${SEAT_ID}:commandEve.cloudVisualAnalysisEnabled`,
      } satisfies CommandEveCloudVisualPolicyState,
      reasonCode: 'EVE_PRESENTATION_CLOUD_VISUAL_POLICY_DISABLED',
    },
    {
      name: 'unavailable',
      policy: {
        status: 'unavailable',
        reason: 'settings_read_failed',
        seatId: SEAT_ID,
      } satisfies CommandEveCloudVisualPolicyState,
      reasonCode: 'EVE_PRESENTATION_CLOUD_VISUAL_POLICY_UNAVAILABLE',
    },
  ])('performs no fetch when the fresh policy is $name', async ({ policy, reasonCode }) => {
    const state = presentationHarness();
    state.deps.readVisualPolicy = async () => policy;

    const result = await handleCommandEvePresentationPrepare(
      {
        filePaths: ['/tmp/selected.pptx'],
        flowId: FLOW_ID,
        visualPolicyReceipt: RECEIPT,
        privacyLane: 'cloud_auto',
      },
      state.deps
    );

    expect(result).toMatchObject({ success: false, data: { reason_code: reasonCode } });
    expect(state.fetchMock).not.toHaveBeenCalled();
  });

  it('performs no fetch when the seat revision changes during the final policy read', async () => {
    const state = presentationHarness();
    state.deps.readVisualPolicy = async () => {
      state.bumpRevision();
      return ENABLED_POLICY;
    };

    const result = await handleCommandEvePresentationPrepare(
      {
        filePaths: ['/tmp/selected.pptx'],
        flowId: FLOW_ID,
        visualPolicyReceipt: RECEIPT,
        privacyLane: 'cloud_auto',
      },
      state.deps
    );

    expect(result).toMatchObject({
      success: false,
      data: { reason_code: 'EVE_PRESENTATION_CLOUD_VISUAL_POLICY_UNAVAILABLE' },
    });
    expect(state.fetchMock).not.toHaveBeenCalled();
  });

  it('requires a live file-selection grant before local inspection or policy work', async () => {
    const state = presentationHarness();
    state.deps.areFileSelectionPathsGranted = () => false;

    const result = await handleCommandEvePresentationPrepare(
      {
        filePaths: ['/tmp/selected.pptx'],
        flowId: FLOW_ID,
        visualPolicyReceipt: RECEIPT,
      },
      state.deps
    );

    expect(result).toMatchObject({
      success: false,
      data: { reason_code: 'EVE_PRESENTATION_SOURCE_NOT_USER_SELECTED' },
    });
    expect(inspectLocalPresentationMock).not.toHaveBeenCalled();
    expect(state.fetchMock).not.toHaveBeenCalled();
  });
});

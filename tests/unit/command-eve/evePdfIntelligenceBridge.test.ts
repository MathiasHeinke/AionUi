/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const registered = new Map<string, (req?: unknown) => Promise<unknown>>();
const { prepareLocalPdfMock, persistPdfSidecarMock, readLicenseWireMock, activeSeatState } = vi.hoisted(() => ({
  prepareLocalPdfMock: vi.fn(),
  persistPdfSidecarMock: vi.fn(),
  readLicenseWireMock: vi.fn(() => ({ ok: true, wire: 'test-license-wire' })),
  activeSeatState: {
    seatId: 'a2000000-0000-4000-8000-000000000001',
    revision: 1,
  },
}));

vi.mock('@office-ai/platform', () => ({
  bridge: {
    buildProvider: (channel: string) => ({
      provider: (fn: (req?: unknown) => Promise<unknown>) => {
        registered.set(channel, fn);
        return { channel };
      },
    }),
  },
}));

vi.mock('@process/utils/initStorage', () => ({
  ProcessConfig: { get: () => undefined, getSync: () => undefined, set: () => {} },
  getSkillsDir: () => '/tmp/skills',
  getCronSkillsDir: () => '/tmp/cron-skills',
}));

vi.mock('@process/utils/utils', () => ({ getDataPath: () => '/tmp/ce-pdf-intelligence-bridge' }));
vi.mock('@process/commandEve/seatWireFetchCore', () => ({ readMySeatsWire: vi.fn(async () => null) }));
vi.mock('@process/commandEve/seatContextCore', async (importOriginal) => {
  const original = await importOriginal<typeof import('@process/commandEve/seatContextCore')>();
  return {
    ...original,
    getActiveSeatId: () => activeSeatState.seatId,
    getActiveSeatContextRevision: () => activeSeatState.revision,
  };
});
vi.mock('@/common/config/licenseWireAtRest', () => ({
  clearLicenseWire: vi.fn(),
  hasLicenseWire: vi.fn(() => true),
  readLicenseWire: (...args: unknown[]) => readLicenseWireMock(...args),
  storeLicenseWire: vi.fn(),
}));
vi.mock('@process/commandEve/document/pdfIntelligenceService', async (importOriginal) => {
  const original = await importOriginal<typeof import('@process/commandEve/document/pdfIntelligenceService')>();
  return {
    ...original,
    prepareLocalPdf: (...args: unknown[]) => prepareLocalPdfMock(...args),
    persistPdfSidecar: (...args: unknown[]) => persistPdfSidecarMock(...args),
  };
});

import { initCommandEveBridge } from '@process/bridge/commandEveBridge';

type BridgeEnvelope = {
  success: boolean;
  msg?: string;
  data?: Record<string, unknown>;
};

const call = (request?: unknown) =>
  (registered.get('command-eve.pdf-prepare') as (value?: unknown) => Promise<BridgeEnvelope>)(request);

function localPreparation(requiresOcr: boolean) {
  return {
    sourceBytes: new TextEncoder().encode('%PDF-test'),
    pages: [{ pageNumber: 1, text: requiresOcr ? '' : 'Locally extracted text.' }],
    quality: {
      pageCount: 1,
      extractedCharacters: requiresOcr ? 0 : 23,
      pagesWithText: requiresOcr ? 0 : 1,
      requiresOcr,
    },
    document: {
      source_path: '/tmp/report.pdf',
      source_name: 'report.pdf',
      sha256: 'a'.repeat(64),
      bytes: 9,
      page_count: 1,
      extracted_characters: requiresOcr ? 0 : 23,
      extraction_mode: 'local_text',
      sidecar_path: '/tmp/hermes/document-intelligence/pdf/a/document.md',
      citation_format: '[PDF p. N]',
      cache_hit: false,
    },
  };
}

describe('Command EVE PDF intelligence bridge', () => {
  beforeEach(() => {
    registered.clear();
    prepareLocalPdfMock.mockReset();
    persistPdfSidecarMock.mockReset();
    readLicenseWireMock.mockReset();
    readLicenseWireMock.mockReturnValue({ ok: true, wire: 'test-license-wire' });
    activeSeatState.seatId = 'a2000000-0000-4000-8000-000000000001';
    activeSeatState.revision = 1;
    vi.stubGlobal('fetch', vi.fn());
    initCommandEveBridge();
    readLicenseWireMock.mockClear();
    vi.mocked(globalThis.fetch).mockClear();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.clearAllMocks();
  });

  it('registers PDF preparation in MAIN and returns only the private local citation sidecar', async () => {
    prepareLocalPdfMock.mockResolvedValue(localPreparation(false));

    const result = await call({ data: { filePaths: ['/tmp/report.pdf'] } });

    expect(result).toMatchObject({
      success: true,
      data: {
        ok: true,
        prepared_files: ['/tmp/hermes/document-intelligence/pdf/a/document.md'],
        cloud_ocr_used: false,
        requires_cloud_ocr_consent: false,
      },
    });
    expect(prepareLocalPdfMock).toHaveBeenCalledWith(
      expect.objectContaining({
        filePath: '/tmp/report.pdf',
        hermesHome: expect.stringContaining('command-eve'),
        isContextCurrent: expect.any(Function),
      })
    );
    expect(globalThis.fetch).not.toHaveBeenCalled();
    expect(readLicenseWireMock).not.toHaveBeenCalled();
  });

  it('stops before license access or cloud egress when a scanned PDF lacks per-send consent', async () => {
    prepareLocalPdfMock.mockResolvedValue(localPreparation(true));

    const result = await call({ data: { filePaths: ['/tmp/report.pdf'], allowCloudOcr: false } });

    expect(result).toMatchObject({
      success: false,
      msg: 'EVE_PDF_CLOUD_OCR_CONSENT_REQUIRED',
      data: {
        ok: false,
        requires_cloud_ocr_consent: true,
        pending_source_names: ['report.pdf'],
        prepared_files: [],
      },
    });
    expect(globalThis.fetch).not.toHaveBeenCalled();
    expect(readLicenseWireMock).not.toHaveBeenCalled();
  });

  it('holds one Seed revision for the whole PDF batch and refuses before POST or persistence after A-to-B switch', async () => {
    let resolvePreparation!: (value: ReturnType<typeof localPreparation>) => void;
    prepareLocalPdfMock.mockImplementation(
      () =>
        new Promise((resolve) => {
          resolvePreparation = resolve;
        })
    );

    const pending = call({ data: { filePaths: ['/tmp/report.pdf'], allowCloudOcr: true } });
    await vi.waitFor(() => expect(prepareLocalPdfMock).toHaveBeenCalledOnce());
    activeSeatState.seatId = 'b2000000-0000-4000-8000-000000000001';
    activeSeatState.revision += 1;
    resolvePreparation(localPreparation(true));

    await expect(pending).resolves.toMatchObject({
      success: false,
      msg: 'EVE_PDF_SEAT_CHANGED',
      data: { documents: [], prepared_files: [] },
    });
    expect(globalThis.fetch).not.toHaveBeenCalled();
    expect(persistPdfSidecarMock).not.toHaveBeenCalled();
  });

  it('revalidates the captured Seed after cloud POST and before sidecar persistence', async () => {
    const prepared = localPreparation(true);
    prepareLocalPdfMock.mockResolvedValue(prepared);
    let resolveFetch!: (value: Response) => void;
    vi.mocked(globalThis.fetch).mockImplementationOnce(
      () =>
        new Promise<Response>((resolve) => {
          resolveFetch = resolve;
        })
    );

    const pending = call({ data: { filePaths: ['/tmp/report.pdf'], allowCloudOcr: true } });
    await vi.waitFor(() => expect(globalThis.fetch).toHaveBeenCalledOnce());
    activeSeatState.seatId = 'b2000000-0000-4000-8000-000000000001';
    activeSeatState.revision += 1;
    resolveFetch(
      new Response(
        JSON.stringify({
          ok: true,
          artifact: { text: '## Page 1\n\nAlpha' },
          document: { page_count: 1 },
        }),
        { status: 200 }
      )
    );

    await expect(pending).resolves.toMatchObject({
      success: false,
      msg: 'EVE_PDF_SEAT_CHANGED',
      data: { documents: [], prepared_files: [] },
    });
    expect(persistPdfSidecarMock).not.toHaveBeenCalled();
  });

  it('sends scanned PDF bytes only to the licensed server gateway after consent and redacts them from the result', async () => {
    const prepared = localPreparation(true);
    prepareLocalPdfMock.mockResolvedValue(prepared);
    persistPdfSidecarMock.mockReturnValue({
      ...prepared.document,
      extraction_mode: 'cloud_ocr',
      extracted_characters: 5,
      sidecar_path: '/tmp/hermes/document-intelligence/pdf/a/document.md',
    });
    vi.mocked(globalThis.fetch).mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          ok: true,
          gateway: 'eve-multimodal',
          provider: 'openrouter',
          capability: 'document_ocr',
          reason: 'provider-complete',
          artifact: {
            status: 'created',
            kind: 'document',
            mime_type: 'text/markdown',
            encoding: 'utf8',
            text: '## Page 1\n\nAlpha',
            bytes: 16,
          },
          residency: {
            requestedPrivacyLane: 'cloud_auto',
            effectiveResidency: 'global_cloud',
            confirmation: 'zdr-enforced-global',
          },
          document: {
            engine: 'mistral-ocr',
            model: 'google/gemini-2.5-flash',
            page_count: 1,
            zdr_enforced: true,
            data_collection: 'deny',
          },
        }),
        { status: 200, headers: { 'content-type': 'application/json' } }
      )
    );

    const result = await call({
      data: { filePaths: ['/tmp/report.pdf'], allowCloudOcr: true, privacyLane: 'cloud_auto' },
    });

    expect(result).toMatchObject({
      success: true,
      data: {
        ok: true,
        cloud_ocr_used: true,
        prepared_files: ['/tmp/hermes/document-intelligence/pdf/a/document.md'],
      },
    });
    expect(globalThis.fetch).toHaveBeenCalledTimes(1);
    const init = vi.mocked(globalThis.fetch).mock.calls[0]?.[1] as RequestInit;
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer test-license-wire');
    expect(String(init.body)).toContain('"file_data_base64":"JVBERi10ZXN0"');
    expect(JSON.parse(String(init.body)).seat_id).toBe('a2000000-0000-4000-8000-000000000001');
    expect(String(init.body)).not.toContain('test-license-wire');
    expect(JSON.stringify(result)).not.toContain('JVBERi10ZXN0');
    expect(JSON.stringify(result)).not.toContain('test-license-wire');
  });
});

// Command EVE — eve-multimodal Edge Function handler tests.
//
// Run: deno test --allow-env supabase/functions/eve-multimodal/index.test.ts

import { assertEquals } from 'jsr:@std/assert@1';
import crypto from 'node:crypto';
import { reserveBillableOperation } from '../_shared/billable-operations.ts';
import { buildLicensePayloadV2, signLicenseCode } from '../_shared/license-code-core.ts';
import { callOpenRouterImageGeneration, extractEveImageGenerationInput } from './image-generation-core.ts';
import { resolveImageGenerationModel } from './image-model-registry.ts';
import { handleEveMultimodal as handleEveMultimodalRaw, resetEveMultimodalPublicKeyCacheForTests } from './index.ts';
import { buildXaiVideoEditBody, videoEditDebitExternalRef, videoPromptSha256 } from './video-generation-core.ts';

const NOWISH = '2026-07-07T12:00:00.000Z';
let testSigningKeyPem: string | null = null;
const TEST_ENTITLEMENT_ID = '00000000-0000-4000-8000-000000000101';

type HandlerDeps = NonNullable<Parameters<typeof handleEveMultimodalRaw>[1]>;
type ObservedFetchInit = {
  body?: unknown;
  headers?: Record<string, string>;
  signal?: { addEventListener(type: string, listener: () => void): void };
};

function observedFetchInit(value: unknown): ObservedFetchInit {
  return value as ObservedFetchInit;
}

/**
 * The deployed v31 handler reserves every paid provider call before egress.
 * Legacy provider-contract tests predate that shared ledger barrier, so their
 * deterministic harness supplies a successful in-memory ledger rather than
 * falling through to an unconfigured production RPC.
 */
function handleEveMultimodal(req: Request, deps: HandlerDeps = {}): Promise<Response> {
  return handleEveMultimodalRaw(req, {
    commitVideoDebit: (input) =>
      Promise.resolve({
        status: 'applied' as const,
        entitlementId: input.expectedEntitlementId ?? TEST_ENTITLEMENT_ID,
        externalRef: input.externalRef,
        fromAllowance: 0,
        fromPurchased: 0,
      }),
    reverseVideoDebit: () => Promise.resolve({ ok: true }),
    ...deps,
  });
}

function installSigningKey(): string {
  if (testSigningKeyPem) {
    Deno.env.set('COMMAND_EVE_LICENSE_SIGNING_KEY', testSigningKeyPem);
    resetEveMultimodalPublicKeyCacheForTests();
    return testSigningKeyPem;
  }
  const { privateKey } = crypto.generateKeyPairSync('ed25519');
  const signingKeyPem = privateKey.export({
    type: 'pkcs8',
    format: 'pem',
  }) as string;
  Deno.env.set('COMMAND_EVE_LICENSE_SIGNING_KEY', signingKeyPem);
  resetEveMultimodalPublicKeyCacheForTests();
  testSigningKeyPem = signingKeyPem;
  return signingKeyPem;
}

function licenseWire(expiresAt: string | null = '2027-07-07T00:00:00.000Z'): string {
  const signingKeyPem = installSigningKey();
  const payload = buildLicensePayloadV2({
    edition: 'standard',
    serial: 'code-1',
    tenant_serial: '00000000-0000-4000-8000-000000000001',
    issued_at: NOWISH,
    expires_at: expiresAt,
    trial_ends_at: null,
    seat_count: 1,
  });
  if (!payload.ok) {
    throw new Error(`payload failed: ${payload.reason_code}`);
  }
  return signLicenseCode({
    payload: payload.payload,
    privateKeyPem: signingKeyPem,
  });
}

function request(body: unknown, wire = licenseWire()): Request {
  return new Request('https://example.supabase.co/functions/v1/eve-multimodal', {
    method: 'POST',
    headers: {
      authorization: `Bearer ${wire}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify(body),
  });
}

function disableTtsProvider(): void {
  Deno.env.delete('EVE_MULTIMODAL_ENABLE_XAI_TTS');
  Deno.env.delete('XAI_API_KEY');
  Deno.env.delete('EVE_MULTIMODAL_TTS_TIMEOUT_MS');
}

function enableTtsProvider(apiKey = 'test-xai-key'): void {
  Deno.env.set('EVE_MULTIMODAL_ENABLE_XAI_TTS', 'true');
  Deno.env.set('XAI_API_KEY', apiKey);
}

function disablePdfOcrProvider(): void {
  Deno.env.delete('EVE_MULTIMODAL_ENABLE_OPENROUTER_PDF_OCR');
  Deno.env.delete('EVE_MULTIMODAL_OPENROUTER_PDF_MODEL');
  Deno.env.delete('EVE_MULTIMODAL_PDF_OCR_TIMEOUT_MS');
  Deno.env.delete('OPENROUTER_API_KEY');
}

function enablePdfOcrProvider(apiKey = 'test-openrouter-key'): void {
  Deno.env.set('EVE_MULTIMODAL_ENABLE_OPENROUTER_PDF_OCR', 'true');
  Deno.env.set('OPENROUTER_API_KEY', apiKey);
}

function disableVideoEditProvider(): void {
  Deno.env.delete('EVE_MULTIMODAL_ENABLE_XAI_VIDEO_EDIT');
  Deno.env.delete('XAI_API_KEY');
}

function enableVideoEditProvider(apiKey = 'test-xai-key'): void {
  Deno.env.set('EVE_MULTIMODAL_ENABLE_XAI_VIDEO_EDIT', 'true');
  Deno.env.set('XAI_API_KEY', apiKey);
}

const VIDEO_EDIT_PROMPT = 'Gib der Aubergine ein Gesicht.';
const VIDEO_EDIT_MP4_BYTES = new Uint8Array([
  0, 0, 0, 24, 0x66, 0x74, 0x79, 0x70, 0x69, 0x73, 0x6f, 0x6d, 0, 0, 0, 0, 0x69, 0x73, 0x6f, 0x6d, 0x6d, 0x70, 0x34,
  0x32,
]);
const VIDEO_EDIT_MP4_BASE64 = btoa(String.fromCharCode(...VIDEO_EDIT_MP4_BYTES));
const VIDEO_EDIT_MP4_SHA256 = crypto.createHash('sha256').update(VIDEO_EDIT_MP4_BYTES).digest('hex');

function videoEditRequestBody(sourceDurationSeconds = 8.7, requestId = 'video-edit-cost-wall') {
  return {
    provider: 'xai',
    capability: 'video_edit',
    privacyLane: 'cloud_auto',
    directProviderKeyPresentInDesktop: false,
    requestId,
    video_edit: {
      prompt: VIDEO_EDIT_PROMPT,
      tier: 'fast',
      source_base64: VIDEO_EDIT_MP4_BASE64,
      source_sha256: VIDEO_EDIT_MP4_SHA256,
      source_duration_seconds: sourceDurationSeconds,
    },
  };
}

function buildPdfFixture(pageCount: number): Uint8Array {
  const pageObjectNumbers = Array.from({ length: pageCount }, (_, index) => index + 3);
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    `<< /Type /Pages /Kids [${pageObjectNumbers.map((number) => `${number} 0 R`).join(' ')}] /Count ${pageCount} >>`,
    ...pageObjectNumbers.map(() => '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] >>'),
  ];
  const byteLength = (value: string) => new TextEncoder().encode(value).byteLength;
  let pdf = '%PDF-1.4\n';
  const offsets = [0];
  objects.forEach((object, index) => {
    offsets.push(byteLength(pdf));
    pdf += `${index + 1} 0 obj\n${object}\nendobj\n`;
  });
  const xrefOffset = byteLength(pdf);
  pdf += `xref\n0 ${objects.length + 1}\n`;
  pdf += '0000000000 65535 f \n';
  for (const offset of offsets.slice(1)) {
    pdf += `${String(offset).padStart(10, '0')} 00000 n \n`;
  }
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`;
  return new TextEncoder().encode(pdf);
}

function pdfRequestBody(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  const bytes = buildPdfFixture(2);
  return {
    provider: 'openrouter',
    capability: 'document_ocr',
    privacyLane: 'cloud_auto',
    directProviderKeyPresentInDesktop: false,
    file_name: 'meeting.pdf',
    file_sha256: crypto.createHash('sha256').update(bytes).digest('hex'),
    file_data_base64: btoa(String.fromCharCode(...bytes)),
    page_count: 2,
    requestId: 'req_pdf',
    ...overrides,
  };
}

function allowPdfOcrUsage() {
  return Promise.resolve({
    ok: true as const,
    allowed: true,
    reason: 'reserved',
    tenantUnits: 2,
    tenantCap: 500,
    globalUnits: 2,
    globalCap: 10_000,
    replayed: false,
  });
}

Deno.test('answers CORS preflight without license verification', async () => {
  const response = await handleEveMultimodal(
    new Request('https://example.supabase.co/functions/v1/eve-multimodal', {
      method: 'OPTIONS',
      headers: { origin: 'http://localhost:5173' },
    })
  );

  assertEquals(response.status, 204);
  assertEquals(response.headers.get('Access-Control-Allow-Origin'), 'http://localhost:5173');
  assertEquals(response.headers.get('Access-Control-Allow-Methods'), 'GET, POST, OPTIONS');
  assertEquals(
    response.headers.get('Access-Control-Allow-Headers'),
    'authorization, content-type, apikey, x-client-info'
  );
});

Deno.test('does not reflect disallowed CORS origins', async () => {
  const response = await handleEveMultimodal(
    new Request('https://example.supabase.co/functions/v1/eve-multimodal', {
      method: 'OPTIONS',
      headers: { origin: 'https://evil.example' },
    })
  );

  assertEquals(response.status, 204);
  assertEquals(response.headers.get('Access-Control-Allow-Origin'), 'null');
});

Deno.test('rejects non-POST methods', async () => {
  const response = await handleEveMultimodal(
    new Request('https://example.supabase.co/functions/v1/eve-multimodal', {
      method: 'GET',
    })
  );
  const body = await response.json();

  assertEquals(response.status, 405);
  assertEquals(body.reason, 'method-not-allowed');
});

Deno.test('requires a CEVE license bearer', async () => {
  const response = await handleEveMultimodal(
    new Request('https://example.supabase.co/functions/v1/eve-multimodal', {
      method: 'POST',
      body: JSON.stringify({ capability: 'tts' }),
    })
  );
  const body = await response.json();

  assertEquals(response.status, 401);
  assertEquals(body.reason, 'missing-license');
});

Deno.test('fails closed when license verification is not configured', async () => {
  Deno.env.delete('COMMAND_EVE_LICENSE_SIGNING_KEY');
  resetEveMultimodalPublicKeyCacheForTests();
  const response = await handleEveMultimodal(
    new Request('https://example.supabase.co/functions/v1/eve-multimodal', {
      method: 'POST',
      headers: { authorization: 'Bearer CEVE.fake.fake.fake' },
      body: JSON.stringify({ capability: 'tts' }),
    })
  );
  const body = await response.json();

  assertEquals(response.status, 503);
  assertEquals(body.reason, 'server-not-configured');
});

Deno.test('rejects expired license bearers conclusively', async () => {
  const expiredWire = licenseWire('2026-01-01T00:00:00.000Z');
  const response = await handleEveMultimodal(
    request(
      {
        provider: 'xai',
        capability: 'tts',
        privacyLane: 'cloud_us',
        directProviderKeyPresentInDesktop: false,
      },
      expiredWire
    )
  );
  const body = await response.json();

  assertEquals(response.status, 403);
  assertEquals(body.reason, 'license-expired');
});

Deno.test('rejects invalid JSON bodies after license verification', async () => {
  const response = await handleEveMultimodal(
    new Request('https://example.supabase.co/functions/v1/eve-multimodal', {
      method: 'POST',
      headers: {
        authorization: `Bearer ${licenseWire()}`,
        'content-type': 'application/json',
      },
      body: '{',
    })
  );
  const body = await response.json();

  assertEquals(response.status, 400);
  assertEquals(body.reason, 'invalid-json');
});

Deno.test('verifies license auth but still refuses provider execution in the skeleton', async () => {
  disableTtsProvider();
  const response = await handleEveMultimodal(
    request({
      provider: 'xai',
      capability: 'tts',
      privacyLane: 'cloud_us',
      directProviderKeyPresentInDesktop: false,
      text: 'Hello from disabled TTS.',
      requestId: 'req_handler',
    })
  );
  const body = await response.json();

  assertEquals(response.status, 501);
  assertEquals(body.reason, 'provider-not-enabled');
  assertEquals(body.request_id, 'req_handler');
  assertEquals(body.license.verified, true);
  assertEquals(body.license.edition, 'standard');
  assertEquals(body.artifact.kind, 'audio');
});

Deno.test('requires server-side XAI_API_KEY before enabled TTS can run', async () => {
  try {
    Deno.env.set('EVE_MULTIMODAL_ENABLE_XAI_TTS', 'true');
    Deno.env.delete('XAI_API_KEY');
    const response = await handleEveMultimodal(
      request({
        provider: 'xai',
        capability: 'tts',
        privacyLane: 'cloud_us',
        directProviderKeyPresentInDesktop: false,
        text: 'Hello.',
      })
    );
    const body = await response.json();

    assertEquals(response.status, 503);
    assertEquals(body.reason, 'provider-not-configured');
  } finally {
    disableTtsProvider();
  }
});

Deno.test('leaves non-TTS capabilities provider-disabled even when TTS is enabled', async () => {
  try {
    enableTtsProvider();
    let fetchCalls = 0;
    const fetchStub: typeof fetch = () => {
      fetchCalls += 1;
      return Promise.resolve(
        new Response(new Uint8Array([1, 2, 3]), {
          status: 200,
          headers: { 'content-type': 'audio/mpeg' },
        })
      );
    };
    const response = await handleEveMultimodal(
      request({
        provider: 'xai',
        capability: 'realtime_voice',
        privacyLane: 'cloud_us',
        directProviderKeyPresentInDesktop: false,
      }),
      { fetch: fetchStub }
    );
    const body = await response.json();

    assertEquals(fetchCalls, 0);
    assertEquals(response.status, 501);
    assertEquals(body.reason, 'provider-not-enabled');
  } finally {
    disableTtsProvider();
  }
});

Deno.test('calls xAI TTS when enabled and returns an audio artifact without echoing text', async () => {
  try {
    enableTtsProvider();
    const fetchCalls: Array<{ input: string | URL | Request; init?: RequestInit }> = [];
    const fetchStub: typeof fetch = (input, init) => {
      fetchCalls.push({ input, init });
      const observed = observedFetchInit(init);
      const payload = JSON.parse(String(observed.body));
      const headers = observed.headers ?? {};

      assertEquals(String(input), 'https://api.x.ai/v1/tts');
      assertEquals(headers.Authorization, 'Bearer test-xai-key');
      assertEquals(payload, {
        text: 'Hello from xAI TTS.',
        voice_id: 'eve',
        language: 'en',
      });

      return Promise.resolve(
        new Response(new Uint8Array([1, 2, 3]), {
          status: 200,
          headers: { 'content-type': 'audio/mpeg' },
        })
      );
    };

    const response = await handleEveMultimodal(
      request({
        provider: 'xai',
        capability: 'tts',
        privacyLane: 'cloud_us',
        directProviderKeyPresentInDesktop: false,
        text: 'Hello from xAI TTS.',
        voice_id: 'eve',
        language: 'en',
        requestId: 'req_tts',
      }),
      { fetch: fetchStub }
    );
    const body = await response.json();

    assertEquals(fetchCalls.length, 1);
    assertEquals(response.status, 200);
    assertEquals(body.ok, true);
    assertEquals(body.reason, 'provider-complete');
    assertEquals(body.request_id, 'req_tts');
    assertEquals(body.artifact, {
      status: 'created',
      kind: 'audio',
      mime_type: 'audio/mpeg',
      encoding: 'base64',
      data_base64: 'AQID',
      bytes: 3,
    });
    assertEquals(JSON.stringify(body).includes('Hello from xAI TTS.'), false);
  } finally {
    disableTtsProvider();
  }
});

Deno.test('maps xAI TTS provider failures without echoing provider response bodies', async () => {
  try {
    enableTtsProvider();
    const fetchStub: typeof fetch = () => Promise.resolve(new Response('provider-secret-detail', { status: 500 }));

    const response = await handleEveMultimodal(
      request({
        provider: 'xai',
        capability: 'tts',
        privacyLane: 'cloud_us',
        directProviderKeyPresentInDesktop: false,
        text: 'Hello.',
      }),
      { fetch: fetchStub }
    );
    const body = await response.json();

    assertEquals(response.status, 502);
    assertEquals(body.reason, 'provider-error');
    assertEquals(JSON.stringify(body).includes('provider-secret-detail'), false);
  } finally {
    disableTtsProvider();
  }
});

Deno.test('rejects HTTP 200 provider responses with non-audio content type', async () => {
  try {
    enableTtsProvider();
    const fetchStub: typeof fetch = () =>
      Promise.resolve(
        new Response(JSON.stringify({ error: 'provider detail' }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        })
      );

    const response = await handleEveMultimodal(
      request({
        provider: 'xai',
        capability: 'tts',
        privacyLane: 'cloud_us',
        directProviderKeyPresentInDesktop: false,
        text: 'Hello.',
      }),
      { fetch: fetchStub }
    );
    const body = await response.json();

    assertEquals(response.status, 502);
    assertEquals(body.reason, 'provider-error');
    assertEquals(JSON.stringify(body).includes('provider detail'), false);
  } finally {
    disableTtsProvider();
  }
});

Deno.test('rejects HTTP 200 provider responses with missing content type', async () => {
  try {
    enableTtsProvider();
    const fetchStub: typeof fetch = () =>
      Promise.resolve(
        new Response(new Uint8Array([1, 2, 3]), {
          status: 200,
        })
      );

    const response = await handleEveMultimodal(
      request({
        provider: 'xai',
        capability: 'tts',
        privacyLane: 'cloud_us',
        directProviderKeyPresentInDesktop: false,
        text: 'Hello.',
      }),
      { fetch: fetchStub }
    );
    const body = await response.json();

    assertEquals(response.status, 502);
    assertEquals(body.reason, 'provider-error');
  } finally {
    disableTtsProvider();
  }
});

Deno.test('rejects empty TTS audio bodies', async () => {
  try {
    enableTtsProvider();
    const fetchStub: typeof fetch = () =>
      Promise.resolve(
        new Response(new Uint8Array(), {
          status: 200,
          headers: { 'content-type': 'audio/mpeg' },
        })
      );

    const response = await handleEveMultimodal(
      request({
        provider: 'xai',
        capability: 'tts',
        privacyLane: 'cloud_us',
        directProviderKeyPresentInDesktop: false,
        text: 'Hello.',
      }),
      { fetch: fetchStub }
    );
    const body = await response.json();

    assertEquals(response.status, 502);
    assertEquals(body.reason, 'provider-empty-audio');
  } finally {
    disableTtsProvider();
  }
});

Deno.test('rejects oversized TTS audio bodies', async () => {
  try {
    enableTtsProvider();
    const fetchStub: typeof fetch = () =>
      Promise.resolve(
        new Response(new Uint8Array(10 * 1024 * 1024 + 1), {
          status: 200,
          headers: { 'content-type': 'audio/mpeg' },
        })
      );

    const response = await handleEveMultimodal(
      request({
        provider: 'xai',
        capability: 'tts',
        privacyLane: 'cloud_us',
        directProviderKeyPresentInDesktop: false,
        text: 'Hello.',
      }),
      { fetch: fetchStub }
    );
    const body = await response.json();

    assertEquals(response.status, 502);
    assertEquals(body.reason, 'provider-audio-too-large');
  } finally {
    disableTtsProvider();
  }
});

Deno.test('times out slow TTS provider requests', async () => {
  try {
    enableTtsProvider();
    Deno.env.set('EVE_MULTIMODAL_TTS_TIMEOUT_MS', '1');
    const fetchStub: typeof fetch = (_input, init) =>
      new Promise((_resolve, reject) => {
        observedFetchInit(init).signal?.addEventListener('abort', () => {
          reject(new DOMException('aborted', 'AbortError'));
        });
      });

    const response = await handleEveMultimodal(
      request({
        provider: 'xai',
        capability: 'tts',
        privacyLane: 'cloud_us',
        directProviderKeyPresentInDesktop: false,
        text: 'Hello.',
      }),
      { fetch: fetchStub }
    );
    const body = await response.json();

    assertEquals(response.status, 504);
    assertEquals(body.reason, 'provider-timeout');
  } finally {
    disableTtsProvider();
  }
});

Deno.test('keeps OpenRouter PDF OCR provider-disabled until the server gate is enabled', async () => {
  try {
    disablePdfOcrProvider();
    let fetchCalls = 0;
    const response = await handleEveMultimodal(request(pdfRequestBody()), {
      fetch: () => {
        fetchCalls += 1;
        return Promise.resolve(new Response('{}'));
      },
    });
    const body = await response.json();

    assertEquals(fetchCalls, 0);
    assertEquals(response.status, 501);
    assertEquals(body.reason, 'provider-not-enabled');
    assertEquals(body.provider, 'openrouter');
  } finally {
    disablePdfOcrProvider();
  }
});

Deno.test('requires an OpenRouter key only on the server before PDF OCR can run', async () => {
  try {
    Deno.env.set('EVE_MULTIMODAL_ENABLE_OPENROUTER_PDF_OCR', 'true');
    Deno.env.delete('OPENROUTER_API_KEY');
    const response = await handleEveMultimodal(request(pdfRequestBody()));
    const body = await response.json();

    assertEquals(response.status, 503);
    assertEquals(body.reason, 'provider-not-configured');
    assertEquals(body.provider, 'openrouter');
  } finally {
    disablePdfOcrProvider();
  }
});

Deno.test('calls OpenRouter PDF OCR with ZDR and returns page-cited markdown without echoing PDF bytes', async () => {
  try {
    enablePdfOcrProvider();
    const inputBody = pdfRequestBody();
    let fetchCalls = 0;
    const fetchStub: typeof fetch = (input, init) => {
      fetchCalls += 1;
      const observed = observedFetchInit(init);
      const headers = observed.headers ?? {};
      const payload = JSON.parse(String(observed.body));

      assertEquals(String(input), 'https://openrouter.ai/api/v1/chat/completions');
      assertEquals(headers.Authorization, 'Bearer test-openrouter-key');
      assertEquals(payload.model, 'google/gemini-2.5-flash');
      assertEquals(payload.provider, { zdr: true, data_collection: 'deny' });
      assertEquals(payload.plugins, [
        {
          id: 'file-parser',
          pdf: { engine: 'mistral-ocr' },
        },
      ]);
      assertEquals(payload.messages[0].content[1].type, 'file');
      assertEquals(payload.messages[0].content[1].file.filename, 'meeting.pdf');
      assertEquals(
        payload.messages[0].content[1].file.file_data,
        `data:application/pdf;base64,${inputBody.file_data_base64}`
      );

      return Promise.resolve(
        new Response(
          JSON.stringify({
            choices: [
              {
                message: {
                  content: '## Page 1\n\nAlpha\n\n## Page 2\n\nBeta',
                  annotations: [
                    {
                      type: 'file',
                      file: {
                        hash: 'openrouter-file-hash',
                        name: 'meeting.pdf',
                        content: [],
                      },
                    },
                  ],
                },
              },
            ],
          }),
          { status: 200, headers: { 'content-type': 'application/json' } }
        )
      );
    };

    let usageGateCalls = 0;
    const response = await handleEveMultimodal(request(inputBody), {
      fetch: fetchStub,
      reservePdfOcrUsage: (input) => {
        usageGateCalls += 1;
        assertEquals(input.tenantId, '00000000-0000-4000-8000-000000000001');
        assertEquals(input.pages, 2);
        assertEquals(input.tenantCap, 500);
        assertEquals(input.globalCap, 10_000);
        assertEquals(/^[a-f0-9]{64}$/.test(input.requestFingerprint), true);
        return allowPdfOcrUsage();
      },
    });
    const body = await response.json();

    assertEquals(fetchCalls, 1);
    assertEquals(usageGateCalls, 1);
    assertEquals(response.status, 200);
    assertEquals(body.ok, true);
    assertEquals(body.provider, 'openrouter');
    assertEquals(body.artifact.text, '## Page 1\n\nAlpha\n\n## Page 2\n\nBeta');
    assertEquals(body.document, {
      engine: 'mistral-ocr',
      model: 'google/gemini-2.5-flash',
      page_count: 2,
      parsed_file_hash: 'openrouter-file-hash',
      zdr_enforced: true,
      data_collection: 'deny',
    });
    assertEquals(body.residency.confirmation, 'zdr-enforced-global');
    assertEquals(body.usage, {
      metering: 'daily-page-cap',
      pages_reserved: 2,
      tenant_pages_used_today: 2,
      tenant_page_cap: 500,
      global_pages_used_today: 2,
      global_page_cap: 10_000,
    });
    assertEquals(JSON.stringify(body).includes(String(inputBody.file_data_base64)), false);
    assertEquals(JSON.stringify(body).includes('test-openrouter-key'), false);
  } finally {
    disablePdfOcrProvider();
  }
});

Deno.test('rejects a mismatched PDF hash before calling OpenRouter', async () => {
  try {
    enablePdfOcrProvider();
    let fetchCalls = 0;
    const response = await handleEveMultimodal(request(pdfRequestBody({ file_sha256: '0'.repeat(64) })), {
      fetch: () => {
        fetchCalls += 1;
        return Promise.resolve(new Response('{}'));
      },
    });
    const body = await response.json();

    assertEquals(fetchCalls, 0);
    assertEquals(response.status, 400);
    assertEquals(body.reason, 'pdf-sha256-mismatch');
  } finally {
    disablePdfOcrProvider();
  }
});

Deno.test('GPT Image 2 reference input reaches the OpenRouter provider request as input_references', async () => {
  const referenceBytes = new TextEncoder().encode('gpt-image-2-reference');
  const referenceBase64 = btoa(String.fromCharCode(...referenceBytes));
  const referenceSha256 = crypto.createHash('sha256').update(referenceBytes).digest('hex');
  const input = extractEveImageGenerationInput({
    prompt: 'Keep the composition and replace the background with a studio wall.',
    aspect_ratio: '1:1',
    resolution: '1K',
    image_model: 'max',
    input_references: [
      {
        mime_type: 'image/png',
        sha256: referenceSha256,
        data_base64: referenceBase64,
      },
    ],
  });
  const imageModel = resolveImageGenerationModel('max');
  assertEquals(input?.imageModel.providerSlug, 'openai/gpt-image-2');
  assertEquals(imageModel?.supportsReferenceImages, true);

  const reserved = await reserveBillableOperation({
    port: {
      commit: (commitInput) =>
        Promise.resolve({
          status: 'applied' as const,
          entitlementId: TEST_ENTITLEMENT_ID,
          externalRef: commitInput.externalRef,
        }),
      reverse: () => Promise.resolve({ ok: true }),
    },
    operationId: 'multimodal.image_generation',
    tenantId: '00000000-0000-4000-8000-000000000001',
    externalRef: 'image:gpt-image-2-reference-probe',
    model: 'openai/gpt-image-2',
    boundUnits: 1,
    explicitBoundRetailEurCents: 230,
  });
  if (reserved.status !== 'reserved' || !input) {
    throw new Error(`probe setup failed: reserve=${reserved.status}, input=${input ? 'parsed' : 'refused'}`);
  }

  const observedProvider = { body: null as Record<string, unknown> | null };
  const generatedBytes = new TextEncoder().encode('generated-image');
  const generated = await callOpenRouterImageGeneration({
    apiKey: 'test-openrouter-key',
    input,
    timeoutMs: 1_000,
    receipt: reserved.receipt,
    fetchFn: (_url, init) => {
      observedProvider.body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      return Promise.resolve(
        new Response(
          JSON.stringify({
            data: [
              {
                b64_json: btoa(String.fromCharCode(...generatedBytes)),
                media_type: 'image/png',
              },
            ],
            usage: { cost: 0.01 },
          }),
          { status: 200 }
        )
      );
    },
  });

  assertEquals(generated.ok, true);
  assertEquals(observedProvider.body?.model, 'openai/gpt-image-2');
  assertEquals(observedProvider.body?.input_references, [
    {
      type: 'image_url',
      image_url: {
        url: `data:image/png;base64,${referenceBase64}`,
      },
    },
  ]);
});

Deno.test('fails closed when OpenRouter omits trustworthy physical page boundaries', async () => {
  try {
    enablePdfOcrProvider();
    const fetchStub: typeof fetch = () =>
      Promise.resolve(
        new Response(
          JSON.stringify({
            choices: [
              {
                message: { content: 'This response has no page boundaries.' },
              },
            ],
            provider_debug: 'must-not-leak',
          }),
          { status: 200, headers: { 'content-type': 'application/json' } }
        )
      );

    const response = await handleEveMultimodal(request(pdfRequestBody()), {
      fetch: fetchStub,
      reservePdfOcrUsage: allowPdfOcrUsage,
    });
    const body = await response.json();

    assertEquals(response.status, 502);
    assertEquals(body.reason, 'provider-page-boundaries-unavailable');
    assertEquals(JSON.stringify(body).includes('must-not-leak'), false);
  } finally {
    disablePdfOcrProvider();
  }
});

Deno.test('blocks PDF OCR before provider egress when the daily page gate is exhausted', async () => {
  try {
    enablePdfOcrProvider();
    let fetchCalls = 0;
    const response = await handleEveMultimodal(request(pdfRequestBody()), {
      fetch: () => {
        fetchCalls += 1;
        return Promise.resolve(new Response('{}'));
      },
      reservePdfOcrUsage: () =>
        Promise.resolve({
          ok: true,
          allowed: false,
          reason: 'tenant-daily-cap',
          tenantUnits: 500,
          tenantCap: 500,
          globalUnits: 900,
          globalCap: 10_000,
          replayed: false,
        }),
    });
    const body = await response.json();

    assertEquals(fetchCalls, 0);
    assertEquals(response.status, 429);
    assertEquals(body.reason, 'pdf-ocr-daily-cap');
  } finally {
    disablePdfOcrProvider();
  }
});

Deno.test('rejects a replayed PDF OCR reservation before a second provider call', async () => {
  try {
    enablePdfOcrProvider();
    let fetchCalls = 0;
    const response = await handleEveMultimodal(request(pdfRequestBody()), {
      fetch: () => {
        fetchCalls += 1;
        return Promise.resolve(new Response('{}'));
      },
      reservePdfOcrUsage: () =>
        Promise.resolve({
          ok: true,
          allowed: false,
          reason: 'request-replayed',
          tenantUnits: 2,
          tenantCap: 500,
          globalUnits: 2,
          globalCap: 10_000,
          replayed: true,
        }),
    });
    const body = await response.json();

    assertEquals(fetchCalls, 0);
    assertEquals(response.status, 409);
    assertEquals(body.reason, 'request-replayed');
  } finally {
    disablePdfOcrProvider();
  }
});

Deno.test('video edit provider wire is exactly model, prompt and video', () => {
  const sourceDataUrl = `data:video/mp4;base64,${VIDEO_EDIT_MP4_BASE64}`;
  const body = buildXaiVideoEditBody({
    model: 'grok-imagine-video',
    prompt: VIDEO_EDIT_PROMPT,
    sourceDataUrl,
  });

  assertEquals(Object.keys(body).toSorted(), ['model', 'prompt', 'video']);
  assertEquals(body, {
    model: 'grok-imagine-video',
    prompt: VIDEO_EDIT_PROMPT,
    video: { url: sourceDataUrl },
  });
  assertEquals(Object.keys(body.video as Record<string, unknown>).toSorted(), ['url']);
});

Deno.test('video edit idempotency includes source SHA but not arrival path', () => {
  const identity = {
    tenantId: '00000000-0000-4000-8000-000000000001',
    promptSha256: videoPromptSha256(VIDEO_EDIT_PROMPT),
    tierId: 'fast' as const,
    sourceSha256: VIDEO_EDIT_MP4_SHA256,
  };
  const costWallRef = videoEditDebitExternalRef(identity);
  const hermesToolRef = videoEditDebitExternalRef(identity);
  const otherSourceRef = videoEditDebitExternalRef({ ...identity, sourceSha256: 'f'.repeat(64) });

  assertEquals(costWallRef, hermesToolRef);
  assertEquals(costWallRef === otherSourceRef, false);
});

Deno.test('video edit refuses a source over 8.7 seconds before debit, usage or provider', async () => {
  try {
    enableVideoEditProvider();
    let debitCalls = 0;
    let usageCalls = 0;
    let fetchCalls = 0;
    let reversalCalls = 0;

    const response = await handleEveMultimodal(request(videoEditRequestBody(8.7001)), {
      commitVideoDebit: () => {
        debitCalls += 1;
        throw new Error('over-ceiling source reached debit');
      },
      reservePdfOcrUsage: () => {
        usageCalls += 1;
        throw new Error('over-ceiling source reached usage accounting');
      },
      fetch: () => {
        fetchCalls += 1;
        throw new Error('over-ceiling source reached provider');
      },
      reverseVideoDebit: () => {
        reversalCalls += 1;
        return Promise.resolve({ ok: true });
      },
    });
    const body = await response.json();

    assertEquals(response.status, 400);
    assertEquals(body.reason, 'video-edit-request-invalid');
    assertEquals(debitCalls, 0);
    assertEquals(usageCalls, 0);
    assertEquals(fetchCalls, 0);
    assertEquals(reversalCalls, 0);
  } finally {
    disableVideoEditProvider();
  }
});

Deno.test('dual video edit arrivals apply one debit and make one provider call', async () => {
  try {
    enableVideoEditProvider();
    const debitRefs: string[] = [];
    const appliedRefs = new Set<string>();
    let appliedDebits = 0;
    let usageCalls = 0;
    let providerCalls = 0;
    let reversalCalls = 0;
    let providerEntered!: () => void;
    let releaseProvider!: () => void;
    const providerEnteredPromise = new Promise<void>((resolve) => {
      providerEntered = resolve;
    });
    const providerReleasePromise = new Promise<void>((resolve) => {
      releaseProvider = resolve;
    });

    const deps: HandlerDeps = {
      commitVideoDebit: (input) => {
        debitRefs.push(input.externalRef);
        if (appliedRefs.has(input.externalRef)) {
          return Promise.resolve({
            status: 'already' as const,
            entitlementId: input.expectedEntitlementId ?? TEST_ENTITLEMENT_ID,
            externalRef: input.externalRef,
          });
        }
        appliedRefs.add(input.externalRef);
        appliedDebits += 1;
        return Promise.resolve({
          status: 'applied' as const,
          entitlementId: input.expectedEntitlementId ?? TEST_ENTITLEMENT_ID,
          externalRef: input.externalRef,
          fromAllowance: 1200,
          fromPurchased: 0,
        });
      },
      reverseVideoDebit: () => {
        reversalCalls += 1;
        return Promise.resolve({ ok: true });
      },
      reservePdfOcrUsage: () => {
        usageCalls += 1;
        return allowPdfOcrUsage();
      },
      fetch: async (input, init) => {
        providerCalls += 1;
        assertEquals(String(input), 'https://api.x.ai/v1/videos/edits');
        const providerBody = JSON.parse(String(observedFetchInit(init).body));
        assertEquals(Object.keys(providerBody).toSorted(), ['model', 'prompt', 'video']);
        assertEquals(providerBody, {
          model: 'grok-imagine-video',
          prompt: VIDEO_EDIT_PROMPT,
          video: { url: `data:video/mp4;base64,${VIDEO_EDIT_MP4_BASE64}` },
        });
        providerEntered();
        await providerReleasePromise;
        return new Response('synthetic provider failure', { status: 503 });
      },
    };

    const firstResponsePromise = handleEveMultimodal(request(videoEditRequestBody(8.7, 'video-edit-cost-wall')), deps);
    await providerEnteredPromise;

    const secondResponse = await handleEveMultimodal(
      request(videoEditRequestBody(8.7, 'video-edit-hermes-tool')),
      deps
    );
    const secondBody = await secondResponse.json();
    const expectedDebitRef = videoEditDebitExternalRef({
      tenantId: '00000000-0000-4000-8000-000000000001',
      promptSha256: videoPromptSha256(VIDEO_EDIT_PROMPT),
      tierId: 'fast',
      sourceSha256: VIDEO_EDIT_MP4_SHA256,
    });

    assertEquals(secondResponse.status, 409);
    assertEquals(secondBody.reason, 'request-replayed');
    assertEquals(debitRefs, [expectedDebitRef, expectedDebitRef]);
    assertEquals(appliedDebits, 1);
    assertEquals(usageCalls, 1);
    assertEquals(providerCalls, 1);
    assertEquals(reversalCalls, 0);

    releaseProvider();
    const firstResponse = await firstResponsePromise;
    const firstBody = await firstResponse.json();
    assertEquals(firstResponse.status, 502);
    assertEquals(firstBody.reason, 'provider-error');
    assertEquals(reversalCalls, 1);
    assertEquals(providerCalls, 1);
  } finally {
    disableVideoEditProvider();
  }
});

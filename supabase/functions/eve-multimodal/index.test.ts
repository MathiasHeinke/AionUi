// Command EVE — eve-multimodal Edge Function handler tests.
//
// Run: deno test --allow-env supabase/functions/eve-multimodal/index.test.ts

import { assertEquals } from 'jsr:@std/assert@1';
import crypto from 'node:crypto';
import { buildLicensePayloadV2, signLicenseCode } from '../_shared/license-code-core.ts';
import { handleEveMultimodal, resetEveMultimodalPublicKeyCacheForTests } from './index.ts';

const NOWISH = '2026-07-07T12:00:00.000Z';
let testSigningKeyPem: string | null = null;

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
    tenant_serial: 'tenant-1',
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

Deno.test('answers CORS preflight without license verification', async () => {
  const response = await handleEveMultimodal(
    new Request('https://example.supabase.co/functions/v1/eve-multimodal', {
      method: 'OPTIONS',
      headers: { origin: 'http://localhost:5173' },
    })
  );

  assertEquals(response.status, 204);
  assertEquals(response.headers.get('Access-Control-Allow-Origin'), 'http://localhost:5173');
  assertEquals(response.headers.get('Access-Control-Allow-Methods'), 'POST, OPTIONS');
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
      const payload = JSON.parse(String(init?.body));
      const headers = init?.headers as Record<string, string>;

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
        init?.signal?.addEventListener('abort', () => {
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

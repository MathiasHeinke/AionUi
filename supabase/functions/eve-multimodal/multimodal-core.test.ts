// Command EVE — eve-multimodal gateway core tests.
//
// Run: deno test supabase/functions/eve-multimodal/multimodal-core.test.ts

import { assertEquals } from 'jsr:@std/assert@1';
import crypto from 'node:crypto';
import { decideEveMultimodalSkeletonRequest } from './multimodal-core.ts';

const NOW = '2026-07-07T12:00:00.000Z';

function decide(body: unknown) {
  return decideEveMultimodalSkeletonRequest({
    body,
    now: NOW,
    requestId: 'req_test',
  });
}

function pdfBody(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  const bytes = new TextEncoder().encode('%PDF-1.7\n1 0 obj\n<<>>\nendobj\n%%EOF');
  return {
    provider: 'openrouter',
    capability: 'document_ocr',
    privacyLane: 'cloud_auto',
    directProviderKeyPresentInDesktop: false,
    file_name: 'scan.pdf',
    file_sha256: crypto.createHash('sha256').update(bytes).digest('hex'),
    file_data_base64: btoa(String.fromCharCode(...bytes)),
    page_count: 2,
    ...overrides,
  };
}

Deno.test('rejects non-object request bodies', () => {
  const result = decide(null);

  assertEquals(result.status, 400);
  assertEquals(result.body.reason, 'invalid-request');
});

Deno.test('rejects provider key fields anywhere in the request body', () => {
  const result = decide({
    provider: 'xai',
    capability: 'tts',
    privacyLane: 'cloud_us',
    directProviderKeyPresentInDesktop: false,
    metadata: { xai_api_key: 'redacted' },
  });

  assertEquals(result.status, 400);
  assertEquals(result.body.reason, 'provider-key-field');
});

Deno.test('rejects provider key fields regardless of casing or separator style', () => {
  const result = decide({
    provider: 'xai',
    capability: 'tts',
    privacyLane: 'cloud_us',
    directProviderKeyPresentInDesktop: false,
    metadata: { XAI_API_KEY: 'redacted', 'openrouter-api-key': 'redacted' },
  });

  assertEquals(result.status, 400);
  assertEquals(result.body.reason, 'provider-key-field');
});

Deno.test('requires explicit no-desktop-provider-key attestation', () => {
  const result = decide({
    provider: 'xai',
    capability: 'tts',
    privacyLane: 'cloud_us',
  });

  assertEquals(result.status, 400);
  assertEquals(result.body.reason, 'desktop-provider-key-present');
});

Deno.test('rejects explicit desktop provider key presence', () => {
  const result = decide({
    provider: 'xai',
    capability: 'tts',
    privacyLane: 'cloud_us',
    directProviderKeyPresentInDesktop: true,
  });

  assertEquals(result.status, 400);
  assertEquals(result.body.reason, 'desktop-provider-key-present');
});

Deno.test('rejects unsupported providers and capabilities', () => {
  const result = decide({
    provider: 'openrouter',
    capability: 'tts',
    privacyLane: 'cloud_us',
    directProviderKeyPresentInDesktop: false,
  });

  assertEquals(result.status, 400);
  assertEquals(result.body.reason, 'unsupported-capability');
});

Deno.test('rejects present but invalid privacy lanes instead of defaulting to cloud_auto', () => {
  const result = decide({
    provider: 'xai',
    capability: 'tts',
    privacyLane: 'cloud_china',
    directProviderKeyPresentInDesktop: false,
  });

  assertEquals(result.status, 400);
  assertEquals(result.body.reason, 'invalid-request');
});

Deno.test('validates TTS text before provider enablement', () => {
  const result = decide({
    provider: 'xai',
    capability: 'tts',
    privacyLane: 'cloud_us',
    directProviderKeyPresentInDesktop: false,
  });

  assertEquals(result.status, 400);
  assertEquals(result.body.reason, 'invalid-request');
});

Deno.test('caps TTS text at 15000 characters', () => {
  const result = decide({
    provider: 'xai',
    capability: 'tts',
    privacyLane: 'cloud_us',
    directProviderKeyPresentInDesktop: false,
    text: 'x'.repeat(15_001),
  });

  assertEquals(result.status, 400);
  assertEquals(result.body.reason, 'invalid-request');
});

Deno.test('returns a TTS receipt without echoing prompt text', () => {
  const result = decide({
    provider: 'xai',
    capability: 'tts',
    privacyLane: 'cloud_us',
    directProviderKeyPresentInDesktop: false,
    text: 'hello',
    voice_id: 'eve',
    language: 'en',
  });

  assertEquals(result.status, 501);
  assertEquals(result.body.reason, 'provider-not-enabled');
  assertEquals(result.body.tts?.voice_id, 'eve');
  assertEquals(result.body.tts?.language, 'en');
  assertEquals(result.body.tts?.text_length, 5);
  assertEquals(JSON.stringify(result.body).includes('hello'), false);
});

Deno.test('blocks local-only privacy before provider execution', () => {
  const result = decide({
    provider: 'xai',
    capability: 'video_generation',
    privacyLane: 'local_only',
    directProviderKeyPresentInDesktop: false,
  });

  assertEquals(result.status, 403);
  assertEquals(result.body.reason, 'local-only-privacy');
  assertEquals(result.body.artifact?.kind, 'video');
});

Deno.test('blocks EU and DE residency lanes until matching provider routes exist', () => {
  for (const privacyLane of ['cloud_eu', 'cloud_de']) {
    const result = decide({
      provider: 'xai',
      capability: 'vision',
      privacyLane,
      directProviderKeyPresentInDesktop: false,
    });

    assertEquals(result.status, 403);
    assertEquals(result.body.reason, 'residency-unavailable');
    assertEquals(result.body.artifact?.kind, 'text');
  }
});

Deno.test('returns provider-not-enabled with a US residency receipt for cloud_us', () => {
  const result = decide({
    provider: 'xai',
    capability: 'tts',
    privacyLane: 'cloud_us',
    directProviderKeyPresentInDesktop: false,
    text: 'Hello',
  });

  assertEquals(result.status, 501);
  assertEquals(result.body.reason, 'provider-not-enabled');
  assertEquals(result.body.residency?.confirmation, 'explicit-us-cloud');
  assertEquals(result.body.artifact?.kind, 'audio');
});

Deno.test('requires server confirmation semantics for cloud_auto', () => {
  const result = decide({
    provider: 'xai',
    capability: 'image_generation',
    privacyLane: 'cloud_auto',
    directProviderKeyPresentInDesktop: false,
  });

  assertEquals(result.status, 501);
  assertEquals(result.body.reason, 'provider-not-enabled');
  assertEquals(result.body.residency?.confirmation, 'server-must-confirm-us-cloud');
  assertEquals(result.body.artifact?.kind, 'image');
});

Deno.test('returns a bounded OpenRouter PDF receipt without echoing document bytes', () => {
  const requestBody = pdfBody();
  const result = decide(requestBody);

  assertEquals(result.status, 501);
  assertEquals(result.body.provider, 'openrouter');
  assertEquals(result.body.capability, 'document_ocr');
  assertEquals(result.body.reason, 'provider-not-enabled');
  assertEquals(result.body.residency, {
    requestedPrivacyLane: 'cloud_auto',
    effectiveResidency: 'global_cloud',
    confirmation: 'zdr-enforced-global',
  });
  assertEquals(result.body.document?.engine, 'mistral-ocr');
  assertEquals(result.body.document?.page_count, 2);
  assertEquals(result.body.document?.input_bytes, 34);
  assertEquals(JSON.stringify(result.body).includes(String(requestBody.file_data_base64)), false);
});

Deno.test('blocks every residency claim for OpenRouter PDF OCR except explicit global cloud_auto', () => {
  for (const privacyLane of ['local_only', 'cloud_us', 'cloud_eu', 'cloud_de']) {
    const result = decide(pdfBody({ privacyLane }));

    assertEquals(result.status, 403);
    assertEquals(result.body.provider, 'openrouter');
    assertEquals(result.body.reason, privacyLane === 'local_only' ? 'local-only-privacy' : 'residency-unavailable');
  }
});

Deno.test('rejects malformed PDF envelopes before provider execution', () => {
  for (const override of [
    { file_name: '../scan.txt' },
    { file_sha256: 'not-a-hash' },
    { file_data_base64: btoa('not a pdf') },
    { page_count: 0 },
    { page_count: 501 },
  ]) {
    const result = decide(pdfBody(override));
    assertEquals(result.status, 400);
    assertEquals(result.body.reason, 'invalid-request');
  }
});

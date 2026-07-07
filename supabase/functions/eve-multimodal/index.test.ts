// Command EVE — eve-multimodal Edge Function handler tests.
//
// Run: deno test --allow-env supabase/functions/eve-multimodal/index.test.ts

import { assertEquals } from "jsr:@std/assert@1";
import crypto from "node:crypto";
import {
  buildLicensePayloadV2,
  signLicenseCode,
} from "../_shared/license-code-core.ts";
import {
  handleEveMultimodal,
  resetEveMultimodalPublicKeyCacheForTests,
} from "./index.ts";

const NOWISH = "2026-07-07T12:00:00.000Z";
let testSigningKeyPem: string | null = null;

function installSigningKey(): string {
  if (testSigningKeyPem) {
    Deno.env.set("COMMAND_EVE_LICENSE_SIGNING_KEY", testSigningKeyPem);
    resetEveMultimodalPublicKeyCacheForTests();
    return testSigningKeyPem;
  }
  const { privateKey } = crypto.generateKeyPairSync("ed25519");
  const signingKeyPem = privateKey.export({
    type: "pkcs8",
    format: "pem",
  }) as string;
  Deno.env.set("COMMAND_EVE_LICENSE_SIGNING_KEY", signingKeyPem);
  resetEveMultimodalPublicKeyCacheForTests();
  testSigningKeyPem = signingKeyPem;
  return signingKeyPem;
}

function licenseWire(
  expiresAt: string | null = "2027-07-07T00:00:00.000Z",
): string {
  const signingKeyPem = installSigningKey();
  const payload = buildLicensePayloadV2({
    edition: "standard",
    serial: "code-1",
    tenant_serial: "tenant-1",
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
  return new Request(
    "https://example.supabase.co/functions/v1/eve-multimodal",
    {
      method: "POST",
      headers: {
        authorization: `Bearer ${wire}`,
        "content-type": "application/json",
      },
      body: JSON.stringify(body),
    },
  );
}

Deno.test("answers CORS preflight without license verification", async () => {
  const response = await handleEveMultimodal(
    new Request("https://example.supabase.co/functions/v1/eve-multimodal", {
      method: "OPTIONS",
      headers: { origin: "http://localhost:5173" },
    }),
  );

  assertEquals(response.status, 204);
  assertEquals(
    response.headers.get("Access-Control-Allow-Origin"),
    "http://localhost:5173",
  );
  assertEquals(
    response.headers.get("Access-Control-Allow-Methods"),
    "POST, OPTIONS",
  );
  assertEquals(
    response.headers.get("Access-Control-Allow-Headers"),
    "authorization, content-type, apikey, x-client-info",
  );
});

Deno.test("does not reflect disallowed CORS origins", async () => {
  const response = await handleEveMultimodal(
    new Request("https://example.supabase.co/functions/v1/eve-multimodal", {
      method: "OPTIONS",
      headers: { origin: "https://evil.example" },
    }),
  );

  assertEquals(response.status, 204);
  assertEquals(response.headers.get("Access-Control-Allow-Origin"), "null");
});

Deno.test("rejects non-POST methods", async () => {
  const response = await handleEveMultimodal(
    new Request("https://example.supabase.co/functions/v1/eve-multimodal", {
      method: "GET",
    }),
  );
  const body = await response.json();

  assertEquals(response.status, 405);
  assertEquals(body.reason, "method-not-allowed");
});

Deno.test("requires a CEVE license bearer", async () => {
  const response = await handleEveMultimodal(
    new Request("https://example.supabase.co/functions/v1/eve-multimodal", {
      method: "POST",
      body: JSON.stringify({ capability: "tts" }),
    }),
  );
  const body = await response.json();

  assertEquals(response.status, 401);
  assertEquals(body.reason, "missing-license");
});

Deno.test("fails closed when license verification is not configured", async () => {
  Deno.env.delete("COMMAND_EVE_LICENSE_SIGNING_KEY");
  resetEveMultimodalPublicKeyCacheForTests();
  const response = await handleEveMultimodal(
    new Request("https://example.supabase.co/functions/v1/eve-multimodal", {
      method: "POST",
      headers: { authorization: "Bearer CEVE.fake.fake.fake" },
      body: JSON.stringify({ capability: "tts" }),
    }),
  );
  const body = await response.json();

  assertEquals(response.status, 503);
  assertEquals(body.reason, "server-not-configured");
});

Deno.test("rejects expired license bearers conclusively", async () => {
  const expiredWire = licenseWire("2026-01-01T00:00:00.000Z");
  const response = await handleEveMultimodal(
    request({
      provider: "xai",
      capability: "tts",
      privacyLane: "cloud_us",
      directProviderKeyPresentInDesktop: false,
    }, expiredWire),
  );
  const body = await response.json();

  assertEquals(response.status, 403);
  assertEquals(body.reason, "license-expired");
});

Deno.test("rejects invalid JSON bodies after license verification", async () => {
  const response = await handleEveMultimodal(
    new Request("https://example.supabase.co/functions/v1/eve-multimodal", {
      method: "POST",
      headers: {
        authorization: `Bearer ${licenseWire()}`,
        "content-type": "application/json",
      },
      body: "{",
    }),
  );
  const body = await response.json();

  assertEquals(response.status, 400);
  assertEquals(body.reason, "invalid-json");
});

Deno.test("verifies license auth but still refuses provider execution in the skeleton", async () => {
  const response = await handleEveMultimodal(
    request({
      provider: "xai",
      capability: "tts",
      privacyLane: "cloud_us",
      directProviderKeyPresentInDesktop: false,
      requestId: "req_handler",
    }),
  );
  const body = await response.json();

  assertEquals(response.status, 501);
  assertEquals(body.reason, "provider-not-enabled");
  assertEquals(body.request_id, "req_handler");
  assertEquals(body.license.verified, true);
  assertEquals(body.license.edition, "standard");
  assertEquals(body.artifact.kind, "audio");
});

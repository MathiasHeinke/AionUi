// Command EVE - eve-title Edge Function handler tests.
//
// Run: deno test --allow-env supabase/functions/eve-title/index.test.ts

import { assertEquals } from "jsr:@std/assert@1";
import crypto from "node:crypto";
import {
  buildLicensePayloadV2,
  signLicenseCode,
} from "../_shared/license-code-core.ts";
import {
  handleEveTitle,
  resetEveTitlePublicKeyCacheForTests,
} from "./index.ts";

const NOWISH = "2026-07-08T00:00:00.000Z";
let testSigningKeyPem: string | null = null;

function installSigningKey(): string {
  if (testSigningKeyPem) {
    Deno.env.set("COMMAND_EVE_LICENSE_SIGNING_KEY", testSigningKeyPem);
    resetEveTitlePublicKeyCacheForTests();
    return testSigningKeyPem;
  }
  const { privateKey } = crypto.generateKeyPairSync("ed25519");
  const signingKeyPem = privateKey.export({
    type: "pkcs8",
    format: "pem",
  }) as string;
  Deno.env.set("COMMAND_EVE_LICENSE_SIGNING_KEY", signingKeyPem);
  resetEveTitlePublicKeyCacheForTests();
  testSigningKeyPem = signingKeyPem;
  return signingKeyPem;
}

function licenseWire(
  expiresAt: string | null = "2027-07-08T00:00:00.000Z",
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
  if (!payload.ok) throw new Error(`payload failed: ${payload.reason_code}`);
  return signLicenseCode({
    payload: payload.payload,
    privateKeyPem: signingKeyPem,
  });
}

function request(body: unknown, wire = licenseWire()): Request {
  return new Request("https://example.supabase.co/functions/v1/eve-title", {
    method: "POST",
    headers: {
      authorization: `Bearer ${wire}`,
      "content-type": "application/json",
    },
    body: JSON.stringify(body),
  });
}

function disableProvider(): void {
  Deno.env.delete("OPENROUTER_API_KEY");
  Deno.env.delete("EVE_TITLE_OPENROUTER_MODEL");
  Deno.env.delete("EVE_TITLE_OPENROUTER_TIMEOUT_MS");
}

function enableProvider(apiKey = "test-openrouter-key"): void {
  Deno.env.set("OPENROUTER_API_KEY", apiKey);
}

Deno.test("answers CORS preflight without license verification", async () => {
  const response = await handleEveTitle(
    new Request("https://example.supabase.co/functions/v1/eve-title", {
      method: "OPTIONS",
      headers: { origin: "http://localhost:5173" },
    }),
  );

  assertEquals(response.status, 204);
  assertEquals(
    response.headers.get("Access-Control-Allow-Origin"),
    "http://localhost:5173",
  );
});

Deno.test("does not reflect disallowed CORS origins", async () => {
  const response = await handleEveTitle(
    new Request("https://example.supabase.co/functions/v1/eve-title", {
      method: "OPTIONS",
      headers: { origin: "https://evil.example" },
    }),
  );

  assertEquals(response.status, 204);
  assertEquals(response.headers.get("Access-Control-Allow-Origin"), "null");
});

Deno.test("requires a CEVE license bearer", async () => {
  const response = await handleEveTitle(
    new Request("https://example.supabase.co/functions/v1/eve-title", {
      method: "POST",
      body: JSON.stringify({ text: "Hallo" }),
    }),
  );
  const body = await response.json();

  assertEquals(response.status, 401);
  assertEquals(body.error, "license_missing");
});

Deno.test("fails closed when license verification is not configured", async () => {
  Deno.env.delete("COMMAND_EVE_LICENSE_SIGNING_KEY");
  resetEveTitlePublicKeyCacheForTests();
  const response = await handleEveTitle(
    new Request("https://example.supabase.co/functions/v1/eve-title", {
      method: "POST",
      headers: { authorization: "Bearer CEVE.fake.fake.fake" },
      body: JSON.stringify({ text: "Hallo" }),
    }),
  );
  const body = await response.json();

  assertEquals(response.status, 503);
  assertEquals(body.error, "server_not_configured");
});

Deno.test("rejects expired license bearers conclusively", async () => {
  const expiredWire = licenseWire("2026-01-01T00:00:00.000Z");
  const response = await handleEveTitle(
    request({ text: "Bitte plane den Launch" }, expiredWire),
  );
  const body = await response.json();

  assertEquals(response.status, 403);
  assertEquals(body.error, "license_expired");
});

Deno.test("rejects invalid JSON bodies after license verification", async () => {
  const response = await handleEveTitle(
    new Request("https://example.supabase.co/functions/v1/eve-title", {
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
  assertEquals(body.error, "invalid_json");
});

Deno.test("rejects provider key fields in request bodies", async () => {
  const response = await handleEveTitle(
    request({ text: "Hallo", metadata: { openrouterApiKey: "leak" } }),
  );
  const body = await response.json();

  assertEquals(response.status, 400);
  assertEquals(body.error, "provider_key_field");
});

Deno.test("requires text before provider execution", async () => {
  const response = await handleEveTitle(request({ locale: "de-DE" }));
  const body = await response.json();

  assertEquals(response.status, 400);
  assertEquals(body.error, "missing_text");
});

Deno.test("requires server-side OPENROUTER_API_KEY before provider execution", async () => {
  try {
    disableProvider();
    const response = await handleEveTitle(
      request({ text: "Bitte plane den Launch", locale: "de-DE" }),
    );
    const body = await response.json();

    assertEquals(response.status, 503);
    assertEquals(body.error, "provider_not_configured");
  } finally {
    disableProvider();
  }
});

Deno.test("calls OpenRouter with server key and returns a sanitized title", async () => {
  try {
    enableProvider();
    const fetchCalls: Array<
      { input: string | URL | Request; init?: RequestInit }
    > = [];
    const fetchStub: typeof fetch = (input, init) => {
      fetchCalls.push({ input, init });
      const payload = JSON.parse(String(init?.body));
      const headers = init?.headers as Record<string, string>;

      assertEquals(
        String(input),
        "https://openrouter.ai/api/v1/chat/completions",
      );
      assertEquals(headers.Authorization, "Bearer test-openrouter-key");
      assertEquals(payload.model, "deepseek/deepseek-v4-flash");
      assertEquals(payload.temperature, 0.2);
      assertEquals(payload.max_tokens, 64);
      assertEquals(payload.messages[0].role, "system");
      assertEquals(payload.messages[1].content.includes("[REDACTED]"), true);

      return Promise.resolve(
        new Response(
          JSON.stringify({
            choices: [{
              message: { content: 'Titel: "Launchplan erstellen."' },
            }],
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
      );
    };

    const response = await handleEveTitle(
      request({
        text: "api_key=sk-test-123 Bitte plane den Launch",
        locale: "de-DE",
      }),
      { fetch: fetchStub },
    );
    const body = await response.json();

    assertEquals(fetchCalls.length, 1);
    assertEquals(response.status, 200);
    assertEquals(body.ok, true);
    assertEquals(body.title, "Launchplan erstellen");
    assertEquals(JSON.stringify(body).includes("sk-test"), false);
  } finally {
    disableProvider();
  }
});

Deno.test("maps provider failures without echoing provider response bodies", async () => {
  try {
    enableProvider();
    const fetchStub: typeof fetch = () =>
      Promise.resolve(new Response("provider-secret-detail", { status: 500 }));
    const response = await handleEveTitle(
      request({ text: "Bitte plane den Launch" }),
      { fetch: fetchStub },
    );
    const body = await response.json();

    assertEquals(response.status, 502);
    assertEquals(body.error, "provider_error");
    assertEquals(
      JSON.stringify(body).includes("provider-secret-detail"),
      false,
    );
  } finally {
    disableProvider();
  }
});

Deno.test("rejects empty provider titles", async () => {
  try {
    enableProvider();
    const fetchStub: typeof fetch = () =>
      Promise.resolve(
        new Response(
          JSON.stringify({ choices: [{ message: { content: " " } }] }),
          { status: 200 },
        ),
      );
    const response = await handleEveTitle(
      request({ text: "Bitte plane den Launch" }),
      { fetch: fetchStub },
    );
    const body = await response.json();

    assertEquals(response.status, 502);
    assertEquals(body.error, "provider_empty_title");
  } finally {
    disableProvider();
  }
});

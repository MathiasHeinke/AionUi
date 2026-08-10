// COMPA-819 — frozen semantic parity for the pre-split eve-multimodal handler.

import { assertEquals } from "jsr:@std/assert@1";
import crypto from "node:crypto";
import {
  buildLicensePayloadV2,
  signLicenseCode,
} from "../_shared/license-code-core.ts";
import golden from "./fixtures/pre-split-golden.json" with { type: "json" };
import {
  handleEveMultimodal as handleEveMultimodalRaw,
  resetEveMultimodalPublicKeyCacheForTests,
} from "./index.ts";

type GoldenCase = (typeof golden.cases)[number];

const NOWISH = "2026-07-07T12:00:00.000Z";
const TEST_ENTITLEMENT_ID = "00000000-0000-4000-8000-000000000102";

type HandlerDeps = NonNullable<Parameters<typeof handleEveMultimodalRaw>[1]>;
type ObservedFetchInit = {
  body?: unknown;
  headers?: Record<string, string>;
  method?: string;
};

function observedFetchInit(value: unknown): ObservedFetchInit {
  return value as ObservedFetchInit;
}

function handleEveMultimodal(
  req: Request,
  deps: HandlerDeps = {},
): Promise<Response> {
  return handleEveMultimodalRaw(req, {
    commitVideoDebit: (input) =>
      Promise.resolve({
        status: "applied" as const,
        entitlementId: input.expectedEntitlementId ?? TEST_ENTITLEMENT_ID,
        externalRef: input.externalRef,
        fromAllowance: 0,
        fromPurchased: 0,
      }),
    reverseVideoDebit: () => Promise.resolve({ ok: true }),
    ...deps,
  });
}

function installLicenseWire(): string {
  const { privateKey } = crypto.generateKeyPairSync("ed25519");
  const signingKeyPem = privateKey.export({
    type: "pkcs8",
    format: "pem",
  }) as string;
  Deno.env.set("COMMAND_EVE_LICENSE_SIGNING_KEY", signingKeyPem);
  resetEveMultimodalPublicKeyCacheForTests();
  const payload = buildLicensePayloadV2({
    edition: "standard",
    serial: "golden-code",
    tenant_serial: "00000000-0000-4000-8000-000000000001",
    issued_at: NOWISH,
    expires_at: "2027-07-07T00:00:00.000Z",
    trial_ends_at: null,
    seat_count: 1,
  });
  if (!payload.ok) {
    throw new Error(`golden payload failed: ${payload.reason_code}`);
  }
  return signLicenseCode({
    payload: payload.payload,
    privateKeyPem: signingKeyPem,
  });
}

function normalizeBody(body: Record<string, unknown>): Record<string, unknown> {
  return { ...body, checked_at: "<iso-timestamp>" };
}

function requestFor(testCase: GoldenCase, wire: string): Request {
  const headers: Record<string, string> = {
    "content-type": "application/json",
  };
  if (!("omit_license" in testCase) || testCase.omit_license !== true) {
    headers.authorization = `Bearer ${wire}`;
  }
  return new Request(
    "https://example.supabase.co/functions/v1/eve-multimodal",
    {
      method: "POST",
      headers,
      body: "raw_body" in testCase
        ? testCase.raw_body
        : JSON.stringify(testCase.request),
    },
  );
}

for (const testCase of golden.cases) {
  Deno.test(`preserves pre-split golden contract: ${testCase.id}`, async () => {
    const wire = installLicenseWire();
    let providerCall: Record<string, unknown> | undefined;
    if (testCase.id === "tts-provider-success") {
      Deno.env.set("EVE_MULTIMODAL_ENABLE_XAI_TTS", "true");
      Deno.env.set("XAI_API_KEY", "golden-test-xai-key");
    }
    try {
      const response = await handleEveMultimodal(requestFor(testCase, wire), {
        fetch: (input, init) => {
          const observed = observedFetchInit(init);
          const headers = observed.headers ?? {};
          providerCall = {
            url: String(input),
            method: observed.method,
            authorization: headers.Authorization
              ? "Bearer [redacted]"
              : undefined,
            content_type: headers["Content-Type"],
            body: JSON.parse(String(observed.body)),
          };
          return Promise.resolve(
            new Response(new Uint8Array([1, 2, 3]), {
              status: 200,
              headers: { "content-type": "audio/mpeg" },
            }),
          );
        },
      });
      const responseBody = normalizeBody(await response.json());

      assertEquals(response.status, testCase.expected_status);
      assertEquals(response.headers.get("content-type"), "application/json");
      assertEquals(response.headers.get("Access-Control-Allow-Origin"), "*");
      assertEquals(responseBody, testCase.expected_body);
      if ("expected_provider_call" in testCase) {
        assertEquals(providerCall, testCase.expected_provider_call);
      } else {
        assertEquals(providerCall, undefined);
      }
      assertEquals(JSON.stringify(responseBody).includes("deck.pptx"), false);
      assertEquals(
        JSON.stringify(responseBody).includes("Golden TTS text."),
        false,
      );
      assertEquals(
        JSON.stringify(responseBody).includes("golden-test-xai-key"),
        false,
      );
    } finally {
      Deno.env.delete("EVE_MULTIMODAL_ENABLE_XAI_TTS");
      Deno.env.delete("XAI_API_KEY");
      Deno.env.delete("COMMAND_EVE_LICENSE_SIGNING_KEY");
      resetEveMultimodalPublicKeyCacheForTests();
    }
  });
}

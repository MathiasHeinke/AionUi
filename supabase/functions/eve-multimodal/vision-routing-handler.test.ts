// Run:
// deno test --allow-env supabase/functions/eve-multimodal/vision-routing-handler.test.ts

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

const TENANT_ID = "f320cebf-f392-41d9-b6b6-f079677eab4f";

function observedFetchBody(value: unknown): unknown {
  return (value as { body?: unknown } | undefined)?.body;
}

function licenseWire(): string {
  const { privateKey } = crypto.generateKeyPairSync("ed25519");
  const privateKeyPem = privateKey.export({
    type: "pkcs8",
    format: "pem",
  }) as string;
  Deno.env.set("COMMAND_EVE_LICENSE_SIGNING_KEY", privateKeyPem);
  resetEveMultimodalPublicKeyCacheForTests();
  const payload = buildLicensePayloadV2({
    edition: "pilot",
    serial: "22",
    tenant_serial: TENANT_ID,
    issued_at: "2026-08-01T00:00:00.000Z",
    expires_at: "2027-08-01T00:00:00.000Z",
    trial_ends_at: "2027-08-01T00:00:00.000Z",
    seat_count: 1,
  });
  if (!payload.ok) throw new Error(payload.reason_code);
  return signLicenseCode({ payload: payload.payload, privateKeyPem });
}

function imageBody(): Record<string, unknown> {
  // The visual parser only needs a bounded PNG with a real magic header.
  const bytes = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 0]);
  const sha256 = crypto.createHash("sha256").update(bytes).digest("hex");
  return {
    provider: "openrouter",
    capability: "vision",
    privacyLane: "cloud_auto",
    directProviderKeyPresentInDesktop: false,
    source_kind: "image",
    file_name: "probe.png",
    file_sha256: sha256,
    slide_count: 1,
    locale: "de-DE",
    images: [{
      slide_number: 1,
      mime_type: "image/png",
      sha256,
      data_base64: btoa(String.fromCharCode(...bytes)),
    }],
    requestId: "vision_paid_route_probe",
  };
}

Deno.test("Vision uses the server-resolved Paid model, bound and output cap for a pilot with purchased credits", async () => {
  Deno.env.set("EVE_MULTIMODAL_ENABLE_OPENROUTER_VISION", "true");
  Deno.env.set("OPENROUTER_API_KEY", "test-openrouter-key");
  const commits: Array<Record<string, unknown>> = [];
  const providerBodies: Array<Record<string, unknown>> = [];

  try {
    const response = await handleEveMultimodal(
      new Request("https://example.supabase.co/functions/v1/eve-multimodal", {
        method: "POST",
        headers: {
          authorization: `Bearer ${licenseWire()}`,
          "content-type": "application/json",
        },
        body: JSON.stringify(imageBody()),
      }),
      {
        loadVisionModelRoute: async () => ({
          ok: true,
          entitlementId: "entitlement-paid",
          route: {
            lane: "paid",
            model: "google/gemini-3.6-flash",
            boundRetailEurCentsPerImage: 35,
            maxOutputTokens: 1_800,
          },
        }),
        commitVideoDebit: async (input) => {
          commits.push(input as unknown as Record<string, unknown>);
          return {
            status: "applied",
            entitlementId: "entitlement-paid",
            externalRef: input.externalRef,
            fromAllowance: 0,
            fromPurchased: 350,
          };
        },
        reverseVideoDebit: async () => ({ ok: true }),
        reservePdfOcrUsage: async () => ({
          ok: true,
          allowed: true,
          reason: "reserved",
          tenantUnits: 1,
          tenantCap: 200,
          globalUnits: 1,
          globalCap: 10_000,
          replayed: false,
        }),
        fetch: async (_input, init) => {
          providerBodies.push(
            JSON.parse(String(observedFetchBody(init) ?? "{}")),
          );
          return Response.json({
            choices: [{
              message: { content: "## Image 1\n\n- Sichtbarer Testinhalt." },
            }],
            usage: { cost: 0.001 },
          });
        },
      },
    );

    assertEquals(response.status, 200);
    const payload = await response.json();
    assertEquals(payload.ok, true);
    assertEquals(payload.vision.model, "google/gemini-3.6-flash");
    assertEquals(commits[0]?.costEurCents, 35);
    assertEquals(commits[0]?.model, "google/gemini-3.6-flash");
    assertEquals(commits[0]?.expectedEntitlementId, "entitlement-paid");
    assertEquals(providerBodies[0]?.model, "google/gemini-3.6-flash");
    assertEquals(providerBodies[0]?.max_tokens, 1_800);
  } finally {
    Deno.env.delete("EVE_MULTIMODAL_ENABLE_OPENROUTER_VISION");
    Deno.env.delete("OPENROUTER_API_KEY");
    Deno.env.delete("COMMAND_EVE_LICENSE_SIGNING_KEY");
    resetEveMultimodalPublicKeyCacheForTests();
  }
});

Deno.test("Vision uses the cheap Trial model and one-cent bound before purchased credits exist", async () => {
  Deno.env.set("EVE_MULTIMODAL_ENABLE_OPENROUTER_VISION", "true");
  Deno.env.set("OPENROUTER_API_KEY", "test-openrouter-key");
  const commits: Array<Record<string, unknown>> = [];
  const providerBodies: Array<Record<string, unknown>> = [];

  try {
    const response = await handleEveMultimodal(
      new Request("https://example.supabase.co/functions/v1/eve-multimodal", {
        method: "POST",
        headers: {
          authorization: `Bearer ${licenseWire()}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          ...imageBody(),
          requestId: "vision_trial_route_probe",
        }),
      }),
      {
        loadVisionModelRoute: async () => ({
          ok: true,
          entitlementId: "entitlement-trial",
          route: {
            lane: "trial",
            model: "qwen/qwen3.7-flash",
            boundRetailEurCentsPerImage: 1,
            maxOutputTokens: 1_200,
          },
        }),
        commitVideoDebit: async (input) => {
          commits.push(input as unknown as Record<string, unknown>);
          return {
            status: "applied",
            entitlementId: "entitlement-trial",
            externalRef: input.externalRef,
            fromAllowance: 10,
            fromPurchased: 0,
          };
        },
        reverseVideoDebit: async () => ({ ok: true }),
        reservePdfOcrUsage: async () => ({
          ok: true,
          allowed: true,
          reason: "reserved",
          tenantUnits: 1,
          tenantCap: 200,
          globalUnits: 1,
          globalCap: 10_000,
          replayed: false,
        }),
        fetch: async (_input, init) => {
          providerBodies.push(
            JSON.parse(String(observedFetchBody(init) ?? "{}")),
          );
          return Response.json({
            choices: [{
              message: { content: "## Image 1\n\n- Sichtbarer Trial-Inhalt." },
            }],
            usage: { cost: 0.00001 },
          });
        },
      },
    );

    assertEquals(response.status, 200);
    const payload = await response.json();
    assertEquals(payload.ok, true);
    assertEquals(payload.vision.model, "qwen/qwen3.7-flash");
    assertEquals(commits[0]?.costEurCents, 1);
    assertEquals(commits[0]?.model, "qwen/qwen3.7-flash");
    assertEquals(commits[0]?.expectedEntitlementId, "entitlement-trial");
    assertEquals(providerBodies[0]?.model, "qwen/qwen3.7-flash");
    assertEquals(providerBodies[0]?.max_tokens, 1_200);
  } finally {
    Deno.env.delete("EVE_MULTIMODAL_ENABLE_OPENROUTER_VISION");
    Deno.env.delete("OPENROUTER_API_KEY");
    Deno.env.delete("COMMAND_EVE_LICENSE_SIGNING_KEY");
    resetEveMultimodalPublicKeyCacheForTests();
  }
});

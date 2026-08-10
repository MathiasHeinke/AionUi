// Run:
// deno test supabase/functions/eve-multimodal/vision-model-router.test.ts

import { assertEquals } from 'jsr:@std/assert@1';
import {
  DEFAULT_PAID_VISION_MODEL,
  DEFAULT_TRIAL_VISION_MODEL,
  loadVisionModelRoute,
  resolveVisionModelRoute,
} from './vision-model-router.ts';

const NOW = '2026-08-10T00:00:00.000Z';

function entitlement(overrides: Record<string, unknown> = {}) {
  return {
    id: '990d72a9-cb9b-44ba-b1fc-0752a12007cb',
    status: 'trialing',
    edition: 'pilot',
    created_at: '2026-07-27T13:38:35.680Z',
    trial_ends_at: '2026-08-10T13:38:35.271Z',
    expires_at: '2026-08-10T13:38:35.271Z',
    ...overrides,
  };
}

Deno.test('pure route keeps an allowance-only pilot on cheap Trial Vision', () => {
  const route = resolveVisionModelRoute({
    entitlement: entitlement(),
    balance: {
      included_allowance_credits_remaining: 100_000,
      purchased_credits_remaining: 0,
    },
    imageCount: 1,
  });

  assertEquals(route?.lane, 'trial');
  assertEquals(route?.model, DEFAULT_TRIAL_VISION_MODEL);
  assertEquals(route?.boundRetailEurCentsPerImage, 1);
});

Deno.test('purchased credits override the legacy pilot edition', () => {
  const route = resolveVisionModelRoute({
    entitlement: entitlement(),
    balance: {
      included_allowance_credits_remaining: 0,
      purchased_credits_remaining: 98_047,
    },
    imageCount: 1,
  });

  assertEquals(route?.lane, 'paid');
  assertEquals(route?.model, DEFAULT_PAID_VISION_MODEL);
  assertEquals(route?.boundRetailEurCentsPerImage, 35);
});

Deno.test('an active Standard plan keeps Paid Vision after its purchased bucket reaches zero', () => {
  const route = resolveVisionModelRoute({
    entitlement: entitlement({
      status: 'active',
      edition: 'standard',
      trial_ends_at: null,
      expires_at: null,
    }),
    balance: {
      included_allowance_credits_remaining: 20_000,
      purchased_credits_remaining: 0,
    },
    imageCount: 3,
  });

  assertEquals(route?.lane, 'paid');
  assertEquals(route?.maxOutputTokens, 3_000);
});

Deno.test('an unsupported active free edition does not silently receive either paid or trial routing', () => {
  const route = resolveVisionModelRoute({
    entitlement: entitlement({ status: 'active', edition: 'free' }),
    balance: {
      included_allowance_credits_remaining: 100_000,
      purchased_credits_remaining: 0,
    },
    imageCount: 1,
  });

  assertEquals(route, null);
});

Deno.test('loader resolves the same drawable entitlement and its authoritative purchased balance', async () => {
  const seen: string[] = [];
  const fetchFn: typeof fetch = async (input) => {
    const url = String(input);
    seen.push(url);
    if (url.includes('/rest/v1/entitlements')) {
      return Response.json([
        entitlement({ id: 'newer-trial' }),
        entitlement({
          id: 'active-standard',
          status: 'active',
          edition: 'standard',
          trial_ends_at: null,
          created_at: '2026-07-01T00:00:00.000Z',
        }),
      ]);
    }
    if (url.includes('/rest/v1/credit_balances')) {
      return Response.json([
        {
          entitlement_id: 'active-standard',
          included_allowance_credits_remaining: '0.000000',
          purchased_credits_remaining: '25000.000000',
        },
      ]);
    }
    return new Response('not found', { status: 404 });
  };

  const result = await loadVisionModelRoute({
    tenantId: 'f320cebf-f392-41d9-b6b6-f079677eab4f',
    nowIso: NOW,
    imageCount: 1,
    supabaseUrl: 'https://example.supabase.co',
    serviceRoleKey: 'service-role-test',
    fetchFn,
  });

  assertEquals(result.ok, true);
  if (result.ok) {
    assertEquals(result.entitlementId, 'active-standard');
    assertEquals(result.route.lane, 'paid');
  }
  assertEquals(seen.length, 2);
  assertEquals(seen[1].includes('entitlement_id=in.%28'), true);
});

Deno.test('an expired Pilot still resolves Paid Vision while purchased carry-over remains', async () => {
  const fetchFn: typeof fetch = async (input) => {
    const url = String(input);
    if (url.includes('/rest/v1/entitlements')) {
      return Response.json([
        entitlement({
          id: 'expired-pilot',
          trial_ends_at: '2026-08-09T00:00:00.000Z',
          expires_at: '2026-08-09T00:00:00.000Z',
        }),
      ]);
    }
    return Response.json([
      {
        entitlement_id: 'expired-pilot',
        included_allowance_credits_remaining: '0.000000',
        purchased_credits_remaining: '98047.000000',
      },
    ]);
  };

  const result = await loadVisionModelRoute({
    tenantId: 'f320cebf-f392-41d9-b6b6-f079677eab4f',
    nowIso: NOW,
    imageCount: 1,
    supabaseUrl: 'https://example.supabase.co',
    serviceRoleKey: 'service-role-test',
    fetchFn,
  });

  assertEquals(result.ok, true);
  if (result.ok) {
    assertEquals(result.entitlementId, 'expired-pilot');
    assertEquals(result.route.lane, 'paid');
    assertEquals(result.route.model, DEFAULT_PAID_VISION_MODEL);
  }
});

Deno.test('loader fails closed when the service-role route is not configured', async () => {
  const result = await loadVisionModelRoute({
    tenantId: 'f320cebf-f392-41d9-b6b6-f079677eab4f',
    nowIso: NOW,
    imageCount: 1,
    supabaseUrl: null,
    serviceRoleKey: null,
  });
  assertEquals(result, { ok: false, reason: 'route-not-configured' });
});

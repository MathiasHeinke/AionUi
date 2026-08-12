import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  ACCOUNT_SEED_LIMIT,
  createSeed,
  createSeedSingleFlight,
  renameSeed,
  resetSeedCreateSingleFlightForTests,
} from '../../../packages/desktop/src/process/commandEve/seedLifecycleFetchCore';

const REQUEST_ID = '11111111-1111-4111-8111-111111111111';
const SEED_ID = '22222222-2222-4222-8222-222222222222';
const session = {
  ok: true,
  session: {
    access_token: 'access-test',
    refresh_token: 'refresh-test',
    expires_at: 9_999_999_999,
    user: { id: 'u1', email: 'user@example.test' },
  },
};

afterEach(() => resetSeedCreateSingleFlightForTests());

describe('seedLifecycleFetchCore', () => {
  it('accepts the deployed legacy tenant_id response as the stable seed id', async () => {
    const fetch = vi
      .fn()
      .mockResolvedValue(
        new Response(JSON.stringify({ ok: true, tenant_id: SEED_ID, created: true, seats_used: 2 }), { status: 200 })
      );
    const result = await createSeed(
      '/tmp/user-data',
      { displayName: 'Zweiter Seed', clientRequestId: REQUEST_ID },
      {
        fetch,
        getFreshSession: vi.fn().mockResolvedValue(session),
        anonKey: 'anon-test',
      }
    );
    expect(result).toEqual({ ok: true, seedId: SEED_ID, created: true, seedCount: 2, seedLimit: ACCOUNT_SEED_LIMIT });
    const body = JSON.parse(fetch.mock.calls[0][1].body);
    expect(body).toEqual({ name: 'Zweiter Seed', client_request_id: REQUEST_ID });
  });

  it('coalesces rapid create calls into one network request', async () => {
    let release!: (value: Response) => void;
    const fetch = vi.fn(() => new Promise<Response>((resolve) => (release = resolve)));
    const deps = { fetch, getFreshSession: vi.fn().mockResolvedValue(session), anonKey: 'anon-test' };
    const first = createSeedSingleFlight(
      '/tmp/user-data',
      { displayName: 'Seed A', clientRequestId: REQUEST_ID },
      deps
    );
    const second = createSeedSingleFlight(
      '/tmp/user-data',
      { displayName: 'Seed B', clientRequestId: '33333333-3333-4333-8333-333333333333' },
      deps
    );
    expect(first).toBe(second);
    await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(1));
    release(new Response(JSON.stringify({ ok: true, seed_id: SEED_ID, created: true, seed_count: 2, seed_limit: 10 })));
    expect((await first).ok).toBe(true);
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('reports timeout and allows same-key reconciliation retry', async () => {
    const abortError = Object.assign(new Error('aborted'), { name: 'AbortError' });
    const fetch = vi
      .fn()
      .mockRejectedValueOnce(abortError)
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ ok: true, seed_id: SEED_ID, created: false, seed_count: 2, seed_limit: 10 }))
      );
    const deps = { fetch, getFreshSession: vi.fn().mockResolvedValue(session), anonKey: 'anon-test', timeoutMs: 1 };
    const first = await createSeedSingleFlight(
      '/tmp/user-data',
      { displayName: 'Seed A', clientRequestId: REQUEST_ID },
      deps
    );
    expect(first.reasonCode).toBe('SEED_PROVISION_TIMEOUT');
    const retry = await createSeedSingleFlight(
      '/tmp/user-data',
      { displayName: 'Seed A', clientRequestId: REQUEST_ID },
      deps
    );
    expect(retry).toMatchObject({ ok: true, seedId: SEED_ID, created: false });
    expect(JSON.parse(fetch.mock.calls[0][1].body).client_request_id).toBe(REQUEST_ID);
    expect(JSON.parse(fetch.mock.calls[1][1].body).client_request_id).toBe(REQUEST_ID);
  });

  it('rename payload contains only seed identity and display name', async () => {
    const fetch = vi
      .fn()
      .mockResolvedValue(
        new Response(JSON.stringify({ ok: true, seed_id: SEED_ID, display_name: 'Neuer Seedname' }), { status: 200 })
      );
    const result = await renameSeed(
      '/tmp/user-data',
      { seedId: SEED_ID, displayName: ' Neuer Seedname ' },
      {
        fetch,
        getFreshSession: vi.fn().mockResolvedValue(session),
        anonKey: 'anon-test',
      }
    );
    expect(result).toEqual({ ok: true, seedId: SEED_ID, displayName: 'Neuer Seedname' });
    expect(JSON.parse(fetch.mock.calls[0][1].body)).toEqual({ seed_id: SEED_ID, display_name: 'Neuer Seedname' });
  });
});

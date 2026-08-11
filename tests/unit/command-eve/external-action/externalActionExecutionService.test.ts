import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  EVE_EXTERNAL_ACTION_PROPOSAL_VERSION,
  type EveExternalActionProposal,
} from '@/common/config/eveExternalActionExecutionCore';
import type { EveExternalActionBinding } from '@/common/config/eveExternalActionPolicyCore';
import {
  ExternalActionExecutionService,
  type ExternalActionAdapter,
  type ExternalActionExecutionDeps,
} from '@/process/services/external-action/externalActionExecutionService';
import { ExternalActionStore } from '@/process/services/external-action/externalActionStore';
import type { SecretMaterialResolver } from '@/process/services/external-action/secretUseBroker';
import { NodeSqliteDriver } from './testSqliteDriver';

const NOW_ISO = '2026-08-11T12:00:00.000Z';
const ORIGIN = 'https://shop.example';
const OTHER_ORIGIN = 'https://evil.example';
const OAUTH_REF = `keychain:v1:${Buffer.from('oauth-ciphertext-material').toString('base64')}`;
const PASSWORD_REF = `keychain:v1:${Buffer.from('password-ciphertext-material').toString('base64')}`;
const roots: string[] = [];
const stores = new Set<ExternalActionStore>();
let sequence = 0;

function digest(character: string): string {
  return `sha256:${character.repeat(64)}`;
}

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'eve-execution-service-'));
  roots.push(root);
  const file = path.join(root, 'ledger.sqlite3');
  const store = new ExternalActionStore(new NodeSqliteDriver(file), {
    now: () => new Date(NOW_ISO),
    randomUUID: () => `store-${++sequence}`,
  });
  stores.add(store);
  const binding: EveExternalActionBinding = {
    installationId: store.getInstallationId(),
    accountId: 'account-a',
    seedId: 'seed-a',
  };
  const policy = store.replacePolicy(
    binding,
    {
      currency: 'EUR',
      perActionLimitMinor: 1_000,
      dailyLimitMinor: 2_000,
      monthlyLimitMinor: 10_000,
      allowedOrigins: [ORIGIN],
      allowedActionKinds: ['purchase'],
      expiresAt: '2026-08-18T12:00:00.000Z',
    },
    'Europe/Berlin'
  );
  if ('reasonCode' in policy) throw new Error(policy.reasonCode);
  for (const handle of [
    { handleId: 'oauth-handle', type: 'oauth_token' as const, ref: OAUTH_REF },
    { handleId: 'password-handle', type: 'account_credential' as const, ref: PASSWORD_REF },
  ]) {
    const registered = store.registerSecretHandle({
      binding,
      handleId: handle.handleId,
      type: handle.type,
      source: 'eve_keychain',
      sourceRef: handle.ref,
      actionKinds: ['purchase'],
      targetOrigins: [ORIGIN],
      expiresAt: '2026-08-18T12:00:00.000Z',
    });
    if ('reasonCode' in registered) throw new Error(registered.reasonCode);
  }
  return { root, file, store, binding };
}

function proposal(overrides: Partial<EveExternalActionProposal> = {}): EveExternalActionProposal {
  return {
    version: EVE_EXTERNAL_ACTION_PROPOSAL_VERSION,
    clientRequestId: 'client-request-a',
    idempotencyKey: 'idempotency-a',
    action: {
      kind: 'purchase',
      targetOrigin: ORIGIN,
      argumentsDigest: digest('a'),
      quoteDigest: digest('b'),
      amount: { currency: 'EUR', minorUnits: 500 },
    },
    oauthHandleId: 'oauth-handle',
    passwordHandleId: 'password-handle',
    ...overrides,
  };
}

function adapter(overrides: Partial<ExternalActionAdapter> = {}): ExternalActionAdapter {
  return {
    id: 'synthetic-shop-adapter',
    actionKinds: ['purchase'],
    targetOrigins: [ORIGIN, OTHER_ORIGIN],
    supports: { oauth: true, browserSession: true, password: true, unauthenticated: false },
    probeOAuth: async () => 'ready',
    probeBrowserSession: async () => 'unavailable',
    execute: async () => ({ status: 'allowed' }),
    ...overrides,
  };
}

function service(input: {
  store: ExternalActionStore;
  binding: EveExternalActionBinding;
  adapter: ExternalActionAdapter;
  resolver?: SecretMaterialResolver;
  bindingOverride?: EveExternalActionBinding;
  resolveBinding?: ExternalActionExecutionDeps['resolveBinding'];
  resolveAuthority?: ExternalActionExecutionDeps['resolveAuthority'];
}) {
  return new ExternalActionExecutionService(input.store, {
    resolveBinding: input.resolveBinding ?? (() => ({ ok: true, binding: input.bindingOverride ?? input.binding })),
    resolveAuthority:
      input.resolveAuthority ??
      (async () => ({ decision: 'allow', authorityGrantId: 'grant-test', riskClass: 'ordinary' })),
    secretResolver:
      input.resolver ??
      ({
        resolve: async ({ sourceRef }) =>
          new TextEncoder().encode(sourceRef === OAUTH_REF ? 'synthetic-refresh-token' : 'synthetic-password'),
      } satisfies SecretMaterialResolver),
    adapters: [input.adapter],
    now: () => new Date(NOW_ISO),
    randomUUID: () => `execution-${++sequence}`,
  });
}

afterEach(() => {
  vi.restoreAllMocks();
  for (const store of stores) store.close();
  stores.clear();
  while (roots.length) fs.rmSync(roots.pop()!, { recursive: true, force: true });
});

describe('ExternalActionExecutionService Main-owned seam', () => {
  it('prefers OAuth, permits renewal inside the trusted adapter and executes an exact replay at most once', async () => {
    const { store, binding } = fixture();
    const execute = vi.fn(async ({ authMode, credential }) => {
      expect(authMode).toBe('oauth');
      expect(new TextDecoder().decode(credential)).toBe('synthetic-refresh-token');
      // Synthetic renewal happens here, inside the trusted adapter. No token is
      // returned in the sanitized outcome.
      return { status: 'allowed' as const, reasonCode: 'OAUTH_RENEWED' };
    });
    const runner = service({ store, binding, adapter: adapter({ execute }) });

    const first = await runner.execute(proposal());
    const replay = await runner.execute(proposal());
    expect(first).toMatchObject({ status: 'allowed', authMode: 'oauth' });
    expect(replay).toMatchObject({ status: 'allowed', replay: true, reservationId: first.reservationId });
    expect(execute).toHaveBeenCalledTimes(1);
    expect(JSON.stringify([first, replay])).not.toContain('synthetic-refresh-token');
  });

  it('never accepts a password handle in the OAuth slot', async () => {
    const { store, binding } = fixture();
    const execute = vi.fn(async () => ({ status: 'allowed' as const }));
    const outcome = await service({ store, binding, adapter: adapter({ execute }) }).execute(
      proposal({ oauthHandleId: 'password-handle' })
    );
    expect(outcome).toMatchObject({
      status: 'needs_user',
      reasonCode: 'EXTERNAL_SECRET_HANDLE_TYPE_BLOCKED',
    });
    expect(store.getReservation(binding, outcome.reservationId!)?.state).toBe('reversed');
    expect(execute).not.toHaveBeenCalled();
  });

  it('blocks semantic replay even when request, idempotency and policy revision are changed', async () => {
    const { store, binding } = fixture();
    const execute = vi.fn(async () => ({ status: 'allowed' as const }));
    const runner = service({ store, binding, adapter: adapter({ execute }) });
    expect(await runner.execute(proposal())).toMatchObject({ status: 'allowed' });

    const current = store.getPolicy(binding)!;
    expect(
      store.replacePolicy(
        binding,
        {
          currency: current.currency,
          perActionLimitMinor: current.perActionLimitMinor,
          dailyLimitMinor: current.dailyLimitMinor,
          monthlyLimitMinor: current.monthlyLimitMinor,
          allowedOrigins: current.allowedOrigins,
          allowedActionKinds: current.allowedActionKinds,
          expiresAt: current.expiresAt,
        },
        current.timezone
      )
    ).toMatchObject({ ok: true, policy: { revision: 2 } });
    expect(
      store.registerSecretHandle({
        binding,
        handleId: 'oauth-handle-rotated',
        type: 'oauth_token',
        source: 'eve_keychain',
        sourceRef: `keychain:v1:${Buffer.from('rotated-oauth-ciphertext').toString('base64')}`,
        actionKinds: ['purchase'],
        targetOrigins: [ORIGIN],
        expiresAt: '2026-08-18T12:00:00.000Z',
      })
    ).toEqual({ ok: true });

    expect(
      await runner.execute(
        proposal({
          clientRequestId: 'fresh-client-request',
          idempotencyKey: 'fresh-idempotency-key',
          oauthHandleId: 'oauth-handle-rotated',
        })
      )
    ).toMatchObject({ status: 'denied', reasonCode: 'EXTERNAL_REPLAY_CONFLICT' });
    expect(execute).toHaveBeenCalledTimes(1);
  });

  it('returns needs_user for MFA/risk auth challenges and never falls back to password', async () => {
    const { store, binding } = fixture();
    const execute = vi.fn(async () => ({ status: 'allowed' as const }));
    const runner = service({
      store,
      binding,
      adapter: adapter({ probeOAuth: async () => 'needs_user', execute }),
    });
    expect(await runner.execute(proposal())).toMatchObject({
      status: 'needs_user',
      reasonCode: 'EXTERNAL_OAUTH_REQUIRED',
      authMode: 'oauth',
    });
    expect(execute).not.toHaveBeenCalled();
  });

  it('reduces an auth-probe exception to a fixed needs_user result without leaking its message', async () => {
    const { store, binding, file } = fixture();
    const leaked = 'synthetic-auth-probe-secret';
    const execute = vi.fn(async () => ({ status: 'allowed' as const }));
    const runner = service({
      store,
      binding,
      adapter: adapter({
        probeOAuth: async () => {
          throw new Error(leaked);
        },
        execute,
      }),
    });
    const outcome = await runner.execute(proposal());
    expect(outcome).toMatchObject({ status: 'needs_user', reasonCode: 'EXTERNAL_AUTH_PROBE_UNAVAILABLE' });
    expect(JSON.stringify(outcome)).not.toContain(leaked);
    expect(fs.readFileSync(file).includes(Buffer.from(leaked))).toBe(false);
    expect(execute).not.toHaveBeenCalled();
  });

  it('uses password only after OAuth and the isolated browser session explicitly report unavailable', async () => {
    const { store, binding } = fixture();
    const execute = vi.fn(async ({ authMode, credential, browserPartition }) => {
      expect(authMode).toBe('password');
      expect(new TextDecoder().decode(credential)).toBe('synthetic-password');
      expect(browserPartition).toBeUndefined();
      return { status: 'allowed' as const };
    });
    const runner = service({
      store,
      binding,
      adapter: adapter({
        probeOAuth: async () => 'unavailable',
        probeBrowserSession: async () => 'unavailable',
        execute,
      }),
    });
    expect(await runner.execute(proposal())).toMatchObject({ status: 'allowed', authMode: 'password' });
    expect(execute).toHaveBeenCalledTimes(1);
  });

  it('fails closed for wrong account, seed and origin before any adapter call', async () => {
    const { store, binding } = fixture();
    const execute = vi.fn(async () => ({ status: 'allowed' as const }));
    const wrongAccount = service({
      store,
      binding,
      adapter: adapter({ execute }),
      bindingOverride: { ...binding, accountId: 'account-b' },
    });
    const wrongSeed = service({
      store,
      binding,
      adapter: adapter({ execute }),
      bindingOverride: { ...binding, seedId: 'seed-b' },
    });
    const right = service({ store, binding, adapter: adapter({ execute }) });
    expect(await wrongAccount.execute(proposal())).toMatchObject({ status: 'denied' });
    expect(await wrongSeed.execute(proposal())).toMatchObject({ status: 'denied' });
    expect(
      await right.execute(proposal({ action: { ...proposal().action, targetOrigin: OTHER_ORIGIN } }))
    ).toMatchObject({ status: 'denied', reasonCode: 'EXTERNAL_ORIGIN_BLOCKED' });
    expect(execute).not.toHaveBeenCalled();
  });

  it('blocks a seat switch that occurs while Main resolves a credential', async () => {
    const { store, binding } = fixture();
    let activeBinding = binding;
    const execute = vi.fn(async () => ({ status: 'allowed' as const }));
    const runner = service({
      store,
      binding,
      adapter: adapter({ execute }),
      resolveBinding: () => ({ ok: true, binding: activeBinding }),
      resolver: {
        resolve: async () => {
          activeBinding = { ...binding, seedId: 'seed-switched' };
          return new TextEncoder().encode('synthetic-refresh-token');
        },
      },
    });
    const outcome = await runner.execute(proposal());
    expect(outcome).toMatchObject({ status: 'denied', reasonCode: 'EXTERNAL_BINDING_CHANGED' });
    expect(execute).not.toHaveBeenCalled();
    expect(store.getReservation(binding, outcome.reservationId!)?.state).toBe('reversed');
  });

  it('marks a crash-window adapter throw unknown and never retries it', async () => {
    const { store, binding } = fixture();
    const secret = 'synthetic-adapter-secret-in-error';
    const execute = vi.fn(async () => {
      throw new Error(secret);
    });
    const runner = service({ store, binding, adapter: adapter({ execute }) });
    const first = await runner.execute(proposal());
    const replay = await runner.execute(proposal());
    expect(first).toMatchObject({ status: 'unknown_outcome' });
    expect(replay).toMatchObject({ status: 'unknown_outcome', replay: true });
    expect(execute).toHaveBeenCalledTimes(1);
    expect(JSON.stringify([first, replay, store.readAuditEvents(binding)])).not.toContain(secret);
  });

  it('reports unknown when revoke wins a mid-flight race, even if the adapter reports success', async () => {
    const { store, binding } = fixture();
    const runner = service({
      store,
      binding,
      adapter: adapter({
        execute: async () => {
          expect(store.revokePolicy(binding)).toMatchObject({ ok: true });
          return { status: 'allowed' };
        },
      }),
    });
    expect(await runner.execute(proposal())).toMatchObject({
      status: 'unknown_outcome',
      reasonCode: 'EXTERNAL_TERMINAL_STATE_CONFLICT',
    });
  });

  it('rejects plaintext/unknown proposal fields and never writes them to result, log or SQLite', async () => {
    const { store, binding, file } = fixture();
    const leaked = 'synthetic-plaintext-renderer-secret';
    const log = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const runner = service({ store, binding, adapter: adapter() });
    const untrusted = { ...proposal(), secret: leaked };
    const outcome = await runner.execute(untrusted);
    expect(outcome).toMatchObject({ status: 'denied', reasonCode: 'EXTERNAL_PROPOSAL_FIELDS_INVALID' });
    expect(JSON.stringify(outcome)).not.toContain(leaked);
    expect(fs.readFileSync(file).includes(Buffer.from(leaked))).toBe(false);
    expect(JSON.stringify(log.mock.calls)).not.toContain(leaked);
  });
});

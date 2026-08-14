/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 *
 * @vitest-environment node
 */

import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import ts from 'typescript';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  CUSTOMER_DEFAULT_KANBAN_PROVIDER_KEYS,
  FOUNDER_ONLY_PROVIDER_KEYS,
  RENDERER_PROVIDER_KEYS,
  RENDERER_PROVIDER_PAYLOAD_CLASSES,
  type ProviderPayloadClass,
  type RendererProviderKey,
} from '@/common/adapter/security/providerRegistry';
import {
  getRendererToMainAdapterPolicy,
  parseRendererToMainAdapterEvent,
} from '@/common/adapter/security/bridgePolicy';
import { wsEmitter } from '@/common/adapter/httpBridge';

const state = vi.hoisted(() => ({
  handler: undefined as ((event: unknown, payload: unknown) => unknown) | undefined,
  emitter: { emit: vi.fn() },
  isPackaged: false,
}));

vi.mock('electron', () => ({
  app: {
    get isPackaged() {
      return state.isPackaged;
    },
    getAppPath: () => '/app',
  },
  ipcMain: {
    handle: vi.fn((_channel: string, handler: (event: unknown, payload: unknown) => unknown) => {
      state.handler = handler;
    }),
  },
}));

vi.mock('@office-ai/platform', () => ({
  bridge: {
    adapter: (adapter: { on: (emitter: typeof state.emitter) => void }) => adapter.on(state.emitter),
  },
}));

vi.mock('@/common/adapter/registry', () => ({
  registerWebSocketBroadcaster: vi.fn(),
  getBridgeEmitter: vi.fn(),
  setBridgeEmitter: vi.fn(),
  broadcastToAll: vi.fn(),
}));

type FakeWebContents = {
  mainFrame: { url: string };
  isDestroyed: () => boolean;
};

beforeEach(() => {
  delete process.env.COMMAND_EVE_FOUNDER_BUILD;
  process.env.ELECTRON_RENDERER_URL = 'http://127.0.0.1:5173/app';
  state.handler = undefined;
  state.emitter.emit.mockReset();
  state.isPackaged = false;
  vi.resetModules();
});

afterEach(() => {
  delete process.env.COMMAND_EVE_FOUNDER_BUILD;
  delete process.env.ELECTRON_RENDERER_URL;
  vi.unstubAllGlobals();
});

function providerPayload(providerKey: string, ...payload: [] | [unknown]): string {
  const envelope: { id: string; data?: unknown } = { id: `${providerKey}deadbeef` };
  if (payload.length === 1) envelope.data = payload[0];
  return JSON.stringify({ name: `subscribe-${providerKey}`, data: envelope });
}

function validProviderPayload(providerKey: RendererProviderKey): string {
  switch (providerKey) {
    case 'command-eve.external-action-execute':
      return providerPayload(providerKey, {
        version: 'command-eve-external-action-proposal/v1',
        clientRequestId: 'client-request-a',
        idempotencyKey: 'idempotency-a',
        action: {
          kind: 'purchase',
          targetOrigin: 'https://shop.example',
          argumentsDigest: `sha256:${'a'.repeat(64)}`,
          quoteDigest: `sha256:${'b'.repeat(64)}`,
          amount: { currency: 'EUR', minorUnits: 100 },
        },
        oauthHandleId: 'oauth-handle-a',
      });
    case 'command-eve.external-action-resume':
      return providerPayload(providerKey, {
        version: 'command-eve-external-action-resume/v1',
        resumeRef: 'resume-ref-a',
        completionAttestationRef: 'completion-attestation-a',
      });
    case 'command-eve.external-action-policy-set':
      return providerPayload(providerKey, {
        context_token: `policy-context:v1:${'a'.repeat(64)}`,
        mutation: {
          currency: 'EUR',
          perActionLimitMinor: 100,
          dailyLimitMinor: 200,
          monthlyLimitMinor: 300,
          allowedOrigins: ['https://shop.example'],
          allowedActionKinds: ['purchase'],
          expiresAt: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
        },
      });
    case 'command-eve.external-action-policy-kill':
      return providerPayload(providerKey, {
        context_token: `policy-context:v1:${'a'.repeat(64)}`,
        enabled: true,
      });
    case 'command-eve.external-action-policy-revoke':
      return providerPayload(providerKey, { context_token: `policy-context:v1:${'a'.repeat(64)}` });
    case 'command-eve.kanban-marketing-board':
      return providerPayload(providerKey, { boardSlug: 'default' });
    case 'command-eve.kanban-marketing-card-create':
      return providerPayload(providerKey, {
        title: 'Customer task',
        lane_key: 'research',
        client_token: 'customer-task-1',
        expectedSeatId: 'seat-1',
        boardSlug: 'default',
      });
    case 'command-eve.kanban-marketing-card-move':
      return providerPayload(providerKey, { task_id: 'task-1', to_lane_key: 'draft', boardSlug: 'default' });
    case 'command-eve.kanban-marketing-card-action':
      return providerPayload(providerKey, { task_id: 'task-1', action: 'complete', boardSlug: 'default' });
    case 'command-eve.kanban-marketing-dispatch-plan':
      return providerPayload(providerKey, {
        task_id: 'task-1',
        command: 'decompose',
        expectedSeatId: 'seat-1',
        boardSlug: 'default',
      });
    case 'command-eve.report-export':
      return providerPayload(providerKey, {
        format: 'pdf',
        markdown: '# Customer report',
        seatId: 'seat-1',
        outputPath: '/tmp/customer-report.pdf',
        title: 'Customer report',
      });
    case 'command-eve.report-stage-workspace':
      return providerPayload(providerKey, {
        conversation_id: 'conversation-1',
        turn_id: 'turn-1',
        tool_call_id: 'tool-call-1',
        markdown: '# Recovered report',
        suggested_name: 'recovered-report.md',
      });
    case 'command-eve.team-manage-apply':
    case 'command-eve.team-manage-reject':
    case 'command-eve.kanban-acp-reject':
      return providerPayload(providerKey, { intent_id: 'intent-1' });
    case 'command-eve.kanban-acp-apply':
      return providerPayload(providerKey, { intent_id: 'intent-1', mutation_hash: 'sha256:abc' });
    case 'command-eve.cloud-visual-policy-receipt':
      return providerPayload(providerKey, { flowId: 'visual_flow_0123456789abcdef' });
    case 'command-eve.cloud-visual-policy-set':
      return providerPayload(providerKey, { expectedSeatId: 'seat-1', enabled: false });
    case 'command-eve.image-prepare':
      return providerPayload(providerKey, { filePaths: ['/tmp/image.png'] });
    case 'command-eve.presentation-prepare':
      return providerPayload(providerKey, { filePaths: ['/tmp/deck.pptx'] });
    case 'command-eve.managed-visual-turn-authorize':
      return providerPayload(providerKey, {
        flowId: 'visual_flow_0123456789abcdef',
        visualPolicyReceipt: {
          version: 'command-eve-cloud-visual-policy/v1',
          receiptId: 'r'.repeat(43),
          flowId: 'visual_flow_0123456789abcdef',
          expiresAt: '2026-07-29T00:05:00.000Z',
        },
        preferredTier: 'high',
        sourceCount: 1,
      });
    case 'update-system-info':
      return providerPayload(providerKey, { cacheDir: '/tmp/cache', workDir: '/tmp/work' });
    default:
      return RENDERER_PROVIDER_PAYLOAD_CLASSES[providerKey] === 'void'
        ? providerPayload(providerKey)
        : providerPayload(providerKey, {});
  }
}

async function setup(rendererUrl?: string): Promise<{
  webContents: FakeWebContents;
  handler: NonNullable<typeof state.handler>;
}> {
  const module = await import('@/common/adapter/main');
  const url =
    rendererUrl ??
    (state.isPackaged
      ? pathToFileURL('/app/out/renderer/index.html').href
      : (process.env.ELECTRON_RENDERER_URL ?? 'http://127.0.0.1:5173/app'));
  const webContents = { mainFrame: { url }, isDestroyed: () => false };
  const window = { webContents, isDestroyed: () => false, on: vi.fn() };
  module.initMainAdapterWithWindow(window as never);
  if (!state.handler) throw new Error('adapter handler was not registered');
  return { webContents, handler: state.handler };
}

describe('main adapter IPC trust boundary', () => {
  it('allows a registered main-frame sender', async () => {
    const { webContents, handler } = await setup();

    await handler({ sender: webContents, senderFrame: webContents.mainFrame }, providerPayload('update.check', {}));

    expect(state.emitter.emit).toHaveBeenCalledWith('subscribe-update.check', {
      id: 'update.checkdeadbeef',
      data: {},
    });
  });

  it('blocks an unregistered renderer before dispatch', async () => {
    const { handler } = await setup();
    const foreign = { mainFrame: { url: 'http://127.0.0.1:5173/app' }, isDestroyed: () => false };

    expect(() =>
      handler({ sender: foreign, senderFrame: foreign.mainFrame }, providerPayload('command-eve.entitlement-status'))
    ).toThrow('untrusted');
    expect(state.emitter.emit).not.toHaveBeenCalled();
  });

  it('blocks subframes from a trusted window', async () => {
    const { webContents, handler } = await setup();

    expect(() =>
      handler(
        { sender: webContents, senderFrame: { url: 'http://127.0.0.1:5173/app' } },
        providerPayload('update.check')
      )
    ).toThrow('untrusted');
    expect(state.emitter.emit).not.toHaveBeenCalled();
  });

  it('blocks a registered main frame after navigation outside the configured renderer boundary', async () => {
    const { webContents, handler } = await setup('https://attacker.example/');

    expect(() =>
      handler({ sender: webContents, senderFrame: webContents.mainFrame }, providerPayload('update.check'))
    ).toThrow('untrusted');
    expect(state.emitter.emit).not.toHaveBeenCalled();
  });

  it('blocks a development renderer on the wrong origin', async () => {
    const { webContents, handler } = await setup('http://127.0.0.1:9999/app');

    expect(() =>
      handler({ sender: webContents, senderFrame: webContents.mainFrame }, providerPayload('update.check'))
    ).toThrow('untrusted');
    expect(state.emitter.emit).not.toHaveBeenCalled();
  });

  it.each([{ senderFrame: undefined }, { senderFrame: null }])(
    'blocks a trusted window when senderFrame is $senderFrame',
    async ({ senderFrame }) => {
      const { webContents, handler } = await setup();

      expect(() => handler({ sender: webContents, senderFrame }, providerPayload('update.check'))).toThrow('untrusted');
      expect(state.emitter.emit).not.toHaveBeenCalled();
    }
  );

  it('blocks destroyed senders before dispatch', async () => {
    const { webContents, handler } = await setup();
    const destroyed = { ...webContents, isDestroyed: () => true };

    expect(() =>
      handler({ sender: destroyed, senderFrame: destroyed.mainFrame }, providerPayload('update.check'))
    ).toThrow('untrusted');
    expect(state.emitter.emit).not.toHaveBeenCalled();
  });

  it('rejects malformed and oversized payloads before dispatch', async () => {
    const { webContents, handler } = await setup();
    const event = { sender: webContents, senderFrame: webContents.mainFrame };

    expect(() => handler(event, '{')).toThrow();
    expect(() => handler(event, JSON.stringify({ name: '', data: {} }))).toThrow();
    expect(() => handler(event, 'x'.repeat(50 * 1024 * 1024 + 1))).toThrow('size');
    expect(state.emitter.emit).not.toHaveBeenCalled();
  });

  it('rejects unknown exact names, prefix lookalikes and raw emitter names', async () => {
    const { webContents, handler } = await setup();
    const event = { sender: webContents, senderFrame: webContents.mainFrame };

    expect(() => handler(event, providerPayload('command-eve.entitlement-status-extra'))).toThrow('unknown');
    expect(() => handler(event, providerPayload('command-eve.'))).toThrow('unknown');
    expect(() =>
      handler(event, JSON.stringify({ name: 'update.open', data: { id: 'update.opendeadbeef', data: {} } }))
    ).toThrow('unknown');
    expect(state.emitter.emit).not.toHaveBeenCalled();
  });

  it('rejects provider envelopes without an exact platform invocation id', async () => {
    const { webContents, handler } = await setup();
    const event = { sender: webContents, senderFrame: webContents.mainFrame };
    const name = 'subscribe-update.check';

    expect(() => handler(event, JSON.stringify({ name, data: null }))).toThrow('envelope');
    expect(() => handler(event, JSON.stringify({ name, data: {} }))).toThrow('envelope');
    expect(() => handler(event, JSON.stringify({ name, data: { id: 'otherdeadbeef' } }))).toThrow('envelope');
    expect(state.emitter.emit).not.toHaveBeenCalled();
  });

  it('rejects extra provider envelope fields instead of silently forwarding them', async () => {
    const { webContents, handler } = await setup();
    const event = { sender: webContents, senderFrame: webContents.mainFrame };
    const payload = JSON.stringify({
      name: 'subscribe-update.check',
      data: { id: 'update.checkdeadbeef', data: {}, privileged: true },
    });

    expect(() => handler(event, payload)).toThrow('envelope');
    expect(state.emitter.emit).not.toHaveBeenCalled();
  });

  it('rejects data on void providers and missing or non-record data on required-record providers', async () => {
    const { webContents, handler } = await setup();
    const event = { sender: webContents, senderFrame: webContents.mainFrame };

    expect(() => handler(event, providerPayload('command-eve.entitlement-status', {}))).toThrow('expected void');
    expect(() => handler(event, providerPayload('update.check'))).toThrow('expected record');
    expect(() => handler(event, providerPayload('update.check', null))).toThrow('expected record');
    expect(() => handler(event, providerPayload('update.check', []))).toThrow('expected record');
    expect(state.emitter.emit).not.toHaveBeenCalled();
  });

  it('accepts an omitted optional record but rejects scalar optional payloads', async () => {
    const { webContents, handler } = await setup();
    const event = { sender: webContents, senderFrame: webContents.mainFrame };

    await handler(event, providerPayload('command-eve.connector-catalog'));
    expect(state.emitter.emit).toHaveBeenCalledWith('subscribe-command-eve.connector-catalog', {
      id: 'command-eve.connector-catalogdeadbeef',
    });

    expect(() => handler(event, providerPayload('command-eve.connector-catalog', 'all'))).toThrow(
      'expected optional record'
    );
    expect(state.emitter.emit).toHaveBeenCalledTimes(1);
  });

  it('recursively blocks prototype keys and excessive object nesting', async () => {
    const { webContents, handler } = await setup();
    const event = { sender: webContents, senderFrame: webContents.mainFrame };
    const prototypePayload =
      '{"name":"subscribe-update.check","data":{"id":"update.checkdeadbeef","data":{"nested":{"__proto__":{"admin":true}}}}}';
    const constructorPayload =
      '{"name":"subscribe-update.check","data":{"id":"update.checkdeadbeef","data":{"nested":{"constructor":{"prototype":{"admin":true}}}}}}';
    const deeplyNested: Record<string, unknown> = {};
    let cursor = deeplyNested;
    for (let index = 0; index < 18; index++) {
      const next: Record<string, unknown> = {};
      cursor.next = next;
      cursor = next;
    }

    expect(() => handler(event, prototypePayload)).toThrow('prototype key');
    expect(() => handler(event, constructorPayload)).toThrow('prototype key');
    expect(() => handler(event, providerPayload('update.check', deeplyNested))).toThrow('nesting depth');
    expect(state.emitter.emit).not.toHaveBeenCalled();
  });

  it('enforces exact Main visual-policy receipt, mutation, preparation, and marker schemas', async () => {
    const { webContents, handler } = await setup();
    const event = { sender: webContents, senderFrame: webContents.mainFrame };

    await Promise.all(
      [
        'command-eve.cloud-visual-policy-receipt',
        'command-eve.cloud-visual-policy-set',
        'command-eve.image-prepare',
        'command-eve.presentation-prepare',
        'command-eve.managed-visual-turn-authorize',
      ].map((providerKey) => handler(event, validProviderPayload(providerKey as RendererProviderKey)))
    );
    expect(state.emitter.emit).toHaveBeenCalledTimes(5);

    expect(() =>
      handler(
        event,
        providerPayload('command-eve.cloud-visual-policy-receipt', {
          flowId: 'visual_flow_0123456789abcdef',
          seatId: 'forged-seat',
        })
      )
    ).toThrow('payload keys');
    expect(() =>
      handler(
        event,
        providerPayload('command-eve.cloud-visual-policy-set', { expectedSeatId: 'seat-1', enabled: 'true' })
      )
    ).toThrow('mutation');
    expect(() =>
      handler(
        event,
        providerPayload('command-eve.image-prepare', {
          filePaths: ['/tmp/image.png'],
          visualPolicyReceipt: { version: 'wrong' },
        })
      )
    ).toThrow('receipt');
    expect(() =>
      handler(
        event,
        providerPayload('command-eve.managed-visual-turn-authorize', {
          consentVersion: 'command-eve-managed-visual-turn-consent/v1',
          sourceCount: 1,
        })
      )
    ).toThrow('flow id');
    expect(state.emitter.emit).toHaveBeenCalledTimes(5);
  });

  it('rejects secret-bearing or stale-shape external-action payloads before Main dispatch', async () => {
    const { webContents, handler } = await setup();
    const event = { sender: webContents, senderFrame: webContents.mainFrame };
    await Promise.all(
      [
        'command-eve.external-action-execute',
        'command-eve.external-action-resume',
        'command-eve.external-action-policy-set',
        'command-eve.external-action-policy-kill',
        'command-eve.external-action-policy-revoke',
      ].map((providerKey) => handler(event, validProviderPayload(providerKey as RendererProviderKey)))
    );
    expect(state.emitter.emit).toHaveBeenCalledTimes(5);

    const execution = JSON.parse(validProviderPayload('command-eve.external-action-execute')) as {
      data: { data: Record<string, unknown> };
    };
    execution.data.data.secret = 'synthetic-plaintext-secret';
    expect(() => handler(event, JSON.stringify(execution))).toThrow('external-action execution');
    expect(() =>
      handler(
        event,
        providerPayload('command-eve.external-action-resume', {
          version: 'command-eve-external-action-resume/v1',
          resumeRef: 'resume-ref-a',
          userActionDigest: `sha256:${'c'.repeat(64)}`,
        })
      )
    ).toThrow('external-action resume');
    expect(() =>
      handler(
        event,
        providerPayload('command-eve.external-action-policy-set', {
          context_token: `policy-context:v1:${'a'.repeat(64)}`,
          mutation: {},
          seedId: 'forged-seed',
        })
      )
    ).toThrow('mutation keys');
    expect(() =>
      handler(
        event,
        providerPayload('command-eve.external-action-policy-kill', {
          context_token: `policy-context:v1:${'a'.repeat(64)}`,
          enabled: 'true',
        })
      )
    ).toThrow('kill-switch');
    expect(() =>
      handler(
        event,
        providerPayload('command-eve.external-action-policy-revoke', {
          context_token: `policy-context:v1:${'a'.repeat(64)}`,
          extra: true,
        })
      )
    ).toThrow('payload keys');
    expect(state.emitter.emit).toHaveBeenCalledTimes(5);
  });

  it('accepts only the exact string-path schema for update-system-info', async () => {
    const { webContents, handler } = await setup();
    const event = { sender: webContents, senderFrame: webContents.mainFrame };

    await handler(event, validProviderPayload('update-system-info'));
    expect(state.emitter.emit).toHaveBeenCalledTimes(1);

    expect(() => handler(event, providerPayload('update-system-info', { cacheDir: '/tmp/cache' }))).toThrow('workDir');
    expect(() =>
      handler(event, providerPayload('update-system-info', { cacheDir: '/tmp/cache', workDir: '/tmp/work', root: '/' }))
    ).toThrow('payload keys');
    expect(() =>
      handler(event, providerPayload('update-system-info', { cacheDir: '/tmp/cache', workDir: '/tmp/work', logDir: 1 }))
    ).toThrow('logDir');
    expect(state.emitter.emit).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['command-eve.team-manage-apply', { intent_id: '' }],
    ['command-eve.team-manage-reject', { intent_id: 'intent-1', extra: true }],
    ['command-eve.kanban-acp-apply', { intent_id: 'intent-1' }],
    ['command-eve.kanban-acp-reject', { intent_id: 42 }],
  ] as const)('rejects schema-invalid high-risk intent payload for %s', async (providerKey, data) => {
    process.env.COMMAND_EVE_FOUNDER_BUILD = '1';
    const { webContents, handler } = await setup();
    const event = { sender: webContents, senderFrame: webContents.mainFrame };

    expect(() => handler(event, providerPayload(providerKey, data))).toThrow('provider event payload');
    expect(state.emitter.emit).not.toHaveBeenCalled();
  });

  it.each([...FOUNDER_ONLY_PROVIDER_KEYS])(
    'denies founder-only provider %s in customer mode and accepts it with the main-owned flag',
    async (providerKey) => {
      const { webContents, handler } = await setup();
      const event = { sender: webContents, senderFrame: webContents.mainFrame };
      const payload = validProviderPayload(providerKey);
      const expectedEnvelope = (JSON.parse(payload) as { data: unknown }).data;

      expect(() => handler(event, payload)).toThrow('founder-only');
      expect(state.emitter.emit).not.toHaveBeenCalled();

      process.env.COMMAND_EVE_FOUNDER_BUILD = '1';
      await handler(event, payload);
      expect(state.emitter.emit).toHaveBeenCalledWith(`subscribe-${providerKey}`, expectedEnvelope);
    }
  );

  it.each(['command-eve.kanban-acp-peek', 'command-eve.kanban-acp-apply', 'command-eve.kanban-acp-reject'] as const)(
    'allows governed Kanban confirmation transport in packaged operator mode: %s',
    async (providerKey) => {
      state.isPackaged = true;
      const { webContents, handler } = await setup();
      const event = { sender: webContents, senderFrame: webContents.mainFrame };
      const payload = validProviderPayload(providerKey);
      const expectedEnvelope = (JSON.parse(payload) as { data: unknown }).data;

      await handler(event, payload);
      expect(state.emitter.emit).toHaveBeenCalledWith(`subscribe-${providerKey}`, expectedEnvelope);
    }
  );

  it('never promotes a packaged customer build through COMMAND_EVE_FOUNDER_BUILD', async () => {
    state.isPackaged = true;
    process.env.COMMAND_EVE_FOUNDER_BUILD = '1';
    const { webContents, handler } = await setup();
    const event = { sender: webContents, senderFrame: webContents.mainFrame };

    expect(() => handler(event, validProviderPayload('open-dev-tools'))).toThrow('founder-only');
    expect(state.emitter.emit).not.toHaveBeenCalled();
  });

  it.each([...CUSTOMER_DEFAULT_KANBAN_PROVIDER_KEYS])(
    'allows %s for the public default board without widening founder boards',
    async (providerKey) => {
      const { webContents, handler } = await setup();
      const event = { sender: webContents, senderFrame: webContents.mainFrame };
      const payload = validProviderPayload(providerKey);
      const expectedEnvelope = (JSON.parse(payload) as { data: unknown }).data;

      await handler(event, payload);
      expect(state.emitter.emit).toHaveBeenCalledWith(`subscribe-${providerKey}`, expectedEnvelope);

      const data = (expectedEnvelope as { data: Record<string, unknown> }).data;
      expect(() => handler(event, providerPayload(providerKey, { ...data, boardSlug: 'marketing' }))).toThrow(
        'founder-only Kanban board'
      );
    }
  );

  it('keeps event-ledger path injection founder-only on conditional Kanban mutations', async () => {
    const { webContents, handler } = await setup();
    const event = { sender: webContents, senderFrame: webContents.mainFrame };
    const request = {
      title: 'Customer task',
      lane_key: 'research',
      client_token: 'customer-task-2',
      expectedSeatId: 'seat-1',
      boardSlug: 'default',
      eventLedgerPath: '/tmp/forged-ledger.jsonl',
    };

    expect(() => handler(event, providerPayload('command-eve.kanban-marketing-card-create', request))).toThrow(
      'payload keys'
    );

    process.env.COMMAND_EVE_FOUNDER_BUILD = '1';
    await handler(event, providerPayload('command-eve.kanban-marketing-card-create', request));
    expect(state.emitter.emit).toHaveBeenCalledTimes(1);
  });

  it('requires an exact seat fence on the founder-only marketing dispatch plan', async () => {
    process.env.COMMAND_EVE_FOUNDER_BUILD = '1';
    const { webContents, handler } = await setup();
    const event = { sender: webContents, senderFrame: webContents.mainFrame };

    expect(() =>
      handler(
        event,
        providerPayload('command-eve.kanban-marketing-dispatch-plan', {
          task_id: 'task-1',
          command: 'decompose',
          boardSlug: 'default',
        })
      )
    ).toThrow('expectedSeatId');

    await handler(
      event,
      providerPayload('command-eve.kanban-marketing-dispatch-plan', {
        task_id: 'task-1',
        command: 'decompose',
        expectedSeatId: 'seat-1',
        boardSlug: 'default',
      })
    );
    expect(state.emitter.emit).toHaveBeenCalledTimes(1);
  });

  it('allows customer report export through its exact schema and rejects arbitrary relative targets', async () => {
    const { webContents, handler } = await setup();
    const event = { sender: webContents, senderFrame: webContents.mainFrame };

    await handler(event, validProviderPayload('command-eve.report-export'));
    expect(state.emitter.emit).toHaveBeenCalledTimes(1);

    expect(() =>
      handler(
        event,
        providerPayload('command-eve.report-export', {
          format: 'pdf',
          markdown: '# Report',
          seatId: 'seat-1',
          outputPath: 'relative/report.pdf',
        })
      )
    ).toThrow('outputPath');
    expect(state.emitter.emit).toHaveBeenCalledTimes(1);
  });

  it('allows pathless report staging only through its exact bounded schema', async () => {
    const { webContents, handler } = await setup();
    const event = { sender: webContents, senderFrame: webContents.mainFrame };

    await handler(event, validProviderPayload('command-eve.report-stage-workspace'));
    expect(state.emitter.emit).toHaveBeenCalledTimes(1);

    for (const invalid of [
      {
        conversation_id: 'conversation-1',
        turn_id: 'turn-1',
        tool_call_id: 'tool-call-1',
        markdown: '# Report',
        suggested_name: '../report.md',
      },
      {
        conversation_id: 'conversation-1',
        turn_id: '',
        tool_call_id: 'tool-call-1',
        markdown: '# Report',
        suggested_name: 'report.md',
      },
      {
        conversation_id: 'conversation-1',
        turn_id: 'turn-1',
        tool_call_id: 'tool-call-1',
        markdown: '# Report',
        suggested_name: 'report.md',
        workspace: '/tmp',
      },
    ]) {
      expect(() => handler(event, providerPayload('command-eve.report-stage-workspace', invalid))).toThrow(
        'report-stage-workspace'
      );
    }
    expect(state.emitter.emit).toHaveBeenCalledTimes(1);
  });
});

const collectTypeScriptFiles = (root: string): string[] => {
  const result: string[] = [];
  const visit = (directory: string) => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const target = path.join(directory, entry.name);
      if (entry.isDirectory()) visit(target);
      else if (/\.tsx?$/.test(entry.name)) result.push(target);
    }
  };
  visit(root);
  return result;
};

type SourceProviderDeclaration = Readonly<{ key: string; payloadClass: ProviderPayloadClass }>;

const classifySourceProviderPayload = (node: ts.CallExpression, source: ts.SourceFile): ProviderPayloadClass => {
  const typeText = node.typeArguments?.[1]?.getText(source) ?? 'undefined';
  const members = typeText
    .replaceAll(/\s+/g, ' ')
    .split('|')
    .map((member) => member.trim());
  const hasVoid = members.some((member) => member === 'void' || member === 'undefined');
  const hasRecord = members.some((member) => member !== 'void' && member !== 'undefined');
  return hasVoid && hasRecord ? 'optional-record' : hasRecord ? 'record' : 'void';
};

const extractProviderDeclarations = (filePath: string): SourceProviderDeclaration[] => {
  const sourceText = fs.readFileSync(filePath, 'utf8');
  const source = ts.createSourceFile(
    filePath,
    sourceText,
    ts.ScriptTarget.Latest,
    true,
    filePath.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS
  );
  const constants = new Map<string, string>();
  const declarations: SourceProviderDeclaration[] = [];

  const collectConstants = (node: ts.Node) => {
    if (
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      node.initializer &&
      ts.isStringLiteral(node.initializer)
    ) {
      constants.set(node.name.text, node.initializer.text);
    }
    ts.forEachChild(node, collectConstants);
  };
  collectConstants(source);

  const collectProviders = (node: ts.Node) => {
    if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      node.expression.name.text === 'buildProvider'
    ) {
      const argument = node.arguments[0];
      const key = ts.isStringLiteral(argument)
        ? argument.text
        : ts.isIdentifier(argument)
          ? constants.get(argument.text)
          : undefined;
      if (!key) {
        const line = source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1;
        throw new Error(`Unresolved renderer provider key at ${path.relative(process.cwd(), filePath)}:${line}`);
      }
      declarations.push({ key, payloadClass: classifySourceProviderPayload(node, source) });
    }
    ts.forEachChild(node, collectProviders);
  };
  collectProviders(source);
  return declarations;
};

const mergeSourcePayloadClasses = (classes: readonly ProviderPayloadClass[]): ProviderPayloadClass => {
  const values = new Set(classes);
  if (values.has('optional-record') || (values.has('void') && values.has('record'))) return 'optional-record';
  return values.has('record') ? 'record' : 'void';
};

describe('main adapter source-derived wire registry', () => {
  it('accepts the exact provider envelope emitted by the installed Office AI platform', async () => {
    const platform = await vi.importActual<typeof import('@office-ai/platform')>('@office-ai/platform');
    let observed: { name: string; data: unknown } | null = null;
    let platformEmitter: { emit: (name: string, data: unknown) => void } | null = null;

    platform.bridge.adapter({
      emit(name, data) {
        observed = { name, data };
        const invocation = data as { id: string };
        queueMicrotask(() => platformEmitter?.emit(`subscribe.callback-update.check${invocation.id}`, { ok: true }));
      },
      on(emitter) {
        platformEmitter = emitter;
      },
    });

    await platform.bridge.buildProvider<{ ok: boolean }, Record<string, never>>('update.check').invoke({});
    expect(observed).not.toBeNull();
    expect(
      parseRendererToMainAdapterEvent(JSON.stringify(observed), {
        maxPayloadBytes: 50 * 1024 * 1024,
        founderBuild: false,
      })
    ).toEqual(observed);
  });

  it('holds the SAME KEY SET as every provider DECLARED in src/common + src/renderer', () => {
    // WHAT THIS DOES AND DOES NOT CHECK — the name used to say "stays byte-exact
    // with every renderer-callable provider declaration", and neither half was
    // true of the code:
    //
    //   NOT BYTE-EXACT. It compares two SORTED SETS of key strings. Ordering,
    //   duplicates within the source, and every byte of the surrounding
    //   declaration are outside it. (The registry's own uniqueness IS checked, on
    //   the last line.) The payload CLASS per key is a separate contract, frozen
    //   by the next test.
    //
    //   NOT EVERY DECLARATION. The scan covers src/common and src/renderer only.
    //   There are 19 further `buildProvider<...>` sites in src/process, src/preload
    //   and src/index.ts. Widening the roots was attempted and is NOT a rename
    //   away: the extractor requires a string-literal key and those trees declare
    //   some through constants (e.g. commandEveBridge.ts:1802,
    //   index.ts TELEMETRY_CONSENT_GET_CHANNEL), so it throws
    //   "Unresolved renderer provider key" rather than reporting a drift. Resolving
    //   constants across modules is a real extractor change, not in this scope.
    //
    // The gap that scope leaves is covered directly below, so "out of scope" does
    // not quietly mean "unchecked".
    const declarations = ['packages/desktop/src/common', 'packages/desktop/src/renderer'].flatMap((root) =>
      collectTypeScriptFiles(path.join(process.cwd(), root)).flatMap(extractProviderDeclarations)
    );
    const sourceProviderKeys = new Set(declarations.map(({ key }) => key));

    expect([...RENDERER_PROVIDER_KEYS].toSorted()).toEqual([...sourceProviderKeys].toSorted());
    expect(new Set(RENDERER_PROVIDER_KEYS).size).toBe(RENDERER_PROVIDER_KEYS.length);
  });

  it('MAIN-SIDE declarations introduce no key the renderer registry does not already know', () => {
    // The scope gap above, closed for every key that can be read without a
    // constant resolver: a literal `buildProvider<...>('some.key')` anywhere in
    // src/process, src/preload or src/index.ts must already be a registered
    // renderer-callable key. A main-side handler for a key the registry has never
    // heard of is either an unpoliced wire entry or a dead handler; both are worth
    // a red build, and neither was visible before.
    const roots = ['packages/desktop/src/process', 'packages/desktop/src/preload'];
    const files = roots.flatMap((root) => collectTypeScriptFiles(path.join(process.cwd(), root)));
    files.push(path.join(process.cwd(), 'packages/desktop/src/index.ts'));

    const registered = new Set<string>(RENDERER_PROVIDER_KEYS);
    const literalKey = /\bbuildProvider\s*(?:<[\s\S]*?>)?\s*\(\s*(['"])([\w.$-]+)\1/g;
    const unknown: string[] = [];
    let literalsSeen = 0;

    for (const file of files) {
      const source = fs.readFileSync(file, 'utf8');
      for (const match of source.matchAll(literalKey)) {
        literalsSeen += 1;
        const key = match[2];
        if (!registered.has(key)) unknown.push(`${path.relative(process.cwd(), file)} -> ${key}`);
      }
    }

    // A regex that stops matching would otherwise "pass" by finding nothing.
    expect(literalsSeen, 'no literal buildProvider key found in the main tree — the scan has drifted').toBeGreaterThan(
      10
    );
    expect(unknown, 'main-side provider keys missing from RENDERER_PROVIDER_KEYS').toEqual([]);
  });

  it('freezes an explicit source-derived payload class for every registered provider', () => {
    const declarations = ['packages/desktop/src/common', 'packages/desktop/src/renderer'].flatMap((root) =>
      collectTypeScriptFiles(path.join(process.cwd(), root)).flatMap(extractProviderDeclarations)
    );
    const byKey = new Map<string, ProviderPayloadClass[]>();
    for (const declaration of declarations) {
      const classes = byKey.get(declaration.key) ?? [];
      classes.push(declaration.payloadClass);
      byKey.set(declaration.key, classes);
    }
    const sourceClasses = Object.fromEntries(
      [...byKey.entries()].map(([key, classes]) => [key, mergeSourcePayloadClasses(classes)])
    );

    expect(Object.keys(RENDERER_PROVIDER_PAYLOAD_CLASSES).toSorted()).toEqual([...RENDERER_PROVIDER_KEYS].toSorted());
    expect(RENDERER_PROVIDER_PAYLOAD_CLASSES).toEqual(sourceClasses);
  });

  it('main-authorizes marketing providers as founder-only except the default-board customer subset', () => {
    const marketingProviders = RENDERER_PROVIDER_KEYS.filter((key) => key.startsWith('command-eve.kanban-marketing-'));

    expect(marketingProviders.length).toBeGreaterThan(0);
    expect(
      marketingProviders.every(
        (key) => FOUNDER_ONLY_PROVIDER_KEYS.has(key) || CUSTOMER_DEFAULT_KANBAN_PROVIDER_KEYS.has(key)
      )
    ).toBe(true);
    expect([...CUSTOMER_DEFAULT_KANBAN_PROVIDER_KEYS].toSorted()).toEqual(
      [
        'command-eve.kanban-marketing-board',
        'command-eve.kanban-marketing-card-action',
        'command-eve.kanban-marketing-card-create',
        'command-eve.kanban-marketing-card-move',
      ].toSorted()
    );
    expect([...CUSTOMER_DEFAULT_KANBAN_PROVIDER_KEYS].every((key) => !FOUNDER_ONLY_PROVIDER_KEYS.has(key))).toBe(true);
    expect(
      ['command-eve.kanban-acp-peek', 'command-eve.kanban-acp-apply', 'command-eve.kanban-acp-reject'].every(
        (key) => !FOUNDER_ONLY_PROVIDER_KEYS.has(key as never)
      )
    ).toBe(true);
  });

  it('never accepts platform callback or raw emitter directions from the renderer', () => {
    expect(getRendererToMainAdapterPolicy('subscribe.callback-update.checkforged')).toBeNull();
    expect(getRendererToMainAdapterPolicy('update.open')).toBeNull();
  });

  it('keeps the sole renderer ipcBridge emitter on its transportless WS-local compatibility seam', () => {
    const rendererEmitCalls = collectTypeScriptFiles(path.join(process.cwd(), 'packages/desktop/src/renderer')).flatMap(
      (filePath) => {
        const source = fs.readFileSync(filePath, 'utf8');
        return [...source.matchAll(/\bipcBridge(?:\.[A-Za-z_$][\w$]*)+\.emit\s*\(/g)].map((match) => ({
          file: path.relative(process.cwd(), filePath),
          expression: match[0].replace(/\s*\($/, ''),
        }));
      }
    );
    const electronAdapterEmit = vi.fn();
    vi.stubGlobal('window', { electronAPI: { emit: electronAdapterEmit } });

    wsEmitter<{ type: string }>('message.stream').emit({ type: 'error' });

    expect(rendererEmitCalls).toEqual([
      {
        file: 'packages/desktop/src/renderer/pages/conversation/platforms/acp/AcpSendBox.tsx',
        expression: 'ipcBridge.acpConversation.responseStream.emit',
      },
    ]);
    expect(electronAdapterEmit).not.toHaveBeenCalled();
    expect(getRendererToMainAdapterPolicy('message.stream')).toBeNull();
  });
});

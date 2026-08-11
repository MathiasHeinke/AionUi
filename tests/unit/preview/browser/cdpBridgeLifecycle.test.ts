import { EventEmitter, once } from 'node:events';

import { afterEach, describe, expect, it, vi } from 'vitest';
import WebSocket from 'ws';

const electronState = vi.hoisted(() => ({ sessions: new Map<string, object>() }));

vi.mock('electron', () => ({
  session: {
    fromPartition: (partition: string) => {
      let value = electronState.sessions.get(partition);
      if (!value) {
        value = { partition };
        electronState.sessions.set(partition, value);
      }
      return value;
    },
  },
}));

class FakeDebugger extends EventEmitter {
  attached = false;
  attachCount = 0;
  detachCount = 0;
  commands: string[] = [];

  isAttached = () => this.attached;
  attach = () => {
    this.attached = true;
    this.attachCount += 1;
  };
  detach = () => {
    this.attached = false;
    this.detachCount += 1;
  };
  sendCommand = async (method: string) => {
    this.commands.push(method);
    return {};
  };
}

class FakeWebContents extends EventEmitter {
  readonly debugger = new FakeDebugger();
  readonly session: object;
  private destroyed = false;

  constructor(
    readonly id: number,
    partition: string,
    private url = 'https://example.com/'
  ) {
    super();
    this.session = electronState.sessions.get(partition) ?? { partition };
    electronState.sessions.set(partition, this.session);
  }

  getType = () => 'webview';
  getTitle = () => `Browser ${this.id}`;
  getURL = () => this.url;
  isDestroyed = () => this.destroyed;
  destroyGuest = () => {
    this.destroyed = true;
    this.emit('destroyed');
  };
}

type Bridge = Awaited<ReturnType<(typeof import('@process/resources/builtinMcp/cdpBridge'))['startCdpBridge']>>;
let bridge: Bridge | null = null;

const epoch = (digit: string) => digit.repeat(32);
const partitionFor = (context: string) => `persist:command-eve-browser-${context}`;

afterEach(async () => {
  await bridge?.close();
  bridge = null;
  electronState.sessions.clear();
  vi.restoreAllMocks();
});

describe('single-target CDP bridge lifecycle', () => {
  it('keeps A2 attached when late A1 announce/destroy/release races arrive', async () => {
    const { startCdpBridge } = await import('@process/resources/builtinMcp/cdpBridge');
    bridge = await startCdpBridge();
    const aContext = 'a'.repeat(32);
    const bContext = 'b'.repeat(32);

    bridge.activateContext(aContext, partitionFor(aContext), epoch('1'));
    const a1 = new FakeWebContents(11, partitionFor(aContext));
    expect(bridge.registerGuest(a1 as never)).toEqual({ ok: true });
    const a1Attach = bridge.attach(a1.id, aContext, epoch('1'));
    expect(a1Attach.ok).toBe(true);
    if (!a1Attach.ok) return;
    const duplicate = bridge.attach(a1.id, aContext, epoch('1'));
    expect(duplicate).toEqual(a1Attach);
    expect(a1.debugger.attachCount).toBe(1);
    const lateA1Destroyed = a1.listeners('destroyed').at(-1) as () => void;

    bridge.activateContext(bContext, partitionFor(bContext), epoch('2'));
    const b = new FakeWebContents(22, partitionFor(bContext));
    bridge.registerGuest(b as never);
    expect(bridge.attach(b.id, bContext, epoch('2')).ok).toBe(true);

    bridge.activateContext(aContext, partitionFor(aContext), epoch('3'));
    const a2 = new FakeWebContents(33, partitionFor(aContext));
    const hiddenA2 = new FakeWebContents(34, partitionFor(aContext));
    bridge.registerGuest(a2 as never);
    bridge.registerGuest(hiddenA2 as never);
    const a2Attach = bridge.attach(a2.id, aContext, epoch('3'));
    expect(a2Attach.ok).toBe(true);
    if (!a2Attach.ok) return;

    expect(bridge.attach(a1.id, aContext, epoch('1')).ok).toBe(false);
    expect(bridge.attach(hiddenA2.id, aContext, epoch('3')).ok).toBe(false);
    lateA1Destroyed();
    expect(
      bridge.release({
        contextId: aContext,
        controlEpoch: epoch('1'),
        webContentsId: a1.id,
        leaseId: a1Attach.leaseId,
      }).ok
    ).toBe(false);
    expect(bridge.attachedWebContentsId()).toBe(a2.id);

    expect(
      bridge.release({
        contextId: aContext,
        controlEpoch: epoch('3'),
        webContentsId: a2.id,
        leaseId: a2Attach.leaseId,
      })
    ).toEqual({ ok: true });
    expect(bridge.attachedWebContentsId()).toBeNull();
  });

  it('advertises no synthetic target before ACK and closes sockets on guest loss', async () => {
    const { startCdpBridge } = await import('@process/resources/builtinMcp/cdpBridge');
    bridge = await startCdpBridge();
    const context = 'c'.repeat(32);
    const activation = bridge.activateContext(context, partitionFor(context), epoch('4'));

    const emptyList = (await fetch(`${activation.cdpUrl}/json/list`).then((response) => response.json())) as unknown[];
    expect(emptyList).toEqual([]);

    const guest = new FakeWebContents(44, partitionFor(context));
    bridge.registerGuest(guest as never);
    expect(bridge.attach(guest.id, context, epoch('4')).ok).toBe(true);
    const list = (await fetch(`${activation.cdpUrl}/json/list`).then((response) => response.json())) as unknown[];
    expect(list).toHaveLength(1);

    const socket = new WebSocket(`${activation.cdpUrl.replace(/^http:/, 'ws:')}/aionui-cdp`);
    await once(socket, 'open');
    const closed = once(socket, 'close');
    guest.emit('render-process-gone', {}, { reason: 'crashed' });
    const [closeCode] = await closed;
    expect(closeCode).toBe(4001);
    expect(bridge.attachedWebContentsId()).toBeNull();
    expect(await fetch(`${activation.cdpUrl}/json/list`).then((response) => response.json())).toEqual([]);

    const recovered = bridge.attach(guest.id, context, epoch('4'));
    expect(recovered.ok).toBe(true);
    bridge.detachActiveTarget('main renderer process exited');
    expect(bridge.attachedWebContentsId()).toBeNull();
    expect(await fetch(`${activation.cdpUrl}/json/list`).then((response) => response.json())).toEqual([]);
  });

  it('rejects unregistered and wrong-partition guests without mutating the current target', async () => {
    const { startCdpBridge } = await import('@process/resources/builtinMcp/cdpBridge');
    bridge = await startCdpBridge();
    const context = 'd'.repeat(32);
    bridge.activateContext(context, partitionFor(context), epoch('5'));
    const visible = new FakeWebContents(55, partitionFor(context));
    bridge.registerGuest(visible as never);
    expect(bridge.attach(visible.id, context, epoch('5')).ok).toBe(true);

    const unregistered = new FakeWebContents(56, partitionFor(context));
    expect(bridge.attach(unregistered.id, context, epoch('5')).ok).toBe(false);
    const wrongPartition = new FakeWebContents(57, partitionFor('foreign'));
    bridge.registerGuest(wrongPartition as never);
    expect(bridge.attach(wrongPartition.id, context, epoch('5')).ok).toBe(false);
    expect(bridge.attachedWebContentsId()).toBe(visible.id);
  });

  it('never forwards an in-flight A input command through B after an epoch switch', async () => {
    const { startCdpBridge } = await import('@process/resources/builtinMcp/cdpBridge');
    bridge = await startCdpBridge();
    const aContext = 'e'.repeat(32);
    const bContext = 'f'.repeat(32);
    const activationA = bridge.activateContext(aContext, partitionFor(aContext), epoch('8'));
    const a = new FakeWebContents(61, partitionFor(aContext));
    bridge.registerGuest(a as never);
    expect(bridge.attach(a.id, aContext, epoch('8')).ok).toBe(true);

    let resolveClassifier!: (value: { result: { value: Record<string, never> } }) => void;
    const classifier = new Promise<{ result: { value: Record<string, never> } }>(
      (resolve) => (resolveClassifier = resolve)
    );
    a.debugger.sendCommand = vi.fn(async (method: string) => {
      a.debugger.commands.push(method);
      if (method === 'Runtime.evaluate') return classifier;
      return {};
    });

    const oldSocket = new WebSocket(`${activationA.cdpUrl.replace(/^http:/, 'ws:')}/aionui-cdp`);
    await once(oldSocket, 'open');
    oldSocket.send(
      JSON.stringify({
        id: 71,
        method: 'Input.dispatchMouseEvent',
        params: { type: 'mousePressed', x: 10, y: 10, button: 'left' },
      })
    );
    for (let attempt = 0; attempt < 20 && !a.debugger.commands.includes('Runtime.evaluate'); attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    expect(a.debugger.commands).toEqual(['Runtime.evaluate']);

    const oldSocketClosed = once(oldSocket, 'close');
    bridge.activateContext(bContext, partitionFor(bContext), epoch('9'));
    const b = new FakeWebContents(62, partitionFor(bContext));
    bridge.registerGuest(b as never);
    expect(bridge.attach(b.id, bContext, epoch('9')).ok).toBe(true);
    await oldSocketClosed;
    resolveClassifier({ result: { value: {} } });
    await new Promise((resolve) => setTimeout(resolve, 10));

    expect(a.debugger.commands).toEqual(['Runtime.evaluate']);
    expect(b.debugger.commands).toEqual([]);
    expect(bridge.attachedWebContentsId()).toBe(b.id);
  });
});

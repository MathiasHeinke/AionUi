import { describe, expect, it } from 'vitest';

import {
  createBrowserControlEpochGate,
  decideBrowserControlAnnouncement,
  isExactBrowserControlLease,
  type BrowserControlLease,
} from '@/common/config/browserWorkbenchControlCore';

const epoch = (digit: string) => digit.repeat(32);

describe('browser workbench control epochs and leases', () => {
  it('rejects a late A1 announcement after A1 -> B -> A2', () => {
    const a1 = { contextId: 'account-a', controlEpoch: epoch('1') };
    const b = { contextId: 'account-b', controlEpoch: epoch('2') };
    const a2 = { contextId: 'account-a', controlEpoch: epoch('3') };

    expect(decideBrowserControlAnnouncement(a1, null, { ...a1, webContentsId: 11 }).kind).toBe('attach');
    expect(decideBrowserControlAnnouncement(b, null, { ...a1, webContentsId: 11 }).kind).toBe('reject');
    expect(decideBrowserControlAnnouncement(a2, null, { ...a1, webContentsId: 11 }).kind).toBe('reject');
    expect(decideBrowserControlAnnouncement(a2, null, { ...a2, webContentsId: 33 }).kind).toBe('attach');
  });

  it('makes the current target idempotent and refuses a hidden target from the same epoch', () => {
    const active = { contextId: 'account-a', controlEpoch: epoch('4') };
    const attached: BrowserControlLease = {
      ...active,
      webContentsId: 41,
      leaseId: epoch('a'),
    };

    expect(decideBrowserControlAnnouncement(active, attached, { ...active, webContentsId: 41 })).toEqual({
      kind: 'idempotent',
      leaseId: epoch('a'),
    });
    expect(decideBrowserControlAnnouncement(active, attached, { ...active, webContentsId: 42 }).kind).toBe('reject');
  });

  it('lets only the exact current lease release or destroy the current target', () => {
    const current: BrowserControlLease = {
      contextId: 'account-a',
      controlEpoch: epoch('5'),
      webContentsId: 52,
      leaseId: epoch('b'),
    };
    expect(isExactBrowserControlLease(current, current)).toBe(true);
    expect(isExactBrowserControlLease(current, { ...current, leaseId: epoch('c') })).toBe(false);
    expect(isExactBrowserControlLease(current, { ...current, controlEpoch: epoch('4') })).toBe(false);
    expect(isExactBrowserControlLease(current, { ...current, webContentsId: 51 })).toBe(false);
  });

  it('retires renderer epochs so delayed A1/B responses cannot overwrite A2', () => {
    const gate = createBrowserControlEpochGate();
    expect(gate.accept(epoch('1'))).toBe(true);
    expect(gate.accept(epoch('2'))).toBe(true);
    expect(gate.accept(epoch('3'))).toBe(true);
    expect(gate.accept(epoch('1'))).toBe(false);
    expect(gate.accept(epoch('2'))).toBe(false);
    expect(gate.current()).toBe(epoch('3'));
  });

  it('keeps retired epochs terminal for the lifetime of the renderer process', () => {
    const gate = createBrowserControlEpochGate();
    const first = '1'.padStart(32, '0');
    expect(gate.accept(first)).toBe(true);
    for (let value = 2; value <= 100; value += 1) {
      expect(gate.accept(value.toString(16).padStart(32, '0'))).toBe(true);
    }
    expect(gate.accept(first)).toBe(false);
  });
});

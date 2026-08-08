/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Settings -> Freigaben: the one-act "full release for this machine".
 *
 * WHAT THIS SUITE IS FOR. The core suite (eveFullAuthority.test.ts) proves the
 * grant the act produces. This one proves the thing a user actually meets: that
 * the confirmation names the real consequences BEFORE the press, that nothing is
 * written until the press, and that walking away writes nothing at all.
 *
 * The load-bearing one is `confirmation_lists_what_the_act_will_open`. A
 * confirmation that says "this grants full access" and one that names the five
 * seals are not the same product — only the second can be disagreed with. So it
 * is asserted against the seals actually opened by the write, not against a
 * fixed string: if the two ever drift, the panel is over-promising and the test
 * says so.
 *
 * The harness is the one from AuthorityModalContent.dom.test.tsx, deliberately
 * duplicated rather than shared: these are the mocks that make the panel
 * testable at all, and a shared copy would let a change made for one suite
 * quietly alter what the other one is measuring.
 */

import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import {
  EVE_SEALED_CAPABILITIES,
  type EveAuthorityGrant,
  type EveSealedCapability,
} from '@/common/config/eveAuthorityCore';
import { grantNeedsAttention } from '@/common/config/eveAuthorityStoreCore';

const store: Record<string, unknown> = {};
const subscribers = new Map<string, Set<() => void>>();

function notifyKey(key: string): void {
  for (const callback of subscribers.get(key) ?? []) callback();
}

const setSpy = vi.fn(async (key: string, value: unknown) => {
  store[key] = value;
  notifyKey(key);
});

/**
 * Close to the real service in the two ways that matter here.
 *
 * `get` is SYNCHRONOUS: `useConfig` hands it to `useSyncExternalStore` as the
 * snapshot, and an async get would return a fresh promise on every render and
 * spin forever. The panel used to await it, which hid that.
 *
 * `subscribe` exists because that is the channel a seat switch arrives on —
 * `rebindSeat` re-homes the cache and re-notifies each seat-scoped key whose
 * value differs under the new seat. A panel that only reads on mount is deaf to
 * it.
 */
vi.mock('@/common/config/configService', () => ({
  configService: {
    get: (key: string) => store[key],
    set: setSpy,
    subscribe: (key: string, callback: () => void) => {
      const forKey = subscribers.get(key) ?? new Set<() => void>();
      forKey.add(callback);
      subscribers.set(key, forKey);
      return () => forKey.delete(callback);
    },
    whenReady: async () => {},
  },
}));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, options?: Record<string, unknown>) => {
      let value = key;
      for (const [name, replacement] of Object.entries(options ?? {})) {
        if (name !== 'defaultValue') value = value.replaceAll(`{{${name}}}`, String(replacement));
      }
      return value;
    },
  }),
}));

vi.mock('@/renderer/components/base/AionScrollArea', () => ({
  default: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}));

vi.mock('@/renderer/components/settings/SettingsSection', () => ({
  default: ({ title, children }: { title: React.ReactNode; children: React.ReactNode }) => (
    <section>
      <h2>{title}</h2>
      {children}
    </section>
  ),
}));

vi.mock('@arco-design/web-react', () => {
  // These stubs cannot be hoisted out of the factory: vitest hoists `vi.mock`
  // above the imports, so a factory closing over an outer binding would read it
  // before initialisation. The lint rule's advice is wrong in this position.
  // eslint-disable-next-line unicorn/consistent-function-scoping
  const RadioGroup = ({
    value,
    onChange,
    children,
  }: {
    value: number;
    onChange: (next: number) => void;
    children: React.ReactNode;
  }) => (
    <div data-testid='ladder' data-value={value} onClick={() => onChange(3)}>
      {children}
    </div>
  );
  // eslint-disable-next-line unicorn/consistent-function-scoping
  const Radio = ({ value, children }: { value: number; children: React.ReactNode }) => (
    <label data-testid={`rung-${value}`}>{children}</label>
  );
  Radio.Group = RadioGroup;
  return {
    Radio,
    // `data-testid` passes THROUGH, falling back to 'forget'.
    //
    // It used to be hardcoded, which made every Button in the panel answer to
    // the same id — so `findAllByTestId('forget')[0]` silently meant "whichever
    // Button renders first", and adding one anywhere above the remembered list
    // broke a test about withdrawing a command. That is a selector pinned to
    // layout order, not to the control it names. The panel's own buttons carry
    // real testids; honouring them here is what lets each test address the one
    // it means.
    Button: ({
      children,
      onClick,
      disabled,
      ...rest
    }: {
      children: React.ReactNode;
      onClick: () => void;
      disabled?: boolean;
      'data-testid'?: string;
    }) => (
      <button data-testid={rest['data-testid'] ?? 'forget'} disabled={disabled} onClick={onClick}>
        {children}
      </button>
    ),
    Switch: ({
      checked,
      onChange,
      ...rest
    }: {
      checked: boolean;
      onChange: (next: boolean) => void;
      'data-testid'?: string;
    }) => (
      <button data-testid={rest['data-testid']} data-checked={String(checked)} onClick={() => onChange(!checked)} />
    ),
    InputNumber: ({
      value,
      onChange,
      ...rest
    }: {
      value?: number;
      onChange: (next: number | undefined) => void;
      'data-testid'?: string;
    }) => (
      <input
        data-testid={rest['data-testid']}
        value={value ?? ''}
        onChange={(event) => onChange(Number(event.target.value))}
      />
    ),
  };
});

const importPanel = async () =>
  (await import('@/renderer/components/settings/SettingsModal/contents/AuthorityModalContent')).default;

// eslint-disable-next-line unicorn/consistent-function-scoping
const lastWrite = (key: string): unknown => setSpy.mock.calls.filter((call) => call[0] === key).at(-1)?.[1];

beforeEach(() => {
  for (const key of Object.keys(store)) delete store[key];
  subscribers.clear();
  setSpy.mockClear();
  vi.resetModules();
});

afterEach(cleanup);

/** Type into the release budget field, in whole currency units. */
async function typeBudget(value: string): Promise<void> {
  const field = (await screen.findByTestId('full-release-budget')) as HTMLInputElement;
  await act(async () => {
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')?.set;
    setter?.call(field, value);
    field.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

async function openConfirmation(): Promise<void> {
  (await screen.findByTestId('full-release-open')).click();
  await screen.findByTestId('full-release-confirm');
}

describe('full release — the confirmation step', () => {
  it('writes nothing until the act is confirmed', async () => {
    store['commandEve.authority'] = { ladder: 1, capabilities: {}, updatedBy: 'user' } satisfies EveAuthorityGrant;
    const Panel = await importPanel();
    render(<Panel />);

    await openConfirmation();
    await typeBudget('50');

    // Reaching the confirmation is not consenting to it.
    expect(setSpy).not.toHaveBeenCalled();
  });

  it('walking away writes nothing and leaves the grant alone', async () => {
    store['commandEve.authority'] = { ladder: 1, capabilities: {}, updatedBy: 'user' } satisfies EveAuthorityGrant;
    const Panel = await importPanel();
    render(<Panel />);

    await openConfirmation();
    await typeBudget('50');
    (await screen.findByTestId('full-release-cancel')).click();

    expect(setSpy).not.toHaveBeenCalled();
    await screen.findByTestId('full-release-open');
  });

  it('confirmation_lists_what_the_act_will_open', async () => {
    // Every seal the panel PROMISES to open must be a seal the write opens.
    store['commandEve.authority'] = {
      ladder: 1,
      capabilities: { 'publish.outward': true },
      grantedAt: { 'publish.outward': '2026-01-01T00:00:00.000Z' },
      updatedBy: 'user',
    } satisfies EveAuthorityGrant;
    const Panel = await importPanel();
    render(<Panel />);

    await openConfirmation();
    await typeBudget('50');

    const promised = [...document.querySelectorAll('[data-testid^="full-release-opens-"]')].map((node) =>
      node.getAttribute('data-testid')!.replace('full-release-opens-', '')
    );
    // An already-open seal is not promised again — the list is honest about the
    // starting point, not a fixed recital of five.
    expect(promised).not.toContain('publish.outward');
    expect(promised.length).toBe(4);

    (await screen.findByTestId('full-release-apply')).click();
    await waitFor(() => expect(setSpy).toHaveBeenCalled());
    const written = lastWrite('commandEve.authority') as EveAuthorityGrant;

    for (const capability of promised) {
      expect(written.capabilities[capability as EveSealedCapability]).toBe(true);
    }
    // ...and the seal it did NOT promise to touch keeps the date it already had.
    expect(written.grantedAt?.['publish.outward']).toBe('2026-01-01T00:00:00.000Z');
  });

  it('confirming lands on rung 5 with every seal open and the typed ceiling', async () => {
    store['commandEve.authority'] = { ladder: 1, capabilities: {}, updatedBy: 'user' } satisfies EveAuthorityGrant;
    const Panel = await importPanel();
    render(<Panel />);

    await openConfirmation();
    await typeBudget('50');
    (await screen.findByTestId('full-release-apply')).click();

    await waitFor(() => expect(setSpy).toHaveBeenCalled());
    const written = lastWrite('commandEve.authority') as EveAuthorityGrant;

    expect(written.ladder).toBe(5);
    for (const capability of EVE_SEALED_CAPABILITIES) expect(written.capabilities[capability]).toBe(true);
    expect(written.limits?.['spend.money']?.dailyCents).toBe(5000);
    expect(written.updatedBy).toBe('user');
  });
});

describe('full release — money is asked for, never assumed', () => {
  it('refuses to act while money is in and no amount is named', async () => {
    store['commandEve.authority'] = { ladder: 1, capabilities: {}, updatedBy: 'user' } satisfies EveAuthorityGrant;
    const Panel = await importPanel();
    render(<Panel />);

    await openConfirmation();

    // The money line says WHY, rather than the button silently doing nothing.
    expect((await screen.findByTestId('full-release-money-line')).textContent).toContain(
      'authority.fullReleaseBudgetMissing'
    );
    expect((await screen.findByTestId('full-release-apply')).hasAttribute('disabled')).toBe(true);

    (await screen.findByTestId('full-release-apply')).click();
    expect(setSpy).not.toHaveBeenCalled();
  });

  it('switching money OFF releases the other four and says money is untouched', async () => {
    store['commandEve.authority'] = { ladder: 1, capabilities: {}, updatedBy: 'user' } satisfies EveAuthorityGrant;
    const Panel = await importPanel();
    render(<Panel />);

    await openConfirmation();
    (await screen.findByTestId('full-release-money-switch')).click();

    expect((await screen.findByTestId('full-release-money-line')).textContent).toContain(
      'authority.fullReleaseMoneyUntouched'
    );

    (await screen.findByTestId('full-release-apply')).click();
    await waitFor(() => expect(setSpy).toHaveBeenCalled());
    const written = lastWrite('commandEve.authority') as EveAuthorityGrant;

    expect(written.ladder).toBe(5);
    expect(written.capabilities['spend.money']).toBeUndefined();
    for (const capability of EVE_SEALED_CAPABILITIES.filter((c) => c !== 'spend.money')) {
      expect(written.capabilities[capability]).toBe(true);
    }
  });

  it('never produces the "switch on, spends nothing" grant', async () => {
    // The one incoherent shape. It has a warning of its own in this panel, and
    // the one-click path must not be a new way to reach it.
    store['commandEve.authority'] = { ladder: 1, capabilities: {}, updatedBy: 'user' } satisfies EveAuthorityGrant;
    const Panel = await importPanel();
    render(<Panel />);

    await openConfirmation();
    (await screen.findByTestId('full-release-money-switch')).click();
    (await screen.findByTestId('full-release-apply')).click();

    await waitFor(() => expect(setSpy).toHaveBeenCalled());
    const written = lastWrite('commandEve.authority') as EveAuthorityGrant;
    expect(grantNeedsAttention(written)).toBeNull();
  });
});

describe('full release — the state it reports afterwards', () => {
  it('says it is active, and only when the runtime would agree', async () => {
    store['commandEve.authority'] = {
      ladder: 5,
      capabilities: {
        'spend.money': true,
        'publish.outward': true,
        'delete.outside': true,
        'credentials.read': true,
        'deploy.production': true,
      },
      limits: { 'spend.money': { dailyCents: 5000 } },
      updatedBy: 'user',
    } satisfies EveAuthorityGrant;
    const Panel = await importPanel();
    render(<Panel />);

    expect((await screen.findByTestId('full-release-active')).textContent).toContain('authority.fullReleaseActive');
    expect(screen.queryByTestId('full-release-open')).toBeNull();
  });

  it('does NOT claim to be active when money is open with no ceiling', async () => {
    // Rung 5, all five switches on — and EVE still spends nothing. Calling that
    // "full" would be the panel promising more than the runtime holds.
    store['commandEve.authority'] = {
      ladder: 5,
      capabilities: {
        'spend.money': true,
        'publish.outward': true,
        'delete.outside': true,
        'credentials.read': true,
        'deploy.production': true,
      },
      updatedBy: 'user',
    } satisfies EveAuthorityGrant;
    const Panel = await importPanel();
    render(<Panel />);

    expect(screen.queryByTestId('full-release-active')).toBeNull();
    await screen.findByTestId('full-release-open');
    expect(screen.getByTestId('budget-missing')).toBeTruthy();
  });

  it('says plainly when confirming would change nothing', async () => {
    store['commandEve.authority'] = {
      ladder: 5,
      capabilities: {
        'spend.money': true,
        'publish.outward': true,
        'delete.outside': true,
        'credentials.read': true,
        'deploy.production': true,
      },
      limits: { 'spend.money': { dailyCents: 5000 } },
      updatedBy: 'user',
    } satisfies EveAuthorityGrant;
    const Panel = await importPanel();
    render(<Panel />);

    // Already full: the section reports the state rather than offering the act.
    await screen.findByTestId('full-release-active');
    expect(screen.queryByTestId('full-release-confirm')).toBeNull();
  });
});

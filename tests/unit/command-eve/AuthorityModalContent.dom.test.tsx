/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Settings → Freigaben, as it actually ships in 1.821.
 *
 * WHAT CHANGED AND WHY THE ASSERTIONS BELOW MOVED WITH IT. In 1.820 the panel
 * rendered three rungs and no seals, and this suite pinned that — correctly:
 * nothing called `grantAllows`, so the other three rungs and all five seals
 * would have been switches that store a preference and change nothing.
 *
 * The approval path now asks `decideAuthority` on every decision, so all six
 * rungs and all five seals BIND. Pinning the old shape would pin the defect.
 *
 * The load-bearing property is unchanged and is the reason the whole layer
 * exists: nothing may be offered here that does not take effect, and a new seat
 * starts fail-closed.
 */

import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import type { EveAuthorityGrant } from '@/common/config/eveAuthorityCore';

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
    Button: ({ children, onClick }: { children: React.ReactNode; onClick: () => void }) => (
      <button data-testid='forget' onClick={onClick}>
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

describe('Settings → Freigaben offers only what something enforces', () => {
  it('renders ALL SIX rungs — each one now binds', async () => {
    store['commandEve.authority'] = { ladder: 2, capabilities: {}, updatedBy: 'user' } satisfies EveAuthorityGrant;
    const Panel = await importPanel();
    render(<Panel />);

    for (const rung of [0, 1, 2, 3, 4, 5]) {
      expect(await screen.findByTestId(`rung-${rung}`), `rung ${rung} is missing from the panel`).toBeTruthy();
    }
    expect(screen.getByTestId('ladder').getAttribute('data-value')).toBe('2');
  });

  it('renders the five seals, and a fresh seat has every one of them shut', async () => {
    // No stored grant at all: the fail-closed default. This is the state a new
    // seat starts in, and it is the one that must never quietly be permissive.
    const Panel = await importPanel();
    render(<Panel />);
    for (const capability of [
      'spend.money',
      'publish.outward',
      'delete.outside',
      'credentials.read',
      'deploy.production',
    ]) {
      const seal = await screen.findByTestId(`seal-switch-${capability}`);
      expect(seal.getAttribute('data-checked'), `${capability} is open on a fresh seat`).toBe('false');
    }
    // The money amount only appears once the seal is open — an amount field on a
    // shut seal invites typing a budget that grants nothing.
    expect(screen.queryByTestId('seal-budget-money')).toBeNull();
  });

  it('opening a seal writes it — and moving the ladder never opens one', async () => {
    store['commandEve.authority'] = { ladder: 1, capabilities: {}, updatedBy: 'user' } satisfies EveAuthorityGrant;
    const Panel = await importPanel();
    render(<Panel />);
    // Resolve OUTSIDE act: the panel renders null until `whenReady` settles, and
    // awaiting that inside act never lets the effect flush.
    const seal = await screen.findByTestId('seal-switch-publish.outward');
    await act(async () => {
      seal.click();
    });
    const written = lastWrite('commandEve.authority') as EveAuthorityGrant;
    expect(written.capabilities['publish.outward']).toBe(true);
    expect(written.grantedAt?.['publish.outward'], 'an unsealing with no date cannot be reviewed later').toBeTruthy();
    // The ladder is untouched by a seal, and vice versa — they are separate
    // decisions and must never share a control.
    expect(written.ladder).toBe(1);
  });

  it('an open money seal without an amount SAYS so instead of looking live', async () => {
    store['commandEve.authority'] = {
      ladder: 3,
      capabilities: { 'spend.money': true },
      updatedBy: 'user',
    } satisfies EveAuthorityGrant;
    const Panel = await importPanel();
    render(<Panel />);
    expect(await screen.findByTestId('seal-budget-money')).toBeTruthy();
    // Without this the user sees a switch that is on, an EVE that never spends,
    // and concludes the feature is broken. It is refused at decision time.
    expect(screen.getByTestId('budget-missing')).toBeTruthy();
  });

  it('says plainly when the stored value was migrated and never confirmed', async () => {
    store['acp.config'] = { hermes: { preferredMode: 'dont_ask' } };
    const Panel = await importPanel();
    render(<Panel />);
    expect(await screen.findByText('commandEve.authority.notConfirmedYet')).toBeTruthy();
    expect(screen.getByTestId('ladder').getAttribute('data-value')).toBe('3');
  });
});

describe('the page states the ACTIVE seat, not the one you came from', () => {
  it('follows a seat switch without being remounted', async () => {
    // Seat A chose "arbeiten".
    store['commandEve.authority'] = { ladder: 3, capabilities: {}, updatedBy: 'user' } satisfies EveAuthorityGrant;
    const Panel = await importPanel();
    render(<Panel />);
    expect((await screen.findByTestId('ladder')).getAttribute('data-value')).toBe('3');

    // Switching to seat B: `rebindSeat` clears the cache, re-homes it to B's
    // namespace and re-notifies the seat-scoped key. Seat B never chose, so it
    // resolves fail-closed.
    await act(async () => {
      delete store['commandEve.authority'];
      notifyKey('commandEve.authority');
    });

    // Before this was reactive the page kept showing "3" here — telling the
    // operator EVE may work unasked in a seat that is actually set to ask. The
    // page is the only statement of that fact the operator gets.
    await waitFor(() => expect(screen.getByTestId('ladder').getAttribute('data-value')).toBe('1'));
    expect(screen.getByText('commandEve.authority.notConfirmedYet')).toBeTruthy();
  });

  it('follows a switch INTO a seat that chose more autonomy', async () => {
    const Panel = await importPanel();
    render(<Panel />);
    expect((await screen.findByTestId('ladder')).getAttribute('data-value')).toBe('1');

    await act(async () => {
      store['commandEve.authority'] = { ladder: 3, capabilities: {}, updatedBy: 'user' } satisfies EveAuthorityGrant;
      notifyKey('commandEve.authority');
    });

    await waitFor(() => expect(screen.getByTestId('ladder').getAttribute('data-value')).toBe('3'));
    expect(screen.queryByText('commandEve.authority.notConfirmedYet')).toBeNull();
  });
});

describe('choosing a rung actually takes effect', () => {
  it('writes the seat record and NOTHING install-global', async () => {
    store['commandEve.authority'] = { ladder: 1, capabilities: {}, updatedBy: 'user' } satisfies EveAuthorityGrant;
    const Panel = await importPanel();
    render(<Panel />);

    (await screen.findByTestId('ladder')).click();

    await waitFor(() => expect(setSpy.mock.calls.some((call) => call[0] === 'commandEve.authority')).toBe(true));
    expect((lastWrite('commandEve.authority') as EveAuthorityGrant).ladder).toBe(3);
    // The panel used to ALSO mirror the choice into `acp.config[hermes]` so the
    // session path — which read that key raw — would see it. `acp.config` is
    // install-global and the grant is per seat, so that mirror handed one seat's
    // decision to every seat that had never made one (P1, Kimi). The session
    // paths read the grant now, which is what makes dropping the mirror an
    // effective change rather than an inert one.
    expect(setSpy.mock.calls.some((call) => call[0] === 'acp.config')).toBe(false);
  });

  it('shows a migrated rung 4 as selected — and still says nobody confirmed it', async () => {
    // A legacy `yolo` install migrates to rung 4. In 1.820 that rung had no radio
    // option and no backend mode, so showing it as selected would have dressed an
    // inert state as a decision (P2, Kimi) — and this test pinned that it did not.
    //
    // Rung 4 binds now, so hiding the stored value would be the lie instead: the
    // seat really does act at rung 4, and the panel would be showing nothing
    // selected while it did. The "not confirmed yet" banner is what carries the
    // honest half — this value came from a migration, not from a person.
    store['commandEve.authority'] = { ladder: 4, capabilities: {}, updatedBy: 'migration' } satisfies EveAuthorityGrant;
    const Panel = await importPanel();
    render(<Panel />);
    expect(await screen.findByText('commandEve.authority.notConfirmedYet')).toBeTruthy();
    expect(screen.getByTestId('ladder').getAttribute('data-value')).toBe('4');
  });

  it('a stored value that is not a rung at all still selects nothing', async () => {
    // The fallback the old guard existed for, kept: garbage on disk must not be
    // presented as a human's choice.
    store['commandEve.authority'] = { ladder: 9, capabilities: {}, updatedBy: 'migration' } as unknown;
    const Panel = await importPanel();
    render(<Panel />);
    expect(await screen.findByText('commandEve.authority.notConfirmedYet')).toBeTruthy();
    // An unreadable grant resolves to the fail-closed default, which IS a rung.
    expect(screen.getByTestId('ladder').getAttribute('data-value')).toBe('1');
  });

  it('opens no sealed capability by moving the ladder', async () => {
    store['commandEve.authority'] = { ladder: 1, capabilities: {}, updatedBy: 'user' } satisfies EveAuthorityGrant;
    const Panel = await importPanel();
    render(<Panel />);
    (await screen.findByTestId('ladder')).click();
    await waitFor(() => expect(setSpy).toHaveBeenCalled());
    expect((lastWrite('commandEve.authority') as EveAuthorityGrant).capabilities).toEqual({});
  });
});

describe('what EVE remembered', () => {
  it('lists the grants and withdraws exactly one row', async () => {
    store['commandEve.authority'] = {
      ladder: 3,
      capabilities: {},
      updatedBy: 'user',
      rememberedCommands: [
        { command: 'git status', grantedAt: '2026-07-27T22:00:00.000Z' },
        { command: 'bun run test', grantedAt: '2026-07-27T22:05:00.000Z' },
      ],
    } satisfies EveAuthorityGrant;
    const Panel = await importPanel();
    render(<Panel />);

    expect(await screen.findAllByTestId('remembered-row')).toHaveLength(2);
    // Withdrawing is what makes remembering acceptable at all: an authority the
    // human cannot take back is not an authority, it is a leak.
    (await screen.findAllByTestId('forget'))[0]?.click();

    await waitFor(() => expect(setSpy).toHaveBeenCalled());
    expect((lastWrite('commandEve.authority') as EveAuthorityGrant).rememberedCommands).toEqual([
      { command: 'bun run test', grantedAt: '2026-07-27T22:05:00.000Z' },
    ]);
  });

  it('says so when nothing is remembered yet', async () => {
    store['commandEve.authority'] = { ladder: 2, capabilities: {}, updatedBy: 'user' } satisfies EveAuthorityGrant;
    const Panel = await importPanel();
    render(<Panel />);
    expect(await screen.findByText('commandEve.authority.rememberedEmpty')).toBeTruthy();
    expect(screen.queryByTestId('remembered-row')).toBeNull();
  });
});

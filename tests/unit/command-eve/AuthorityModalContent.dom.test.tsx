/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Settings → Freigaben, as it actually ships in 1.820.
 *
 * The panel deliberately renders ONLY what something enforces: the three rungs
 * AionCore decides against, and the commands this seat remembered. The sealed
 * capability switches are modelled and tested in eveAuthorityCore, but no
 * production code calls grantAllows yet — shipping them would be five switches
 * that store a preference and change nothing.
 *
 * The load-bearing test is "writes the record AND the key the session-opening
 * path reads". A setting that only records an intention is the defect this whole
 * change exists to remove.
 */

import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import type { EveAuthorityGrant } from '@/common/config/eveAuthorityCore';

const store: Record<string, unknown> = {};
const setSpy = vi.fn(async (key: string, value: unknown) => {
  store[key] = value;
});

vi.mock('@/common/config/configService', () => ({
  configService: {
    get: async (key: string) => store[key],
    set: setSpy,
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
  };
});

const importPanel = async () =>
  (await import('@/renderer/components/settings/SettingsModal/contents/AuthorityModalContent')).default;

// eslint-disable-next-line unicorn/consistent-function-scoping
const lastWrite = (key: string): unknown => setSpy.mock.calls.filter((call) => call[0] === key).at(-1)?.[1];

beforeEach(() => {
  for (const key of Object.keys(store)) delete store[key];
  setSpy.mockClear();
  vi.resetModules();
});

afterEach(cleanup);

describe('Settings → Freigaben offers only what something enforces', () => {
  it('renders exactly the three rungs AionCore decides against', async () => {
    store['commandEve.authority'] = { ladder: 2, capabilities: {}, updatedBy: 'user' } satisfies EveAuthorityGrant;
    const Panel = await importPanel();
    render(<Panel />);

    expect(await screen.findByTestId('rung-1')).toBeTruthy();
    expect(screen.getByTestId('rung-2')).toBeTruthy();
    expect(screen.getByTestId('rung-3')).toBeTruthy();
    // 0, 4 and 5 exist in the model but nothing classifies them yet.
    expect(screen.queryByTestId('rung-0')).toBeNull();
    expect(screen.queryByTestId('rung-4')).toBeNull();
    expect(screen.queryByTestId('rung-5')).toBeNull();
    expect(screen.getByTestId('ladder').getAttribute('data-value')).toBe('2');
  });

  it('says plainly when the stored value was migrated and never confirmed', async () => {
    store['acp.config'] = { hermes: { preferredMode: 'dont_ask' } };
    const Panel = await importPanel();
    render(<Panel />);
    expect(await screen.findByText('commandEve.authority.notConfirmedYet')).toBeTruthy();
    expect(screen.getByTestId('ladder').getAttribute('data-value')).toBe('3');
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

  it('does not present a rung it cannot enforce as the human choice', async () => {
    // A legacy `yolo` install migrates to rung 4, which has no radio option and
    // no backend mode. Showing it as the selected value would dress a state
    // nobody chose — and which does nothing — as a decision (P2, Kimi).
    store['commandEve.authority'] = { ladder: 4, capabilities: {}, updatedBy: 'migration' } satisfies EveAuthorityGrant;
    const Panel = await importPanel();
    render(<Panel />);
    expect(await screen.findByText('commandEve.authority.notConfirmedYet')).toBeTruthy();
    expect(screen.getByTestId('ladder').getAttribute('data-value')).toBeNull();
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

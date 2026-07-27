/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * The permission card survived five releases with a broken "always" derivation
 * partly because it had almost no DOM coverage. This panel is the new place a
 * human grants authority, so it gets tested from the start — in particular the
 * one property the founder asked for out loud: even on the top rung, the sealed
 * switches are OFF until someone turns each one on.
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
  // above the imports, so a factory that closed over an outer binding would read
  // it before initialisation. The lint rule's advice is wrong in this position.
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
    <div data-testid='ladder' data-value={value} onClick={() => onChange(5)}>
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
    Switch: ({ checked, onChange }: { checked: boolean; onChange: (next: boolean) => void }) => (
      <button data-testid='seal' data-checked={checked ? 'on' : 'off'} onClick={() => onChange(!checked)} />
    ),
    InputNumber: ({ value }: { value?: number }) => <input data-testid='budget' value={value ?? ''} readOnly />,
    Button: ({ children, onClick }: { children: React.ReactNode; onClick: () => void }) => (
      <button data-testid='forget' onClick={onClick}>
        {children}
      </button>
    ),
    Tag: ({ children }: { children: React.ReactNode }) => <span data-testid='tag'>{children}</span>,
    Message: { warning: vi.fn() },
  };
});

const importPanel = async () =>
  (await import('@/renderer/components/settings/SettingsModal/contents/AuthorityModalContent')).default;

beforeEach(() => {
  for (const key of Object.keys(store)) delete store[key];
  setSpy.mockClear();
  vi.resetModules();
});

afterEach(cleanup);

describe('Settings → Freigaben', () => {
  it('shows every seal OFF even when the ladder is at the top', async () => {
    const top: EveAuthorityGrant = { ladder: 5, capabilities: {}, updatedBy: 'user' };
    store['commandEve.authority'] = top;
    const Panel = await importPanel();
    render(<Panel />);

    const seals = await screen.findAllByTestId('seal');
    expect(seals).toHaveLength(5);
    for (const seal of seals) {
      expect(seal.getAttribute('data-checked')).toBe('off');
    }
    expect(screen.getByTestId('ladder').getAttribute('data-value')).toBe('5');
  });

  it('moving the ladder to the top does not open a single seal', async () => {
    store['commandEve.authority'] = { ladder: 1, capabilities: {}, updatedBy: 'user' } satisfies EveAuthorityGrant;
    const Panel = await importPanel();
    render(<Panel />);

    (await screen.findByTestId('ladder')).click();

    await waitFor(() => expect(setSpy).toHaveBeenCalled());
    const written = setSpy.mock.calls.at(-1)?.[1] as EveAuthorityGrant;
    expect(written.ladder).toBe(5);
    expect(written.capabilities).toEqual({});
  });

  it('opening the money seal records the grant and asks for an amount', async () => {
    store['commandEve.authority'] = { ladder: 3, capabilities: {}, updatedBy: 'user' } satisfies EveAuthorityGrant;
    const Panel = await importPanel();
    render(<Panel />);

    const seals = await screen.findAllByTestId('seal');
    seals[0]?.click(); // spend.money is first in EVE_SEALED_CAPABILITIES

    await waitFor(() => expect(setSpy).toHaveBeenCalled());
    const written = setSpy.mock.calls.at(-1)?.[1] as EveAuthorityGrant;
    expect(written.capabilities['spend.money']).toBe(true);
    expect(written.grantedAt?.['spend.money']).toBeTruthy();
    // Unsealed but with no amount yet: the panel must say so rather than look
    // like a switch that is on while EVE never spends.
    expect(await screen.findByTestId('tag')).toBeTruthy();
  });

  it('lists what EVE remembered and withdraws exactly one row', async () => {
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
    // Withdrawing is the property that makes remembering acceptable at all: an
    // authority the human cannot take back is not an authority, it is a leak.
    (await screen.findAllByTestId('forget'))[0]?.click();

    await waitFor(() => expect(setSpy).toHaveBeenCalled());
    const written = setSpy.mock.calls.at(-1)?.[1] as EveAuthorityGrant;
    expect(written.rememberedCommands).toEqual([{ command: 'bun run test', grantedAt: '2026-07-27T22:05:00.000Z' }]);
  });

  it('says plainly when the stored value was migrated and never confirmed', async () => {
    // No stored grant, a legacy per-backend mode present → migrated, not chosen.
    store['acp.config'] = { hermes: { preferredMode: 'dont_ask' } };
    const Panel = await importPanel();
    render(<Panel />);
    expect(await screen.findByText('commandEve:authority.notConfirmedYet')).toBeTruthy();
    // And the migration landed on the legacy rung without unsealing anything.
    expect(screen.getByTestId('ladder').getAttribute('data-value')).toBe('3');
    for (const seal of screen.getAllByTestId('seal')) {
      expect(seal.getAttribute('data-checked')).toBe('off');
    }
  });
});

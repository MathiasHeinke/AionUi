import React from 'react';
import { cleanup, render, screen } from '@testing-library/react';
import { Switch } from '@arco-design/web-react';
import { afterEach, describe, expect, it } from 'vitest';
import PreferenceRow from '@/renderer/components/settings/PreferenceRow';

describe('PreferenceRow accessibility', () => {
  afterEach(cleanup);

  it('uses the visible row label as the accessible name for a direct switch', () => {
    render(
      <PreferenceRow label='Enable private mode'>
        <Switch />
      </PreferenceRow>
    );

    expect(screen.getByRole('switch', { name: 'Enable private mode' })).toBeInTheDocument();
  });

  it('preserves an explicit accessible name on the switch', () => {
    render(
      <PreferenceRow label='Visible copy'>
        <Switch aria-label='Explicit switch name' />
      </PreferenceRow>
    );

    expect(screen.getByRole('switch', { name: 'Explicit switch name' })).toBeInTheDocument();
  });
});

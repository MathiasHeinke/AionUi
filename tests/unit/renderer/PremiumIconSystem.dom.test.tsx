import { IconProvider } from '@icon-park/react/es/runtime';
import { Picture } from '@icon-park/react';
import { render, screen } from '@testing-library/react';
import React from 'react';
import { describe, expect, it } from 'vitest';

import IconParkHOC from '@/renderer/components/IconParkHOC';
import PremiumIconProvider, { PREMIUM_ICON_CONFIG } from '@/renderer/components/base/PremiumIconProvider';

describe('premium icon system', () => {
  it('uses one round, ambient Icon Park configuration', () => {
    expect(PREMIUM_ICON_CONFIG).toMatchObject({
      size: '1em',
      strokeWidth: 3,
      strokeLinecap: 'round',
      strokeLinejoin: 'round',
      theme: 'outline',
      colors: {
        outline: { fill: 'currentColor', background: 'transparent' },
      },
    });
  });

  it('provides the premium configuration to every descendant icon', () => {
    render(
      <PremiumIconProvider>
        <IconProvider.Consumer>
          {(config) => <output data-testid='icon-config'>{JSON.stringify(config)}</output>}
        </IconProvider.Consumer>
      </PremiumIconProvider>
    );

    expect(JSON.parse(screen.getByTestId('icon-config').textContent ?? '{}')).toMatchObject(PREMIUM_ICON_CONFIG);
  });

  it('does not force icons to look interactive or override ambient color', () => {
    const PremiumPicture = IconParkHOC(Picture);
    const { container } = render(
      <PremiumIconProvider>
        <PremiumPicture className='feature-icon' aria-label='Preview' />
      </PremiumIconProvider>
    );

    const wrapper = container.querySelector('.i-icon');
    expect(wrapper).toHaveClass('eve-icon', 'feature-icon');
    expect(wrapper).not.toHaveClass('cursor-pointer');
    expect(container.querySelector('path')).toHaveAttribute('stroke', 'currentColor');
  });
});

import { IconContext } from '@phosphor-icons/react';
import { LoadingOne, Picture } from '@renderer/components/icons';
import { render, screen } from '@testing-library/react';
import React from 'react';
import { describe, expect, it } from 'vitest';

import PremiumIconProvider, { PREMIUM_ICON_CONFIG } from '@/renderer/components/base/PremiumIconProvider';
import { PREMIUM_ARCO_COMPONENT_CONFIG } from '@/renderer/components/base/PremiumArcoDefaults';
import ChannelStatusIcon from '@/renderer/components/settings/SettingsModal/contents/channels/ChannelStatusIcon';

describe('premium icon system', () => {
  it('uses one ambient Phosphor configuration', () => {
    expect(PREMIUM_ICON_CONFIG).toMatchObject({
      color: 'currentColor',
      size: '1em',
      weight: 'regular',
    });
  });

  it('provides the premium configuration to every descendant icon', () => {
    render(
      <PremiumIconProvider>
        <IconContext.Consumer>
          {(config) => <output data-testid='icon-config'>{JSON.stringify(config)}</output>}
        </IconContext.Consumer>
      </PremiumIconProvider>
    );

    expect(JSON.parse(screen.getByTestId('icon-config').textContent ?? '{}')).toMatchObject(PREMIUM_ICON_CONFIG);
  });

  it('does not force icons to look interactive or override ambient color', () => {
    const { container } = render(
      <PremiumIconProvider>
        <Picture className='feature-icon' aria-label='Preview' />
      </PremiumIconProvider>
    );

    const icon = container.querySelector('svg.eve-phosphor-icon');
    expect(icon).toHaveClass('eve-icon', 'feature-icon');
    expect(icon).toHaveAttribute('data-icon-family', 'phosphor');
    expect(icon).not.toHaveClass('cursor-pointer');
    expect(icon).toHaveAttribute('fill', 'currentColor');
  });

  it('preserves legacy theme, title and spin behavior through the facade', () => {
    const { container } = render(
      <LoadingOne theme='two-tone' fill={['none', 'currentColor']} spin title='Loading' strokeWidth={9} />
    );

    const icon = container.querySelector('svg.eve-phosphor-icon');
    expect(icon).toHaveClass('eve-icon--spin');
    expect(icon).toHaveAttribute('focusable', 'false');
    expect(icon?.querySelector('title')).toHaveTextContent('Loading');
  });

  it('renders channel states as semantic icons instead of localized text glyphs', () => {
    const { container, rerender } = render(<ChannelStatusIcon status='connecting' />);
    expect(container.querySelector('svg')).toHaveClass('eve-icon--spin');

    rerender(<ChannelStatusIcon status='connected' />);
    expect(container.querySelector('svg')).not.toHaveClass('eve-icon--spin');
    expect(container.querySelector('svg')).toHaveAttribute('data-icon-family', 'phosphor');
  });

  it('replaces Arco internal arrows, close controls and empty art with Phosphor elements', () => {
    const config = PREMIUM_ARCO_COMPONENT_CONFIG;
    expect(React.isValidElement(config.Select?.arrowIcon)).toBe(true);
    expect(React.isValidElement(config.Modal?.closeIcon)).toBe(true);
    expect(React.isValidElement(config.Empty?.icon)).toBe(true);
    expect(React.isValidElement(config.Menu?.icons?.popArrowRight)).toBe(true);
    expect(React.isValidElement(config.Tree?.icons?.switcherIcon)).toBe(true);
  });
});

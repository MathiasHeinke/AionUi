import React from 'react';
import { render } from '@testing-library/react-native';
import { FolderIcon, PaperPlaneTiltIcon, PlusIcon, QuestionIcon } from 'phosphor-react-native';
import { PremiumIcon, resolvePremiumIcon } from '../src/components/ui/PremiumIcon';

describe('PremiumIcon', () => {
  it('uses the selected Phosphor symbols for shared mobile actions', () => {
    expect(resolvePremiumIcon('add')).toBe(PlusIcon);
    expect(resolvePremiumIcon('folder-outline')).toBe(FolderIcon);
    expect(resolvePremiumIcon('arrow-up-circle')).toBe(PaperPlaneTiltIcon);
  });

  it('falls back to a visible question mark for an unknown icon name', () => {
    expect(resolvePremiumIcon('not-a-real-icon')).toBe(QuestionIcon);
  });

  it('preserves the requested size, color, and test identifier', () => {
    const { getByTestId } = render(
      <PremiumIcon name='folder-outline' size={18} color='#4767f2' testID='folder-icon' />
    );

    const icon = getByTestId('folder-icon');
    expect(icon.props.width).toBe(18);
    expect(icon.props.height).toBe(18);
    expect(icon.props.color).toBe('#4767f2');
  });
});

import VoiceDialogueControl from '@/renderer/components/chat/voiceDialogue/VoiceDialogueControl';
import { fireEvent, render, screen } from '@testing-library/react';
import React from 'react';
import { describe, expect, it, vi } from 'vitest';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string, options?: { defaultValue?: string }) => options?.defaultValue ?? key }),
}));

describe('VoiceDialogueControl', () => {
  it('shows an explicit pressed state and truthful phase without starting capture', () => {
    const onToggle = vi.fn();
    render(<VoiceDialogueControl enabled phase='speaking' onToggle={onToggle} />);

    const button = screen.getByRole('button', { name: /Sprachdialog ausschalten.*speaking/i });
    expect(button).toHaveAttribute('aria-pressed', 'true');
    expect(button).toHaveAttribute('data-phase', 'speaking');
    fireEvent.click(button);
    expect(onToggle).toHaveBeenCalledTimes(1);
  });
});

import { shouldShowPendingAssistantActivity } from '@/renderer/pages/conversation/platforms/acp/pendingAssistantActivity';
import { describe, expect, it } from 'vitest';

describe('shouldShowPendingAssistantActivity', () => {
  it.each([
    { label: 'a locally submitting turn', processing: true, submitting: true, position: 'left', expected: true },
    { label: 'a processing empty chat', processing: true, submitting: false, position: undefined, expected: true },
    {
      label: 'a processing chat after the user message',
      processing: true,
      submitting: false,
      position: 'right',
      expected: true,
    },
    {
      label: 'a processing chat after assistant activity',
      processing: true,
      submitting: false,
      position: 'left',
      expected: false,
    },
    { label: 'an idle chat', processing: false, submitting: true, position: 'right', expected: false },
  ])('returns $expected for $label', ({ processing, submitting, position, expected }) => {
    expect(shouldShowPendingAssistantActivity(processing, submitting, position)).toBe(expected);
  });
});

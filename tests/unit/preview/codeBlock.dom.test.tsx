/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import React from 'react';
import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string) =>
      ({
        'common.expand': 'Expand',
        'common.collapse': 'Collapse',
        'common.copy': 'Copy',
        'common.viewMoreLines': 'More lines',
      })[key] ?? key,
  }),
}));

vi.mock('@/renderer/utils/ui/clipboard', () => ({ copyText: vi.fn().mockResolvedValue(undefined) }));

import CodeBlock from '@/renderer/components/Markdown/CodeBlock';

describe('CodeBlock controls', () => {
  it('renders collapse and copy actions without browser-default boxes', () => {
    render(<CodeBlock className='language-text'>{`one\ntwo\nthree\nfour\nfive`}</CodeBlock>);

    for (const name of ['Expand', 'Copy']) {
      const control = screen.getByRole('button', { name });
      expect(control.style.appearance).toBe('none');
      expect(control.style.border).toBe('0px');
      expect(control.style.background).toBe('transparent');
      expect(control.style.boxShadow).toBe('none');
    }
  });
});

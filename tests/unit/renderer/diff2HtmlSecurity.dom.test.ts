import { describe, expect, it } from 'vitest';
import { setDiffFileNameText } from '@/renderer/components/media/Diff2Html';

describe('Diff2Html file-name rendering', () => {
  it('renders agent-controlled file names as text instead of executable markup', () => {
    const name = document.createElement('div');
    const hostileTitle = '<img src=x onerror="window.__commandEvePwned=true">';

    setDiffFileNameText(name, hostileTitle);

    expect(name.textContent).toBe(hostileTitle);
    expect(name.querySelector('img')).toBeNull();
    expect(name.innerHTML).not.toContain('<img');
  });
});

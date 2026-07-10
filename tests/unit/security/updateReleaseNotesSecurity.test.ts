import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

describe('update release notes security', () => {
  it('does not enable raw HTML for remote release notes', () => {
    const source = readFileSync(
      resolve(process.cwd(), 'packages/desktop/src/renderer/components/settings/UpdateModal.tsx'),
      'utf8'
    );
    expect(source).not.toMatch(/<MarkdownView\s+allowHtml(?:\s|>)/);
  });
});

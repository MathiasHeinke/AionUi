import fs from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

const viewersDir = path.resolve('packages/desktop/src/renderer/pages/conversation/Preview/components/viewers');

describe('legacy HTML viewer hardening guard', () => {
  it('does not ship a raw iframeDoc.write HTML viewer with same-origin scripts', () => {
    const files = fs.readdirSync(viewersDir).filter((file) => file.endsWith('.tsx') || file.endsWith('.ts'));
    const insecureFiles = files.filter((file) => {
      const source = fs.readFileSync(path.join(viewersDir, file), 'utf-8');
      return source.includes('iframeDoc.write') && source.includes('allow-same-origin');
    });

    expect(insecureFiles).toEqual([]);
  });
});

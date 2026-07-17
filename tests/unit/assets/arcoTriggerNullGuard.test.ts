/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = resolve(import.meta.dirname, '../../..');
const PATCH_PATH = 'patches/@arco-design%2Fweb-react@2.66.15.patch';

describe('Arco Trigger null-anchor guard', () => {
  it('packages the guard for both module builds and binds it in package metadata', () => {
    const patch = readFileSync(resolve(ROOT, PATCH_PATH), 'utf8');
    const packageJson = JSON.parse(readFileSync(resolve(ROOT, 'package.json'), 'utf8')) as {
      patchedDependencies?: Record<string, string>;
    };

    expect(patch.match(/if \(!child \|\| \(!child\.offsetParent/g)).toHaveLength(2);
    expect(packageJson.patchedDependencies?.['@arco-design/web-react@2.66.15']).toBe(PATCH_PATH);
  });
});

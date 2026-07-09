import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

const { resolveAioncoreVersion } = require('../../../scripts/resolveAioncoreVersion.js') as {
  resolveAioncoreVersion: (projectRoot: string, env?: NodeJS.ProcessEnv) => string;
};

describe('AionCore version pin', () => {
  const roots: string[] = [];
  const makeRoot = (): string => {
    const root = mkdtempSync(join(tmpdir(), 'aioncore-version-'));
    roots.push(root);
    return root;
  };

  afterEach(() => {
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  });

  it('prefers an explicit build override', () => {
    const root = makeRoot();
    writeFileSync(join(root, 'package.json'), JSON.stringify({ aioncoreVersion: 'v0.1.37' }));
    expect(resolveAioncoreVersion(root, { AIONUI_BACKEND_VERSION: 'v-test' })).toBe('v-test');
  });

  it('reads the repository version pin', () => {
    const root = makeRoot();
    writeFileSync(join(root, 'package.json'), JSON.stringify({ aioncoreVersion: 'v0.1.37' }));
    expect(resolveAioncoreVersion(root, {})).toBe('v0.1.37');
  });

  it('fails closed instead of resolving a mutable latest release', () => {
    const root = makeRoot();
    writeFileSync(join(root, 'package.json'), '{}');
    expect(() => resolveAioncoreVersion(root, {})).toThrow(/Missing pinned aioncoreVersion/);
  });
});

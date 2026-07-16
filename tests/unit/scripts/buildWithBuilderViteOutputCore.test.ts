import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

const { viteBuildExists } = require('../../../scripts/buildWithBuilderViteOutputCore.cjs') as {
  viteBuildExists: (outDir: string) => boolean;
};

const tempDirs: string[] = [];

function createOutDir(): string {
  const outDir = mkdtempSync(path.join(tmpdir(), 'command-eve-vite-output-'));
  tempDirs.push(outDir);
  mkdirSync(path.join(outDir, 'main'), { recursive: true });
  mkdirSync(path.join(outDir, 'renderer'), { recursive: true });
  return outDir;
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe('build-with-builder Vite output guard', () => {
  it('rejects a missing build', () => {
    expect(viteBuildExists(createOutDir())).toBe(false);
  });

  it('rejects zero-byte entrypoints even when both paths exist', () => {
    const outDir = createOutDir();
    writeFileSync(path.join(outDir, 'main', 'index.js'), '');
    writeFileSync(path.join(outDir, 'renderer', 'index.html'), '');

    expect(viteBuildExists(outDir)).toBe(false);
  });

  it('accepts non-empty main and renderer entrypoints', () => {
    const outDir = createOutDir();
    writeFileSync(path.join(outDir, 'main', 'index.js'), 'main');
    writeFileSync(path.join(outDir, 'renderer', 'index.html'), '<main></main>');

    expect(viteBuildExists(outDir)).toBe(true);
  });
});

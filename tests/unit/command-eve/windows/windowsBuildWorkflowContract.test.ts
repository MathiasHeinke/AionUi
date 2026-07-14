/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

function read(relativePath: string): string {
  return fs.readFileSync(path.join(process.cwd(), relativePath), 'utf8');
}

describe('Command EVE Windows build workflow contract', () => {
  it('keeps the reusable Windows build lane fail-closed', () => {
    const workflow = read('.github/workflows/_build-reusable.yml');

    expect(workflow).not.toContain('build failed but will not block the workflow');
    expect(workflow).toContain('if ($LASTEXITCODE -ne 0)');
    expect(workflow).toContain('throw "${{ matrix.platform }} build failed with exit code $LASTEXITCODE"');
    expect(workflow).toContain('BUILD_WITH_BUILDER_SELFTEST_FAIL');
  });

  it('uploads the complete Windows proof packet instead of installer-only output', () => {
    const reusable = read('.github/workflows/_build-reusable.yml');
    const manual = read('.github/workflows/build-manual.yml');

    expect(reusable).toContain('out/*-win-*.zip');
    expect(reusable).toContain('reports/windows/phase-a/gates/*.json');
    expect(reusable).toContain('if-no-files-found: error');
    expect(manual).toContain('upload_installers_only: false');
  });

  it('uses Command EVE names in Windows package and install smoke paths', () => {
    const workflow = read('.github/workflows/pr-checks.yml');

    expect(workflow).toContain('Command EVE-*-win-x64.exe');
    expect(workflow).toContain('Programs\\\\Command EVE\\\\Command EVE.exe');
    expect(workflow).not.toMatch(/AionUi-\*-win/i);
    expect(workflow).not.toMatch(/Programs\\\\AionUi/i);
  });

  it('does not package native modules that are absent from dependencies', () => {
    const builder = read('packages/desktop/electron-builder.yml');

    expect(builder).not.toContain('node_modules/bcrypt/');
    expect(builder).not.toContain('node_modules/node-pty/');
    expect(builder).toContain('node_modules/better-sqlite3/');
  });
});

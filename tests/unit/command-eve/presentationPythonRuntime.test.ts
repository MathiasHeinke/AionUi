/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  COMMAND_EVE_ARTIFACT_PYTHON_PACKAGES,
  COMMAND_EVE_PRESENTATION_PYTHON_PACKAGES,
  commandEveArtifactPythonPackages,
  commandEvePresentationPythonInstallArgs,
  commandEvePresentationPythonProbeArgs,
  resolveCommandEvePresentationPythonBundleDir,
  verifyCommandEvePresentationPythonBundle,
} from '@process/commandEve/presentationPythonRuntimeCore';

const SOURCE_BUNDLE = path.resolve('resources/bundled-hermes/presentation');

describe('bundled presentation Python runtime', () => {
  const tempRoots: string[] = [];

  afterEach(() => {
    for (const root of tempRoots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
  });

  it('ships the exact pure-Python PPTX/DOCX/PDF/XLSX fallback closure', () => {
    const result = verifyCommandEvePresentationPythonBundle(SOURCE_BUNDLE);
    expect(result).toMatchObject({ ok: true, directory: SOURCE_BUNDLE });
    for (const entry of COMMAND_EVE_PRESENTATION_PYTHON_PACKAGES) {
      expect(entry.filename).toMatch(/-py(?:2\.py3|3)-none-any\.whl$/);
      expect(fs.statSync(path.join(SOURCE_BUNDLE, entry.filename)).size).toBeGreaterThan(10_000);
    }
  });

  it('fails closed when a vendored wheel differs by one byte', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'eve-presentation-python-'));
    tempRoots.push(root);
    fs.cpSync(SOURCE_BUNDLE, root, { recursive: true });
    fs.appendFileSync(path.join(root, COMMAND_EVE_PRESENTATION_PYTHON_PACKAGES[0].filename), 'x');

    expect(verifyCommandEvePresentationPythonBundle(root)).toMatchObject({
      ok: false,
      reason: 'wheel_hash_mismatch:python-pptx',
    });
  });

  it('resolves only a complete verified bundle and never a partial directory', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'eve-presentation-python-partial-'));
    tempRoots.push(root);
    expect(
      resolveCommandEvePresentationPythonBundleDir(
        { COMMAND_EVE_PRESENTATION_WHEELS_DIR: root },
        undefined,
        path.join(root, 'empty-cwd')
      )
    ).toBe('');
    expect(
      resolveCommandEvePresentationPythonBundleDir(
        { COMMAND_EVE_PRESENTATION_WHEELS_DIR: SOURCE_BUNDLE },
        undefined,
        root
      )
    ).toBe(SOURCE_BUNDLE);
  });

  it('uses an offline-only install command and an exact-version import probe', () => {
    const installArgs = commandEvePresentationPythonInstallArgs(SOURCE_BUNDLE);
    expect(installArgs).toContain('--no-index');
    expect(installArgs).toContain('--no-deps');
    expect(installArgs).toContain('--find-links');
    expect(installArgs).toContain('python-pptx==1.0.2');
    expect(installArgs).toContain('XlsxWriter==3.2.9');
    expect(installArgs.join(' ')).not.toMatch(/https?:\/\//);

    const fallbackProbeArgs = commandEvePresentationPythonProbeArgs();
    const signedSiteProbeArgs = commandEvePresentationPythonProbeArgs('/signed/artifact-site');
    // Python isolated mode (-I) ignores PYTHON* environment variables. The
    // explicit -B is therefore a code-signing invariant, not an optimization:
    // neither probe may write __pycache__ into the packaged app bundle.
    expect(fallbackProbeArgs.slice(0, 3)).toEqual(['-B', '-I', '-P']);
    expect(signedSiteProbeArgs.slice(0, 4)).toEqual(['-B', '-I', '-P', '-S']);

    const probe = fallbackProbeArgs.join(' ');
    expect(probe).toContain('version("python-pptx")');
    expect(probe).toContain('version("XlsxWriter")');
    // The hardened probe imports via import_module with an origin assertion
    // (Pro-verdict Gate 2: version checks alone do not prove import provenance).
    expect(probe).toContain('assert_artifact_origin("pptx")');
    expect(probe).toContain('assert_artifact_origin("xlsxwriter")');
    expect(probe).toContain('version("pypdf")');
    expect(probe).toContain('version("python-docx")');
    expect(probe).toContain('version("openpyxl")');
    expect(probe).toContain('version("lxml")');
    expect(probe).toContain('version("Pillow")');
    expect(probe).toContain('version("defusedxml")');
    expect(COMMAND_EVE_ARTIFACT_PYTHON_PACKAGES).toHaveLength(13);
    expect(commandEveArtifactPythonPackages('win32')).toHaveLength(14);
    expect(commandEveArtifactPythonPackages('win32').map((entry) => entry.name)).toContain('colorama');
    expect(probe).not.toContain('PyMuPDF');
  });
});

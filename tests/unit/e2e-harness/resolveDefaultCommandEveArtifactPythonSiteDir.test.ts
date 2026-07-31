/**
 * Regression proof for the instrumented-e2e artifact-python-site default
 * (Command EVE 1.820.1 desktop-repair finding).
 *
 * Instrumented specs launch via `electron .`, so process.resourcesPath never
 * points at a real packaged Contents/Resources dir. Before this default,
 * COMMAND_EVE_ARTIFACT_PYTHON_SITE_DIR was never set for those specs, the
 * runtime bootstrap silently fell back to the dev-only pure-Python bundle
 * (never installs lxml/Pillow), and any document-artifact task broke with
 * `ModuleNotFoundError: No module named 'lxml'`
 * (tests/e2e/specs/command-eve-egress-boundary.e2e.ts skipped release-blocking).
 *
 * These tests prove resolveDefaultCommandEveArtifactPythonSiteDir with an
 * injected verify probe — no real filesystem or staged wheels needed.
 */
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { resolveDefaultCommandEveArtifactPythonSiteDir } from '../../e2e/helpers/commandEveArtifactPythonSite';

const CWD = '/repo';
const STAGED_SITE = path.join(CWD, 'build', 'bundled-python', 'python', 'artifact-site-packages');

describe('resolveDefaultCommandEveArtifactPythonSiteDir', () => {
  it('returns the staged artifact-site path when it verifies', () => {
    const verify = vi.fn().mockReturnValue({ ok: true });

    const resolved = resolveDefaultCommandEveArtifactPythonSiteDir({ cwd: CWD, verify });

    expect(resolved).toBe(STAGED_SITE);
    expect(verify).toHaveBeenCalledWith(STAGED_SITE);
  });

  it('fails closed to an empty string when the staged site does not verify', () => {
    const verify = vi.fn().mockReturnValue({ ok: false });

    const resolved = resolveDefaultCommandEveArtifactPythonSiteDir({ cwd: CWD, verify });

    expect(resolved).toBe('');
  });

  it('never injects an unverified path even if the directory happens to exist', () => {
    // A stale/partial staging directory (e.g. an interrupted build) must not
    // be silently accepted just because the path exists — regression guard
    // against reverting to an existence-only check.
    const verify = vi.fn().mockReturnValue({ ok: false, reason: 'artifact_tree_mismatch' });

    const resolved = resolveDefaultCommandEveArtifactPythonSiteDir({ cwd: CWD, verify });

    expect(resolved).toBe('');
    expect(verify).toHaveBeenCalledTimes(1);
  });
});

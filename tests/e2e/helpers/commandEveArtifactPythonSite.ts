/**
 * Default Command EVE artifact-python-site wiring for dev/instrumented e2e specs.
 *
 * Instrumented specs (the default, including CI) launch via `electron .`, so
 * `process.resourcesPath` is Electron's own resources dir, never
 * `out/<platform>/Command EVE.app/Contents/Resources`. The desktop's own
 * resourcesPath-based lookup (resolveCommandEveArtifactPythonSiteDir) therefore
 * never finds the signed native artifact site (lxml/Pillow + pptx/docx/...),
 * and the runtime bootstrap silently falls back to the dev-only pure-Python
 * bundle, which pip-installs python-pptx with --no-deps and never installs
 * lxml (lxml/Pillow are shipped ONLY inside the signed artifact site). Any
 * document-artifact task then breaks with `ModuleNotFoundError: No module
 * named 'lxml'` (confirmed by direct repro of the fresh dev-fallback venv).
 *
 * The packaged product path is already correct: `scripts/stage-bundled-artifact-python.mjs`
 * stages a hash-verified, sha256-pinned tree at
 * `build/bundled-python/python/artifact-site-packages` at build time, and the
 * same tree lands (signed) at `Contents/Resources/python/artifact-site-packages`
 * in the packaged app. This resolver points instrumented specs at that exact
 * staged tree, so the release/egress proof exercises the real signed runtime
 * instead of the intentionally-incomplete dev fallback.
 */
import path from 'node:path';
import { verifyCommandEveArtifactPythonSite } from '../../../packages/desktop/src/process/commandEve/presentationPythonRuntimeCore';

export const COMMAND_EVE_ARTIFACT_PYTHON_SITE_DIR_ENV = 'COMMAND_EVE_ARTIFACT_PYTHON_SITE_DIR';

export interface ResolveDefaultCommandEveArtifactPythonSiteDirOptions {
  /** Project root used to locate the build-staged artifact site. Defaults to process.cwd(). */
  cwd?: string;
  /** Verification probe (injectable for tests). Defaults to the real product verifier. */
  verify?: (directory: string) => { ok: boolean };
}

/**
 * Resolve the build-staged, sha256-verified document-artifact Python site, or
 * '' when it does not exist or fails verification — so ordinary dev/CI runs
 * that never staged Python artifacts (no packaged build yet) are unaffected.
 * Never returns an unverified path: the candidate is always checked with the
 * SAME contract (`verifyCommandEveArtifactPythonSite`) the runtime itself
 * uses to accept an artifact site, so a stale or partial staging directory
 * fails closed instead of being injected as a false-positive fix.
 */
export function resolveDefaultCommandEveArtifactPythonSiteDir(
  options: ResolveDefaultCommandEveArtifactPythonSiteDirOptions = {}
): string {
  const cwd = options.cwd ?? process.cwd();
  const verify = options.verify ?? verifyCommandEveArtifactPythonSite;
  const candidate = path.join(cwd, 'build', 'bundled-python', 'python', 'artifact-site-packages');
  return verify(candidate).ok ? candidate : '';
}

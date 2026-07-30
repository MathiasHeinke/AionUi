/**
 * Resolve the aioncore binary path.
 *
 * Search order:
 *  1. Explicit AIONUI_BACKEND_BINARY only when AIONUI_E2E_TEST=1
 *  2. Bundled with app (production)
 *  3. System PATH
 *
 * Packaged release evidence must not set the E2E override: it needs to exercise
 * the binary embedded in the app bundle.
 */

import { accessSync, constants, existsSync, statSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import { execSync } from 'node:child_process';

const BINARY_NAME = 'aioncore';

function getBinaryName(): string {
  return process.platform === 'win32' ? `${BINARY_NAME}.exe` : BINARY_NAME;
}

/**
 * Resolve the aioncore binary path.
 * Returns the absolute path to the binary, or throws if not found.
 */
export function resolveBinaryPath(): string {
  const e2eOverride = resolveE2EBackendBinaryOverride();
  if (e2eOverride) return e2eOverride;

  const bundled = bundledPath();
  if (bundled) return bundled;

  const fromPath = resolveFromSystemPATH();
  if (fromPath) return fromPath;

  throw new Error(`Cannot find "${BINARY_NAME}" binary. Checked bundled location and system PATH.`);
}

/**
 * E2E-only explicit backend injection.
 *
 * Production and normal development keep the bundled → PATH resolution order.
 * Instrumented Electron tests may inject an exact worktree build, but the path
 * must be absolute, exist, and be an executable file; an invalid override is a
 * failed test precondition and must not silently fall back to a bundled binary.
 */
export function resolveE2EBackendBinaryOverride(): string | null {
  if (process.env.AIONUI_E2E_TEST !== '1') return null;

  const candidate = process.env.AIONUI_BACKEND_BINARY?.trim();
  if (!candidate) return null;

  if (!isAbsolute(candidate)) {
    throw new Error('AIONUI_BACKEND_BINARY must be an absolute path when AIONUI_E2E_TEST=1.');
  }

  try {
    if (statSync(candidate).isFile()) {
      accessSync(candidate, process.platform === 'win32' ? constants.F_OK : constants.X_OK);
      return candidate;
    }
  } catch {
    // The fail-loud error below intentionally avoids a bundled/PATH fallback.
  }

  throw new Error('AIONUI_BACKEND_BINARY must resolve to an executable file when AIONUI_E2E_TEST=1.');
}

/**
 * Check bundled binary in resources directory.
 * Layout: bundled-aioncore/{platform}-{arch}/aioncore[.exe]
 */
function bundledPath(): string | null {
  const runtimeKey = `${process.platform}-${process.arch}`;
  const resourcesPath = (process as NodeJS.Process & { resourcesPath?: string }).resourcesPath;
  const roots = [resourcesPath, join(process.cwd(), 'resources')].filter((root): root is string => Boolean(root));

  for (const root of roots) {
    const candidate = join(root, 'bundled-aioncore', runtimeKey, getBinaryName());
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

/**
 * Try to find the binary on the system PATH.
 */
function resolveFromSystemPATH(): string | null {
  try {
    const cmd = process.platform === 'win32' ? `where ${BINARY_NAME}` : `which ${BINARY_NAME}`;
    const result = execSync(cmd, { encoding: 'utf-8', timeout: 5000 }).trim();
    if (result && existsSync(result)) return result;
  } catch {
    // not found in PATH
  }
  return null;
}

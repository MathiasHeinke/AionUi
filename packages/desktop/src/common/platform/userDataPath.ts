import { createHash } from 'crypto';
import path from 'path';

export function readExplicitUserDataDir(argv: readonly string[]): string | undefined {
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg.startsWith('--user-data-dir=')) {
      const value = arg.slice('--user-data-dir='.length).trim();
      return value || undefined;
    }
    if (arg === '--user-data-dir') {
      const value = argv[index + 1]?.trim();
      return value && !value.startsWith('--') ? value : undefined;
    }
  }
  return undefined;
}

export function shouldUseGlobalCliSafeSymlink(argv: readonly string[] = process.argv): boolean {
  // An env-pinned profile is operator-scoped: the global symlink must not be
  // redirected to it (same rule as --user-data-dir, see ensureCliSafeSymlink).
  if (process.env[COMMAND_EVE_USER_DATA_DIR_ENV]?.trim()) return false;
  return readExplicitUserDataDir(argv) === undefined;
}

export function resolveElectronUserDataPath(
  currentUserDataPath: string,
  appName: string,
  argv: readonly string[] = process.argv
): string {
  const explicitUserDataDir = readExplicitUserDataDir(argv);
  if (explicitUserDataDir) return path.resolve(explicitUserDataDir);
  return path.join(path.dirname(currentUserDataPath), appName);
}

/**
 * Explicit user-data override via environment. Wins over the sandbox guard so
 * operators and test harnesses can always pin a profile directory.
 */
export const COMMAND_EVE_USER_DATA_DIR_ENV = 'COMMAND_EVE_USER_DATA_DIR';

/**
 * Marker file baked into non-distributable e2e-packaged builds by
 * scripts/afterPackE2E.js. Canonical home is here (common layer) so both the
 * process and common layers can detect test builds without a layering violation.
 */
export const COMMAND_EVE_E2E_PACKAGED_ATTACHMENT_MARKER = '.command-eve-e2e-packaged-attachment';

export type GuardedUserDataPathInput = {
  /** Directory Electron would use by default (app.getPath('userData')). */
  currentUserDataPath: string;
  /** Product app name after any dev-isolation rename (app.getName()). */
  appName: string;
  /** app.getAppPath(); on packaged macOS builds '<bundle>.app/Contents/Resources/app.asar'. */
  appPath: string;
  isPackaged: boolean;
  platform: NodeJS.Platform;
  env?: NodeJS.ProcessEnv;
  argv?: readonly string[];
  /** True when the packaged build carries the non-distributable E2E attachment marker file. */
  packagedE2eMarkerPresent?: boolean;
  /** User home directory; enables treating '~/Applications' as an installed location. */
  homeDir?: string;
};

export type GuardedUserDataPathSource = 'argv-override' | 'env-override' | 'production' | 'sandbox-isolation' | 'dev';

export type GuardedUserDataPathResult = {
  userDataPath: string;
  /** Why this directory was chosen — surfaced in the startup log line. */
  source: GuardedUserDataPathSource;
};

/**
 * True when a packaged build runs from a location that is NOT an installed
 * production app, so it must never default to the production profile
 * (MAT-1773: a stale sandbox build once served the founder's real data).
 *
 * Heuristics:
 * - macOS: installed production apps live in /Applications (or ~/Applications).
 *   Anything else (agent sandboxes, electron-builder out/, /tmp) is a sandbox.
 * - Every platform: explicit E2E markers (AIONUI_E2E_TEST,
 *   COMMAND_EVE_E2E_PACKAGED_ATTACHMENT, baked marker file) force isolation —
 *   a test build must never touch the production profile even if it happens to
 *   sit in an installed-looking location.
 */
export function isSandboxedPackagedApp(input: GuardedUserDataPathInput): boolean {
  if (!input.isPackaged) return false;
  const env = input.env;
  if (env?.AIONUI_E2E_TEST === '1') return true;
  if (env?.COMMAND_EVE_E2E_PACKAGED_ATTACHMENT === '1') return true;
  if (input.packagedE2eMarkerPresent) return true;
  if (input.platform !== 'darwin') return false;
  const normalizedAppPath = path.resolve(input.appPath);
  const installedPrefixes = ['/Applications'];
  if (input.homeDir) installedPrefixes.push(path.join(input.homeDir, 'Applications'));
  const isInstalled = installedPrefixes.some(
    (prefix) => normalizedAppPath === prefix || normalizedAppPath.startsWith(`${prefix}${path.sep}`)
  );
  return !isInstalled;
}

/**
 * Resolve the user-data directory with the sandbox guard applied.
 *
 * Precedence: explicit --user-data-dir > COMMAND_EVE_USER_DATA_DIR env >
 * sandbox isolation (packaged, non-installed location) > product directory.
 * Unpackaged dev runs keep the existing dev-suffixed appName behaviour.
 */
export function resolveGuardedElectronUserDataPath(input: GuardedUserDataPathInput): GuardedUserDataPathResult {
  const explicitUserDataDir = readExplicitUserDataDir(input.argv ?? process.argv);
  if (explicitUserDataDir) {
    return { userDataPath: path.resolve(explicitUserDataDir), source: 'argv-override' };
  }
  const envUserDataDir = input.env?.[COMMAND_EVE_USER_DATA_DIR_ENV]?.trim();
  if (envUserDataDir) {
    return { userDataPath: path.resolve(envUserDataDir), source: 'env-override' };
  }
  if (isSandboxedPackagedApp(input)) {
    // Hash the bundle path so every sandbox build gets its own profile and two
    // stale builds at different locations can never share one.
    const hash = createHash('sha256').update(path.resolve(input.appPath)).digest('hex').slice(0, 8);
    const sandboxDirName = `${input.appName} Sandbox-${hash}`;
    return {
      userDataPath: path.join(path.dirname(input.currentUserDataPath), sandboxDirName),
      source: 'sandbox-isolation',
    };
  }
  return {
    userDataPath: path.join(path.dirname(input.currentUserDataPath), input.appName),
    source: input.isPackaged ? 'production' : 'dev',
  };
}

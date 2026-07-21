/**
 * Resolution-order proof for the shared e2e aioncore binary env contract
 * (Command EVE 1.818 C4 harness finding 1).
 *
 * The sibling-backend e2e specs (builtin-skill-migration, assistant-user-data)
 * resolve the binary through tests/e2e/helpers/aioncoreBinary.ts. These tests
 * prove the documented order with injected env/exists probes — no real
 * filesystem or binary needed:
 *
 *   AIONUI_BACKEND_BINARY (explicit) → AIONUI_BACKEND_LOCAL_BINARY →
 *   resources/bundled-aioncore → PATH → ~/.cargo/bin
 */
import { describe, expect, it } from 'vitest';
import path from 'node:path';
import { aioncoreBinaryCandidates, resolveAioncoreBinary } from '../../e2e/helpers/aioncoreBinary';

const CWD = '/repo';
const HOME_DIR = '/home/tester';
const PLATFORM = 'darwin';
const ARCH = 'arm64';

const BUNDLED = path.resolve(CWD, 'resources', 'bundled-aioncore', `${PLATFORM}-${ARCH}`, 'aioncore');
const CARGO_BIN = path.join(HOME_DIR, '.cargo', 'bin', 'aioncore');
const PATH_DIR_A = '/usr/local/bin';
const PATH_DIR_B = '/usr/bin';
const PATH_BIN_A = path.join(PATH_DIR_A, 'aioncore');
const PATH_BIN_B = path.join(PATH_DIR_B, 'aioncore');

const BASE_OPTIONS = { cwd: CWD, homeDir: HOME_DIR, platform: PLATFORM, arch: ARCH } as const;

function envWith(overrides: Record<string, string>): NodeJS.ProcessEnv {
  return { ...overrides } as NodeJS.ProcessEnv;
}

function existsOnly(...existing: string[]): (candidate: string) => boolean {
  const set = new Set(existing);
  return (candidate: string) => set.has(candidate);
}

describe('resolveAioncoreBinary env contract', () => {
  it('orders candidates exactly as documented: explicit → local → bundled → PATH → cargo-home', () => {
    const env = envWith({
      AIONUI_BACKEND_BINARY: '/opt/explicit/aioncore',
      AIONUI_BACKEND_LOCAL_BINARY: '/opt/local/aioncore',
      PATH: [PATH_DIR_A, PATH_DIR_B].join(path.delimiter),
    });

    const candidates = aioncoreBinaryCandidates({ ...BASE_OPTIONS, env });

    expect(candidates.map((c) => c.source)).toEqual([
      'AIONUI_BACKEND_BINARY',
      'AIONUI_BACKEND_LOCAL_BINARY',
      'bundled-resources',
      'PATH',
      'PATH',
      'cargo-home',
    ]);
    expect(candidates.map((c) => c.path)).toEqual([
      '/opt/explicit/aioncore',
      '/opt/local/aioncore',
      BUNDLED,
      PATH_BIN_A,
      PATH_BIN_B,
      CARGO_BIN,
    ]);
  });

  it('resolves via AIONUI_BACKEND_BINARY (explicit) even when every other source exists', () => {
    const explicit = '/opt/explicit/aioncore';
    const env = envWith({
      AIONUI_BACKEND_BINARY: explicit,
      AIONUI_BACKEND_LOCAL_BINARY: '/opt/local/aioncore',
      PATH: PATH_DIR_A,
    });

    const resolved = resolveAioncoreBinary({
      ...BASE_OPTIONS,
      env,
      exists: existsOnly(explicit, '/opt/local/aioncore', BUNDLED, PATH_BIN_A, CARGO_BIN),
    });

    expect(resolved).toBe(explicit);
  });

  it('resolves via AIONUI_BACKEND_LOCAL_BINARY when no explicit override is set', () => {
    const local = '/opt/local/aioncore';
    const env = envWith({ AIONUI_BACKEND_LOCAL_BINARY: local, PATH: PATH_DIR_A });

    const resolved = resolveAioncoreBinary({
      ...BASE_OPTIONS,
      env,
      exists: existsOnly(local, BUNDLED, PATH_BIN_A, CARGO_BIN),
    });

    expect(resolved).toBe(local);
  });

  it('resolves via the repo-bundled artifact when no env var is set', () => {
    const env = envWith({ PATH: PATH_DIR_A });

    const resolved = resolveAioncoreBinary({
      ...BASE_OPTIONS,
      env,
      exists: existsOnly(BUNDLED, PATH_BIN_A, CARGO_BIN),
    });

    expect(resolved).toBe(BUNDLED);
  });

  it('resolves via PATH lookup when neither env vars nor the bundled artifact exist', () => {
    const env = envWith({ PATH: [PATH_DIR_A, PATH_DIR_B].join(path.delimiter) });

    const resolved = resolveAioncoreBinary({
      ...BASE_OPTIONS,
      env,
      exists: existsOnly(PATH_BIN_B, CARGO_BIN),
    });

    expect(resolved).toBe(PATH_BIN_B);
  });

  it('falls back to ~/.cargo/bin only as the last resort', () => {
    const env = envWith({ PATH: PATH_DIR_A });

    const resolved = resolveAioncoreBinary({
      ...BASE_OPTIONS,
      env,
      exists: existsOnly(CARGO_BIN),
    });

    expect(resolved).toBe(CARGO_BIN);
  });

  it('throws the documented resolution order when nothing exists', () => {
    const env = envWith({ PATH: PATH_DIR_A });

    expect(() => resolveAioncoreBinary({ ...BASE_OPTIONS, env, exists: () => false })).toThrowError(
      /aioncore binary not found.*AIONUI_BACKEND_BINARY.*AIONUI_BACKEND_LOCAL_BINARY.*PATH/s
    );
  });

  it('uses the aioncore.exe binary name on win32', () => {
    const candidates = aioncoreBinaryCandidates({
      cwd: 'C:\\repo',
      homeDir: 'C:\\Users\\tester',
      platform: 'win32',
      arch: 'x64',
      // PATH is split with the host delimiter (':' on this runner), so keep the
      // simulated win32 PATH free of ':' to model a single directory entry.
      env: envWith({ PATH: '\\tools\\bin' }),
    });

    expect(candidates.every((c) => c.path.endsWith('aioncore.exe'))).toBe(true);
    expect(candidates.map((c) => c.source)).toEqual(['bundled-resources', 'PATH', 'cargo-home']);
  });
});

/**
 * Shared aioncore backend-binary resolution for e2e sibling-backend specs.
 *
 * Sibling-backend specs (builtin-skill-migration, assistant-user-data) spawn a
 * throw-away aioncore process against a seeded data-dir. They must locate the
 * binary through ONE documented env contract, in this exact order:
 *
 *   1. `AIONUI_BACKEND_BINARY`        — explicit override (highest priority)
 *   2. `AIONUI_BACKEND_LOCAL_BINARY`  — explicit local dev build
 *   3. `resources/bundled-aioncore/<platform>-<arch>/aioncore[.exe]`
 *      (repo-bundled artifact prepared by packages/shared-scripts/prepare-aioncore)
 *   4. `aioncore[.exe]` found on `PATH`
 *   5. `~/.cargo/bin/aioncore[.exe]`  — legacy cargo-install fallback
 *
 * 1.818 C4 harness finding: the sibling-backend specs used to read only
 * `AIONUI_BACKEND_BINARY` plus hardcoded bundled/cargo paths — neither
 * `AIONUI_BACKEND_LOCAL_BINARY` nor `PATH`. All specs now share this helper.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export interface AioncoreBinaryCandidate {
  /** Where this candidate comes from (env var name or well-known location). */
  source: 'AIONUI_BACKEND_BINARY' | 'AIONUI_BACKEND_LOCAL_BINARY' | 'bundled-resources' | 'PATH' | 'cargo-home';
  path: string;
}

export interface ResolveAioncoreBinaryOptions {
  /** Environment to read. Defaults to process.env. */
  env?: NodeJS.ProcessEnv;
  /** Project root used for the bundled-resources candidate. Defaults to process.cwd(). */
  cwd?: string;
  /** Home directory used for the cargo fallback. Defaults to os.homedir(). */
  homeDir?: string;
  /** Defaults to process.platform. */
  platform?: string;
  /** Defaults to process.arch. */
  arch?: string;
  /** Existence probe (injectable for tests). Defaults to fs.existsSync. */
  exists?: (candidate: string) => boolean;
}

export function aioncoreBinaryName(platform: string): string {
  return platform === 'win32' ? 'aioncore.exe' : 'aioncore';
}

/**
 * The ordered candidate list for the documented resolution contract. Exposed
 * so tests (and future diagnostics) can assert the order itself, not just the
 * first hit.
 */
export function aioncoreBinaryCandidates(options: ResolveAioncoreBinaryOptions = {}): AioncoreBinaryCandidate[] {
  const env = options.env ?? process.env;
  const cwd = options.cwd ?? process.cwd();
  const homeDir = options.homeDir ?? os.homedir();
  const platform = options.platform ?? process.platform;
  const arch = options.arch ?? process.arch;
  const binaryName = aioncoreBinaryName(platform);

  const candidates: AioncoreBinaryCandidate[] = [];

  // 1. Explicit override.
  const explicit = env.AIONUI_BACKEND_BINARY?.trim();
  if (explicit) candidates.push({ source: 'AIONUI_BACKEND_BINARY', path: explicit });

  // 2. Explicit local dev build.
  const local = env.AIONUI_BACKEND_LOCAL_BINARY?.trim();
  if (local) candidates.push({ source: 'AIONUI_BACKEND_LOCAL_BINARY', path: local });

  // 3. Repo-bundled artifact (prepare-aioncore runtimeKey = <platform>-<arch>).
  candidates.push({
    source: 'bundled-resources',
    path: path.resolve(cwd, 'resources', 'bundled-aioncore', `${platform}-${arch}`, binaryName),
  });

  // 4. PATH lookup.
  for (const dir of (env.PATH ?? '').split(path.delimiter)) {
    const trimmed = dir.trim();
    if (trimmed) candidates.push({ source: 'PATH', path: path.join(trimmed, binaryName) });
  }

  // 5. Legacy cargo-install fallback.
  candidates.push({ source: 'cargo-home', path: path.join(homeDir, '.cargo', 'bin', binaryName) });

  return candidates;
}

/**
 * Resolve the aioncore binary via the documented contract. Throws with the
 * full resolution order when nothing exists.
 */
export function resolveAioncoreBinary(options: ResolveAioncoreBinaryOptions = {}): string {
  const exists = options.exists ?? ((candidate: string) => fs.existsSync(candidate));
  const candidates = aioncoreBinaryCandidates(options);

  for (const candidate of candidates) {
    if (exists(candidate.path)) return candidate.path;
  }

  throw new Error(
    'aioncore binary not found. Resolution order: ' +
      'AIONUI_BACKEND_BINARY (explicit) → AIONUI_BACKEND_LOCAL_BINARY → ' +
      'resources/bundled-aioncore/<platform>-<arch> → PATH → ~/.cargo/bin. ' +
      'Set AIONUI_BACKEND_BINARY (or AIONUI_BACKEND_LOCAL_BINARY) to an absolute binary path, ' +
      'prepare resources/bundled-aioncore, or install aioncore onto PATH.'
  );
}

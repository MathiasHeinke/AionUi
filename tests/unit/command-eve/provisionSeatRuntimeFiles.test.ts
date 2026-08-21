/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * T0 — PER-SEAT RUNTIME PROVISIONING ON SEAT SWITCH.
 *
 * THE VERIFIED BUG: the Hermes runtime files of a seat home — config.yaml (with
 * memory_enabled:true, user_profile_enabled:true, data_boundary, nudge intervals),
 * SOUL.md, skills-command-eve — are written ONLY by the boot bootstrap, and at boot
 * the active seat is ALWAYS the legacy/founder home (there is no boot-restore of a
 * saved seat). A seat SWITCH re-homes HERMES_HOME + re-spawns the agent but never
 * provisioned the TARGET client seat home. Result: every real client seat ran on
 * WHEEL DEFAULTS — memory_enabled=FALSE, no SOUL.md, no EVE skills.
 *
 * These tests exercise the REAL provisioning naht (`provisionSeatRuntimeFiles`) the
 * seat-switch prepareEnv thunk now calls, against a REAL temp seat home resolved
 * through the SAME `resolveCommandEveRuntimeBootstrapPaths` factory the runtime
 * uses — mirroring the established pattern in runtimeBootstrapSeatScoping.test.ts.
 *
 * INVARIANTS UNDER TEST:
 *   (a) after a switch to a FRESH seat home, config.yaml (memory_enabled: true) +
 *       SOUL.md exist IN THAT SEAT HOME (not the legacy home).
 *   (b) a second provisioning pass is BYTE-IDEMPOTENT (same content).
 *   (c) EVE-GROWN files in the seat home (memories/USER.md + an agent-created skill)
 *       SURVIVE provisioning untouched.
 *   (d) two distinct seats get DISJOINT, independently-provisioned homes.
 *   (e) a crafted/unsafe seat id fails BEST-EFFORT (ok:false) rather than escaping seats/.
 */

import { afterEach, describe, expect, it } from 'vitest';
import crypto from 'crypto';
import fs from 'fs';
import os from 'os';
import path from 'path';
import {
  hasValidSeatRuntimeFiles,
  prepareCommandEveRuntimeProcessEnv,
  provisionCommandEveBrowserUseRunner,
  provisionSeatRuntimeFiles,
  resolveCommandEveRuntimeBootstrapPaths,
  seatRuntimeConfigKeepsManualApprovals,
} from '@/process/commandEve/runtimeBootstrapCore';
import {
  SEATS_SUBDIR,
  __resetActiveSeatForTests,
  clearActiveSeat,
  setActiveSeatId,
} from '@/process/commandEve/seatContextCore';

const REAL_UUID_A = 'a1b2c3d4-e5f6-4789-aabb-ccddeeff0011';
const REAL_UUID_B = 'ffeeddcc-bbaa-4321-9988-776655443322';

const tempRoots: string[] = [];
const makeUserData = (): string => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'command-eve-provision-seat-test-'));
  tempRoots.push(root);
  return root;
};

afterEach(() => {
  __resetActiveSeatForTests();
  for (const root of tempRoots.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

describe('(a) provisioning a fresh TARGET seat home', () => {
  it('fails closed when an explicit isolated user-data root is missing or relative', () => {
    for (const invalidRoot of [undefined, '', 'command-eve-relative-root']) {
      const result = provisionSeatRuntimeFiles({
        userDataPath: invalidRoot as string,
        seatId: REAL_UUID_A,
      });
      expect(result).toMatchObject({
        ok: false,
        hermes_home: '',
        memory_enabled: false,
        error: 'provisionSeatRuntimeFiles requires an absolute isolated userDataPath',
      });
    }
  });

  it('writes config.yaml (memory_enabled: true) + SOUL.md into the seat home, NOT the legacy home', () => {
    const userData = makeUserData();
    // Simulate the switch step (a): the active seat is now the target.
    setActiveSeatId(REAL_UUID_A);
    const seatHome = resolveCommandEveRuntimeBootstrapPaths(userData).hermesHome;
    expect(seatHome).toContain(`${path.sep}${SEATS_SUBDIR}${path.sep}${REAL_UUID_A}${path.sep}`);

    // Before: the fresh client seat home has NO runtime files (the bug).
    expect(fs.existsSync(path.join(seatHome, 'config.yaml'))).toBe(false);
    expect(fs.existsSync(path.join(seatHome, 'SOUL.md'))).toBe(false);

    const result = provisionSeatRuntimeFiles({ userDataPath: userData });
    expect(result.ok).toBe(true);
    expect(result.hermes_home).toBe(seatHome);
    expect(result.memory_enabled).toBe(true);

    // After: both Desktop-OWNED files exist in the TARGET seat home.
    const configPath = path.join(seatHome, 'config.yaml');
    const soulPath = path.join(seatHome, 'SOUL.md');
    expect(fs.existsSync(configPath)).toBe(true);
    expect(fs.existsSync(soulPath)).toBe(true);

    // The config.yaml carries the memory wiring the wheel defaults OFF.
    const config = fs.readFileSync(configPath, 'utf8');
    expect(config).toContain('memory_enabled: true');
    expect(config).toContain('user_profile_enabled: true');

    // The legacy/founder home was NOT provisioned as a side effect.
    const legacyHome = resolveCommandEveRuntimeBootstrapPaths(userData, 'seat-1').hermesHome;
    expect(legacyHome).not.toBe(seatHome);
    expect(fs.existsSync(path.join(legacyHome, 'config.yaml'))).toBe(false);
  });

  it('writes the skills-command-eve managed dir into the seat home', () => {
    const userData = makeUserData();
    setActiveSeatId(REAL_UUID_A);
    const paths = resolveCommandEveRuntimeBootstrapPaths(userData);
    const result = provisionSeatRuntimeFiles({ userDataPath: userData });
    expect(result.ok).toBe(true);
    // managedSkillsRoot lives directly under the seat home; it exists + is populated
    // with at least the onboarding stubs (bundledSkillsDir is '' here → stubs only).
    expect(fs.existsSync(paths.managedSkillsRoot)).toBe(true);
    expect(fs.readdirSync(paths.managedSkillsRoot).length).toBeGreaterThan(0);
  });

  it('files are written 0600 (owner-only), matching the boot path', () => {
    const userData = makeUserData();
    setActiveSeatId(REAL_UUID_A);
    const seatHome = resolveCommandEveRuntimeBootstrapPaths(userData).hermesHome;
    provisionSeatRuntimeFiles({ userDataPath: userData });
    const configMode = fs.statSync(path.join(seatHome, 'config.yaml')).mode & 0o777;
    const soulMode = fs.statSync(path.join(seatHome, 'SOUL.md')).mode & 0o777;
    if (process.platform !== 'win32') {
      expect(configMode).toBe(0o600);
      expect(soulMode).toBe(0o600);
    }
  });

  it('pins config.yaml to the actual loopback shim URL for this process', () => {
    const userData = makeUserData();
    setActiveSeatId(REAL_UUID_A);
    const seatHome = resolveCommandEveRuntimeBootstrapPaths(userData).hermesHome;
    const result = provisionSeatRuntimeFiles({
      userDataPath: userData,
      egressProxyUrl: 'http://127.0.0.1:45678',
    });

    expect(result.ok).toBe(true);
    const config = fs.readFileSync(path.join(seatHome, 'config.yaml'), 'utf8');
    expect(config).toContain('base_url: http://127.0.0.1:45678/v1');
    expect(config).not.toContain('base_url: http://127.0.0.1:25811/v1');
  });
});

describe('(b) idempotency — a second switch is byte-identical', () => {
  it('a second provisioning pass produces byte-identical config.yaml + SOUL.md', () => {
    const userData = makeUserData();
    setActiveSeatId(REAL_UUID_A);
    const seatHome = resolveCommandEveRuntimeBootstrapPaths(userData).hermesHome;

    provisionSeatRuntimeFiles({ userDataPath: userData });
    const config1 = fs.readFileSync(path.join(seatHome, 'config.yaml'), 'utf8');
    const soul1 = fs.readFileSync(path.join(seatHome, 'SOUL.md'), 'utf8');

    // A second switch back onto this seat re-provisions.
    const result2 = provisionSeatRuntimeFiles({ userDataPath: userData });
    expect(result2.ok).toBe(true);
    const config2 = fs.readFileSync(path.join(seatHome, 'config.yaml'), 'utf8');
    const soul2 = fs.readFileSync(path.join(seatHome, 'SOUL.md'), 'utf8');

    expect(config2).toBe(config1);
    expect(soul2).toBe(soul1);
  });
});

describe('(c) EVE-GROWN state survives provisioning', () => {
  it('memories/USER.md and an agent-created skill are NOT touched', () => {
    const userData = makeUserData();
    setActiveSeatId(REAL_UUID_A);
    const seatHome = resolveCommandEveRuntimeBootstrapPaths(userData).hermesHome;

    // Model an already-provisioned + EVE-grown seat home: create the home, an
    // agent-grown memory file, and an agent-created skill under the PRIMARY skills
    // dir (NOT the Desktop-managed skills-command-eve).
    const memDir = path.join(seatHome, 'memories');
    fs.mkdirSync(memDir, { recursive: true });
    const userMdPath = path.join(memDir, 'USER.md');
    const memoryMdPath = path.join(memDir, 'MEMORY.md');
    fs.writeFileSync(userMdPath, '# Operator\nName: Alois (EVE-grown)\n', { mode: 0o600 });
    fs.writeFileSync(memoryMdPath, '# Working notes EVE grew\n', { mode: 0o600 });

    const agentSkillDir = path.join(seatHome, 'skills', 'agent-invented-skill');
    fs.mkdirSync(agentSkillDir, { recursive: true });
    const agentSkillPath = path.join(agentSkillDir, 'SKILL.md');
    fs.writeFileSync(agentSkillPath, '# A skill EVE created for this client\n', { mode: 0o600 });

    const userMdBefore = fs.readFileSync(userMdPath, 'utf8');
    const memoryMdBefore = fs.readFileSync(memoryMdPath, 'utf8');
    const agentSkillBefore = fs.readFileSync(agentSkillPath, 'utf8');

    const result = provisionSeatRuntimeFiles({ userDataPath: userData });
    expect(result.ok).toBe(true);

    // EVE-grown files are byte-for-byte untouched.
    expect(fs.readFileSync(userMdPath, 'utf8')).toBe(userMdBefore);
    expect(fs.readFileSync(memoryMdPath, 'utf8')).toBe(memoryMdBefore);
    expect(fs.readFileSync(agentSkillPath, 'utf8')).toBe(agentSkillBefore);

    // And the Desktop-owned files were still written alongside.
    expect(fs.existsSync(path.join(seatHome, 'config.yaml'))).toBe(true);
    expect(fs.existsSync(path.join(seatHome, 'SOUL.md'))).toBe(true);
  });
});

describe('(d) two distinct seats get disjoint, independently-provisioned homes', () => {
  it('provisions seat A and seat B into separate homes', () => {
    const userData = makeUserData();

    setActiveSeatId(REAL_UUID_A);
    const homeA = resolveCommandEveRuntimeBootstrapPaths(userData).hermesHome;
    const resA = provisionSeatRuntimeFiles({ userDataPath: userData });

    setActiveSeatId(REAL_UUID_B);
    const homeB = resolveCommandEveRuntimeBootstrapPaths(userData).hermesHome;
    const resB = provisionSeatRuntimeFiles({ userDataPath: userData });

    expect(resA.ok && resB.ok).toBe(true);
    expect(homeA).not.toBe(homeB);
    expect(fs.existsSync(path.join(homeA, 'config.yaml'))).toBe(true);
    expect(fs.existsSync(path.join(homeB, 'config.yaml'))).toBe(true);
  });

  it('an explicit seatId provisions that seat regardless of the active seat', () => {
    const userData = makeUserData();
    setActiveSeatId(REAL_UUID_A);
    // Provision B explicitly while A is active.
    const result = provisionSeatRuntimeFiles({ userDataPath: userData, seatId: REAL_UUID_B });
    const homeB = resolveCommandEveRuntimeBootstrapPaths(userData, REAL_UUID_B).hermesHome;
    expect(result.ok).toBe(true);
    expect(result.hermes_home).toBe(homeB);
    expect(fs.existsSync(path.join(homeB, 'config.yaml'))).toBe(true);
    // A was NOT provisioned by the explicit-B call.
    const homeA = resolveCommandEveRuntimeBootstrapPaths(userData, REAL_UUID_A).hermesHome;
    expect(fs.existsSync(path.join(homeA, 'config.yaml'))).toBe(false);
  });
});

describe('(e) fail-safe — an unsafe seat id never escapes seats/', () => {
  it('a crafted target id yields ok:false + an error, and writes NO config.yaml', () => {
    const userData = makeUserData();
    clearActiveSeat();
    const result = provisionSeatRuntimeFiles({ userDataPath: userData, seatId: '../../escape' });
    expect(result.ok).toBe(false);
    expect(result.error).toBeTruthy();
    // Nothing escaped into the runtime root.
    const runtimeRoot = path.join(path.resolve(userData), 'command-eve-runtime');
    // A crafted home would sit outside seats/; assert no stray config.yaml exists anywhere under the runtime root.
    const stray: string[] = [];
    const walk = (dir: string) => {
      let entries: fs.Dirent[] = [];
      try {
        entries = fs.readdirSync(dir, { withFileTypes: true });
      } catch {
        return;
      }
      for (const e of entries) {
        const full = path.join(dir, e.name);
        if (e.isDirectory()) walk(full);
        else if (e.name === 'config.yaml') stray.push(full);
      }
    };
    walk(runtimeRoot);
    expect(stray).toEqual([]);
  });

  it('rejects a non-loopback shim override instead of writing an unsafe config', () => {
    const userData = makeUserData();
    setActiveSeatId(REAL_UUID_A);
    const seatHome = resolveCommandEveRuntimeBootstrapPaths(userData).hermesHome;
    const result = provisionSeatRuntimeFiles({
      userDataPath: userData,
      egressProxyUrl: 'https://example.com/not-local',
    });

    expect(result.ok).toBe(false);
    expect(result.error).toContain('loopback HTTP URL');
    expect(fs.existsSync(path.join(seatHome, 'config.yaml'))).toBe(false);
  });
});

describe('packaged Browser Use runner ownership', () => {
  const browserUseRunnerDeps = { readArchitectures: () => ['arm64'] };

  const writePackagedRunner = (userData: string, body = '#!/bin/sh\nexit 0\n') => {
    const resourcesPath = path.join(userData, 'resources');
    const artifactRoot = path.join(resourcesPath, 'bundled-hermes', 'uvx');
    const sourceRoot = path.join(artifactRoot, 'aarch64-apple-darwin');
    fs.mkdirSync(sourceRoot, { recursive: true });
    const runner = path.join(sourceRoot, 'uvx');
    fs.writeFileSync(runner, body);
    fs.chmodSync(runner, 0o700);
    const sha256 = crypto.createHash('sha256').update(fs.readFileSync(runner)).digest('hex');
    const companion = path.join(sourceRoot, 'uv');
    fs.writeFileSync(companion, body);
    fs.chmodSync(companion, 0o700);
    const companionSha256 = crypto.createHash('sha256').update(fs.readFileSync(companion)).digest('hex');
    const artifactReceipt = {
      schema_version: 'command-eve-uvx-artifact-receipt/v1',
      upstream: 'astral-sh/uv',
      version: '0.0.0-test',
      target: 'aarch64-apple-darwin',
      archive_name: 'uv-aarch64-apple-darwin.tar.gz',
      archive_sha256: 'a'.repeat(64),
      archive_entry: 'uv-aarch64-apple-darwin/uvx',
      runner_filename: 'uvx',
      source_runner_sha256: 'b'.repeat(64),
      runner_sha256: sha256,
      companion_archive_entry: 'uv-aarch64-apple-darwin/uv',
      companion_filename: 'uv',
      companion_source_sha256: 'c'.repeat(64),
      companion_sha256: companionSha256,
      provenance: 'official-astral-release-attestation+fynlabs-developer-id/v1',
      attestation: { repo: 'astral-sh/uv', release_tag: '0.0.0-test' },
      signing: {
        authority: 'Developer ID Application: FYN Labs LLC (NHNQ7Q5H28)',
        team_id: 'NHNQ7Q5H28',
        identifier: 'uvx',
        hardened_runtime: true,
      },
      companion_signing: {
        authority: 'Developer ID Application: FYN Labs LLC (NHNQ7Q5H28)',
        team_id: 'NHNQ7Q5H28',
        identifier: 'uv',
        hardened_runtime: true,
      },
    };
    const artifactReceiptBytes = Buffer.from(`${JSON.stringify(artifactReceipt)}\n`);
    fs.writeFileSync(path.join(sourceRoot, 'uvx-artifact-receipt.json'), artifactReceiptBytes, { mode: 0o600 });
    fs.writeFileSync(
      path.join(artifactRoot, 'uvx-manifest.json'),
      `${JSON.stringify({
        schema_version: 'command-eve-uvx-runner/v1',
        upstream: 'astral-sh/uv',
        version: '0.0.0-test',
        artifacts: [
          {
            target: 'aarch64-apple-darwin',
            archive_name: 'uv-aarch64-apple-darwin.tar.gz',
            archive_sha256: 'a'.repeat(64),
            archive_entry: 'uv-aarch64-apple-darwin/uvx',
            runner_filename: 'uvx',
            source_runner_sha256: 'b'.repeat(64),
            runner_sha256: sha256,
            companion_archive_entry: 'uv-aarch64-apple-darwin/uv',
            companion_filename: 'uv',
            companion_source_sha256: 'c'.repeat(64),
            companion_sha256: companionSha256,
            artifact_receipt_sha256: crypto.createHash('sha256').update(artifactReceiptBytes).digest('hex'),
            provenance: 'official-astral-release-attestation+fynlabs-developer-id/v1',
            attestation: { repo: 'astral-sh/uv', release_tag: '0.0.0-test' },
            signing: {
              authority: 'Developer ID Application: FYN Labs LLC (NHNQ7Q5H28)',
              team_id: 'NHNQ7Q5H28',
              identifier: 'uvx',
              hardened_runtime: true,
            },
            companion_signing: {
              authority: 'Developer ID Application: FYN Labs LLC (NHNQ7Q5H28)',
              team_id: 'NHNQ7Q5H28',
              identifier: 'uv',
              hardened_runtime: true,
            },
          },
        ],
      })}\n`
    );
    return resourcesPath;
  };

  it('copies the verified packaged runner into the target seat and never uses PATH', () => {
    const userData = makeUserData();
    setActiveSeatId(REAL_UUID_A);
    const resourcesPath = writePackagedRunner(userData);
    const paths = resolveCommandEveRuntimeBootstrapPaths(userData);

    const runner = provisionCommandEveBrowserUseRunner(paths, resourcesPath, 'darwin', 'arm64', browserUseRunnerDeps);

    expect(runner?.path).toBe(path.join(paths.hermesHome, 'bin', 'uvx'));
    expect(runner?.companionPath).toBe(path.join(paths.hermesHome, 'bin', 'uv'));
    expect(runner?.provenance).toBe('packaged-astral-uvx/v1');
    expect(fs.readFileSync(runner!.path, 'utf8')).toContain('exit 0');
    const descriptor = JSON.parse(fs.readFileSync(paths.browserUseRunnerDescriptor, 'utf8'));
    expect(descriptor).toMatchObject({
      schema_version: 'command-eve-browser-use-runner/v1',
      hermes_home: paths.hermesHome,
      path: runner!.path,
      companion_path: runner!.companionPath,
      root: path.join(paths.hermesHome, 'bin'),
      artifact_receipt_path: path.join(paths.hermesHome, 'bin', 'uvx-artifact-receipt.json'),
      sha256: runner!.sha256,
      companion_sha256: runner!.companionSha256,
      version: '0.0.0-test',
      provenance: 'packaged-astral-uvx/v1',
    });
    expect(fs.existsSync(path.join(paths.hermesHome, 'bin', 'uvx-artifact-receipt.json'))).toBe(true);
    if (process.platform !== 'win32') {
      expect(fs.statSync(runner!.path).mode & 0o777).toBe(0o700);
      expect(fs.statSync(runner!.companionPath).mode & 0o777).toBe(0o700);
    }
  });

  it('fails closed when the packaged uv companion is absent or altered', () => {
    const userData = makeUserData();
    setActiveSeatId(REAL_UUID_A);
    const paths = resolveCommandEveRuntimeBootstrapPaths(userData);
    const resourcesPath = writePackagedRunner(userData);
    fs.appendFileSync(path.join(resourcesPath, 'bundled-hermes', 'uvx', 'aarch64-apple-darwin', 'uv'), 'tampered');
    expect(
      provisionCommandEveBrowserUseRunner(paths, resourcesPath, 'darwin', 'arm64', browserUseRunnerDeps)
    ).toBeUndefined();
  });

  it('fails closed when the packaged artifact is absent or altered', () => {
    const userData = makeUserData();
    setActiveSeatId(REAL_UUID_A);
    const paths = resolveCommandEveRuntimeBootstrapPaths(userData);
    expect(
      provisionCommandEveBrowserUseRunner(
        paths,
        path.join(userData, 'missing'),
        'darwin',
        'arm64',
        browserUseRunnerDeps
      )
    ).toBeUndefined();

    const resourcesPath = writePackagedRunner(userData);
    fs.appendFileSync(path.join(resourcesPath, 'bundled-hermes', 'uvx', 'aarch64-apple-darwin', 'uvx'), 'tampered');
    expect(
      provisionCommandEveBrowserUseRunner(paths, resourcesPath, 'darwin', 'arm64', browserUseRunnerDeps)
    ).toBeUndefined();
  });

  it('keeps the checked-in blocked-artifact manifest incapable of authorizing a runner', () => {
    const userData = makeUserData();
    setActiveSeatId(REAL_UUID_A);
    const resourcesPath = writePackagedRunner(userData);
    const manifestPath = path.join(resourcesPath, 'bundled-hermes', 'uvx', 'uvx-manifest.json');
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    manifest.status = 'BLOCKED_ARTIFACT';
    fs.writeFileSync(manifestPath, `${JSON.stringify(manifest)}\n`);

    expect(
      provisionCommandEveBrowserUseRunner(
        resolveCommandEveRuntimeBootstrapPaths(userData),
        resourcesPath,
        'darwin',
        'arm64',
        browserUseRunnerDeps
      )
    ).toBeUndefined();
  });

  it('rejects noncanonical release tags and archive entries', () => {
    const userData = makeUserData();
    setActiveSeatId(REAL_UUID_A);
    const resourcesPath = writePackagedRunner(userData);
    const manifestPath = path.join(resourcesPath, 'bundled-hermes', 'uvx', 'uvx-manifest.json');
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    manifest.artifacts[0].attestation.release_tag = `v${manifest.version}`;
    fs.writeFileSync(manifestPath, `${JSON.stringify(manifest)}\n`);
    expect(
      provisionCommandEveBrowserUseRunner(
        resolveCommandEveRuntimeBootstrapPaths(userData),
        resourcesPath,
        'darwin',
        'arm64',
        browserUseRunnerDeps
      )
    ).toBeUndefined();

    manifest.artifacts[0].attestation.release_tag = manifest.version;
    manifest.artifacts[0].archive_entry = 'uvx';
    fs.writeFileSync(manifestPath, `${JSON.stringify(manifest)}\n`);
    expect(
      provisionCommandEveBrowserUseRunner(
        resolveCommandEveRuntimeBootstrapPaths(userData),
        resourcesPath,
        'darwin',
        'arm64',
        browserUseRunnerDeps
      )
    ).toBeUndefined();
  });

  it('fails closed when the packaged runner does not match the target architecture', () => {
    const userData = makeUserData();
    setActiveSeatId(REAL_UUID_A);
    const resourcesPath = writePackagedRunner(userData);

    expect(
      provisionCommandEveBrowserUseRunner(
        resolveCommandEveRuntimeBootstrapPaths(userData),
        resourcesPath,
        'darwin',
        'arm64',
        { readArchitectures: () => ['x86_64'] }
      )
    ).toBeUndefined();
  });

  it('sets the bound runner pointer before a backend spawn and clears it when absent', () => {
    const userData = makeUserData();
    setActiveSeatId(REAL_UUID_A);
    const resourcesPath = writePackagedRunner(userData);
    const env: NodeJS.ProcessEnv = {};

    const paths = prepareCommandEveRuntimeProcessEnv(userData, env, 'darwin', resourcesPath, browserUseRunnerDeps);

    expect(env.COMMAND_EVE_BROWSER_UVX_PATH).toBe(path.join(paths.hermesHome, 'bin', 'uvx'));
    expect(env.COMMAND_EVE_BROWSER_UVX_DESCRIPTOR_PATH).toBe(paths.browserUseRunnerDescriptor);
    prepareCommandEveRuntimeProcessEnv(userData, env, 'darwin', path.join(userData, 'missing'), browserUseRunnerDeps);
    expect(env.COMMAND_EVE_BROWSER_UVX_PATH).toBeUndefined();
    expect(env.COMMAND_EVE_BROWSER_UVX_DESCRIPTOR_PATH).toBeUndefined();
    expect(fs.existsSync(paths.browserUseRunnerDescriptor)).toBe(false);
  });

  it('makes a seat home private before binding its Main-owned runner', () => {
    const userData = makeUserData();
    setActiveSeatId(REAL_UUID_A);
    const resourcesPath = writePackagedRunner(userData);
    const paths = resolveCommandEveRuntimeBootstrapPaths(userData);
    fs.mkdirSync(paths.hermesHome, { recursive: true, mode: 0o755 });
    fs.chmodSync(paths.hermesHome, 0o755);

    const env: NodeJS.ProcessEnv = {};
    prepareCommandEveRuntimeProcessEnv(userData, env, 'darwin', resourcesPath, browserUseRunnerDeps);

    expect(fs.statSync(paths.hermesHome).mode & 0o777).toBe(0o700);
    expect(env.COMMAND_EVE_BROWSER_UVX_PATH).toBe(path.join(paths.hermesHome, 'bin', 'uvx'));
  });

  it('rejects an artifact receipt whose immutable manifest hash does not match', () => {
    const userData = makeUserData();
    setActiveSeatId(REAL_UUID_A);
    const resourcesPath = writePackagedRunner(userData);
    const manifestPath = path.join(resourcesPath, 'bundled-hermes', 'uvx', 'uvx-manifest.json');
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    manifest.artifacts[0].artifact_receipt_sha256 = '0'.repeat(64);
    fs.writeFileSync(manifestPath, `${JSON.stringify(manifest)}\n`);

    expect(
      provisionCommandEveBrowserUseRunner(
        resolveCommandEveRuntimeBootstrapPaths(userData),
        resourcesPath,
        'darwin',
        'arm64',
        browserUseRunnerDeps
      )
    ).toBeUndefined();
  });
});

describe('(f) 1.820 upgrade revokes legacy class-wide Hermes grants', () => {
  it.each([
    { label: 'legacy root home', seatId: null },
    { label: 'isolated seat home', seatId: REAL_UUID_A },
  ])('reconciles a legacy command_allowlist in the $label without changing other managed config', ({ seatId }) => {
    const userData = makeUserData();
    const first = provisionSeatRuntimeFiles({ userDataPath: userData, seatId });
    expect(first.ok).toBe(true);

    const configPath = path.join(first.hermes_home, 'config.yaml');
    const managedConfig = fs.readFileSync(configPath, 'utf8');
    expect(managedConfig).toContain('command_allowlist: []');

    // Model an <=1.819 profile after Hermes persisted an "Allow always"
    // pattern. The next 1.820 reconcile must revoke that authority while
    // preserving every other Desktop-managed config byte.
    const legacyConfig = managedConfig.replace(
      'command_allowlist: []',
      'command_allowlist:\n- script execution via -e/-c flag'
    );
    expect(legacyConfig).not.toBe(managedConfig);
    fs.writeFileSync(configPath, legacyConfig, { mode: 0o600 });

    const upgraded = provisionSeatRuntimeFiles({ userDataPath: userData, seatId });
    expect(upgraded.ok).toBe(true);
    const upgradedConfig = fs.readFileSync(configPath, 'utf8');

    expect(upgradedConfig).toBe(managedConfig);
    expect(upgradedConfig).toContain('command_allowlist: []');
    expect(upgradedConfig).not.toContain('script execution via -e/-c flag');
  });
});

describe('(H4) hasValidSeatRuntimeFiles — the seat-switch fail-closed gate', () => {
  const makeHome = (): string => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'command-eve-h4-home-'));
    tempRoots.push(home);
    return home;
  };

  it('false for an empty/unresolved home path (never treat "" as valid)', () => {
    expect(hasValidSeatRuntimeFiles('')).toBe(false);
  });

  it('false when config.yaml + SOUL.md are both absent (a fresh unprovisioned home ⇒ wheel defaults)', () => {
    const home = makeHome();
    expect(hasValidSeatRuntimeFiles(home)).toBe(false);
  });

  it('false when only ONE of config.yaml / SOUL.md is present', () => {
    const home = makeHome();
    fs.writeFileSync(path.join(home, 'config.yaml'), 'memory_enabled: true\n');
    expect(hasValidSeatRuntimeFiles(home)).toBe(false); // SOUL.md still missing
    fs.rmSync(path.join(home, 'config.yaml'));
    fs.writeFileSync(path.join(home, 'SOUL.md'), '# EVE\n');
    expect(hasValidSeatRuntimeFiles(home)).toBe(false); // config.yaml missing
  });

  it('false when a required file exists but is EMPTY (zero bytes is not a valid file)', () => {
    const home = makeHome();
    fs.writeFileSync(path.join(home, 'config.yaml'), '');
    fs.writeFileSync(path.join(home, 'SOUL.md'), '');
    expect(hasValidSeatRuntimeFiles(home)).toBe(false);
  });

  it('true only when BOTH config.yaml + SOUL.md exist and are non-empty (last-known-good ⇒ switch may proceed)', () => {
    const home = makeHome();
    fs.writeFileSync(path.join(home, 'config.yaml'), 'memory_enabled: true\n');
    fs.writeFileSync(path.join(home, 'SOUL.md'), '# EVE\nVoice + values.\n');
    expect(hasValidSeatRuntimeFiles(home)).toBe(true);
  });

  it('a REAL provisioned seat home passes the gate (end-to-end with provisionSeatRuntimeFiles)', () => {
    const userData = makeUserData();
    setActiveSeatId(REAL_UUID_A);
    const seatHome = resolveCommandEveRuntimeBootstrapPaths(userData).hermesHome;
    const res = provisionSeatRuntimeFiles({ userDataPath: userData, seatId: REAL_UUID_A });
    expect(res.ok).toBe(true);
    expect(hasValidSeatRuntimeFiles(seatHome)).toBe(true);
    clearActiveSeat();
  });

  it('false when the last-known-good config hands approvals BACK to Hermes', () => {
    // P3 (Kimi): existence + size was the whole test, so a hand-edited
    // `approvals.mode: smart` was "last-known-good" and the seat booted on a
    // config where Hermes approves via an auxiliary model instead of asking.
    const home = makeHome();
    fs.writeFileSync(path.join(home, 'SOUL.md'), '# EVE\n');
    fs.writeFileSync(path.join(home, 'config.yaml'), 'approvals:\n  mode: smart\n');
    expect(hasValidSeatRuntimeFiles(home)).toBe(false);
    fs.writeFileSync(path.join(home, 'config.yaml'), 'approvals:\n  mode: manual\n');
    expect(hasValidSeatRuntimeFiles(home)).toBe(true);
  });

  it('a REAL provisioned config satisfies the approvals check it is judged by', () => {
    // The gate and the emitter must agree, or the product fails its own check.
    const userData = makeUserData();
    setActiveSeatId(REAL_UUID_A);
    const seatHome = resolveCommandEveRuntimeBootstrapPaths(userData).hermesHome;
    provisionSeatRuntimeFiles({ userDataPath: userData, seatId: REAL_UUID_A });
    const config = fs.readFileSync(path.join(seatHome, 'config.yaml'), 'utf8');
    expect(config).toContain('approvals:\n  mode: manual');
    expect(seatRuntimeConfigKeepsManualApprovals(config)).toBe(true);
    clearActiveSeat();
  });
});

describe('the authority gate must cover every model provider the seat can be given', () => {
  it('every emitted MODEL provider resolves to the profile that carries the gate', () => {
    // P1 (Kimi, delta review) — the mechanism is real even though the EVE lane
    // cannot reach it today. `build_api_kwargs_extras` is called from exactly one
    // place in the wheel (agent/transports/chat_completions.py:529, inside
    // `_build_kwargs_from_profile`), and the legacy fallback at :286 skips it. So
    // the authority gate lives on OUR profile, and it protects only model calls
    // that RESOLVE to our profile.
    //
    // Today every model provider the emitter writes — custom, ollama, local — is
    // the registered name or one of its aliases, so the gate covers the lane.
    // `copilot-acp` is written under `delegation:` and is a CLI launcher, not a
    // model provider; it never reaches the chat-completions transport.
    //
    // That is a fact about today, and facts about today rot. This test turns it
    // into something the build checks: add a model provider outside the profile
    // and the gate silently stops covering it — here, loudly.
    const userData = makeUserData();
    setActiveSeatId(REAL_UUID_A);
    const seatHome = resolveCommandEveRuntimeBootstrapPaths(userData).hermesHome;
    provisionSeatRuntimeFiles({ userDataPath: userData, seatId: REAL_UUID_A });

    const config = fs.readFileSync(path.join(seatHome, 'config.yaml'), 'utf8');
    const emitted = new Set<string>();
    let underDelegation = false;
    for (const line of config.split(/\r?\n/)) {
      if (/^\S/.test(line)) underDelegation = line.startsWith('delegation:');
      const match = /^\s+provider:\s*([^\s#]+)/.exec(line);
      if (match && !underDelegation) emitted.add(match[1]);
    }
    expect(emitted.size).toBeGreaterThan(0);

    const shim = fs.readFileSync(path.join(seatHome, 'plugins', 'model-providers', 'custom', '__init__.py'), 'utf8');
    const profileRegistration = shim.slice(shim.indexOf('register_provider('));
    const name = /name="([^"]+)"/.exec(profileRegistration)?.[1];
    const aliasBlock = /aliases=\(([^)]*)\)/.exec(profileRegistration)?.[1] ?? '';
    const covered = new Set<string>([
      ...(name ? [name] : []),
      ...Array.from(aliasBlock.matchAll(/"([^"]+)"/g), (m) => m[1]),
    ]);
    expect(covered.size).toBeGreaterThan(1);

    const uncovered = [...emitted].filter((p) => !covered.has(p));
    expect(uncovered).toEqual([]);
    clearActiveSeat();
  });
});

describe('seatRuntimeConfigKeepsManualApprovals — what the config SAYS, not that it exists', () => {
  it('rejects only an EXPLICIT non-manual mode', () => {
    expect(seatRuntimeConfigKeepsManualApprovals('approvals:\n  mode: smart\n')).toBe(false);
    expect(seatRuntimeConfigKeepsManualApprovals('approvals:\n  mode: off\n')).toBe(false);
    expect(seatRuntimeConfigKeepsManualApprovals('approvals:\n  mode: manual\n')).toBe(true);
    expect(seatRuntimeConfigKeepsManualApprovals('approvals:\n  mode: "manual"\n')).toBe(true);
  });

  it('accepts an ABSENT key, because absent MEANS manual', () => {
    // FACT(whl:tools/approval.py:1064) — `.get("mode", "manual")`. Treating
    // absence as invalid would reject every config written before 1.820 and fail
    // the seat switch closed on a seat that is in fact safe; the rollback pass
    // runs through this same gate, so that would strand a dead backend rather
    // than narrow a permission.
    expect(seatRuntimeConfigKeepsManualApprovals('memory_enabled: true\n')).toBe(true);
    expect(seatRuntimeConfigKeepsManualApprovals('approvals:\n  cron_mode: deny\nskills:\n')).toBe(true);
    expect(seatRuntimeConfigKeepsManualApprovals('')).toBe(true);
  });

  it('does not let a `mode:` under a different key answer for approvals', () => {
    expect(seatRuntimeConfigKeepsManualApprovals('agent:\n  mode: smart\napprovals:\n  mode: manual\n')).toBe(true);
    expect(seatRuntimeConfigKeepsManualApprovals('approvals:\n  mode: smart\nagent:\n  mode: manual\n')).toBe(false);
  });
});

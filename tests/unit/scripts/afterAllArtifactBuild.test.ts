import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

const require = createRequire(import.meta.url);
const {
  buildNotarytoolArgs,
  getDmgSignIdentity,
  findAppForDmg,
  buildStaplerValidateArgs,
  buildSpctlAssessArgs,
  evaluateSpctlAssessment,
  verifyNotarizationStapled,
  collectVersionMismatches,
  verifyBuiltVersionMatchesSource,
  sha512Base64,
  collectMacUpdateArtifactGroups,
  buildMacUpdateYml,
  resolveMacUpdateReleaseNotes,
  writeMacUpdateFeedMetadata,
} = require('../../../scripts/afterAllArtifactBuild.js');

describe('afterAllArtifactBuild DMG notarization helpers', () => {
  it('resolves the configured DMG signing identity', () => {
    expect(
      getDmgSignIdentity({
        APPLE_DMG_SIGN_IDENTITY: 'Developer ID Application: FYN Labs LLC (NHNQ7Q5H28)',
      })
    ).toBe('Developer ID Application: FYN Labs LLC (NHNQ7Q5H28)');
  });

  it('builds notarytool args for a Keychain profile without exposing passwords', () => {
    expect(
      buildNotarytoolArgs(
        {
          keychainProfile: 'command-eve-notary',
        },
        '/tmp/Command EVE.dmg',
        {
          NOTARYTOOL_WAIT_TIMEOUT: '10m',
        }
      )
    ).toEqual([
      'notarytool',
      'submit',
      '/tmp/Command EVE.dmg',
      '--wait',
      '--timeout',
      '10m',
      '--keychain-profile',
      'command-eve-notary',
    ]);
  });

  it('builds notarytool args for an App Store Connect API key', () => {
    expect(
      buildNotarytoolArgs(
        {
          appleApiKey: '/secure/AuthKey_TEST.p8',
          appleApiKeyId: 'ABC123DEFG',
          appleApiIssuer: '00000000-0000-0000-0000-000000000000',
        },
        '/tmp/Command EVE.dmg',
        {}
      )
    ).toEqual([
      'notarytool',
      'submit',
      '/tmp/Command EVE.dmg',
      '--wait',
      '--timeout',
      '20m',
      '--key',
      '/secure/AuthKey_TEST.p8',
      '--key-id',
      'ABC123DEFG',
      '--issuer',
      '00000000-0000-0000-0000-000000000000',
    ]);
  });

  it('does not build DMG notarytool args from Apple ID password credentials', () => {
    expect(
      buildNotarytoolArgs(
        {
          appleId: 'developer@example.com',
          appleIdPassword: 'xxxx-xxxx-xxxx-xxxx',
          teamId: 'NHNQ7Q5H28',
        },
        '/tmp/Command EVE.dmg',
        {}
      )
    ).toBeNull();
  });
});

describe('afterAllArtifactBuild findAppForDmg (COMPA-591 hdiutil pipeline)', () => {
  const tempDirs: string[] = [];
  const makeOutDir = (): string => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ce-afterbuild-'));
    tempDirs.push(dir);
    return dir;
  };
  const makeApp = (outDir: string, subdir: string): string => {
    const appDir = path.join(outDir, subdir, 'Command EVE.app');
    fs.mkdirSync(appDir, { recursive: true });
    return appDir;
  };
  afterEach(() => {
    while (tempDirs.length) fs.rmSync(tempDirs.pop() as string, { recursive: true, force: true });
  });

  it('maps an arm64 DMG to the staged .app under mac-arm64/', () => {
    const outDir = makeOutDir();
    const app = makeApp(outDir, 'mac-arm64');
    makeApp(outDir, 'mac-x64'); // decoy other-arch app must not be chosen
    const dmg = path.join(outDir, 'Command-EVE-1.0.0-alpha.5-mac-arm64.dmg');
    expect(findAppForDmg(dmg, { outDir })).toBe(app);
  });

  it('maps an x64 DMG to the staged .app under mac-x64/', () => {
    const outDir = makeOutDir();
    makeApp(outDir, 'mac-arm64');
    const app = makeApp(outDir, 'mac-x64');
    const dmg = path.join(outDir, 'Command-EVE-1.0.0-alpha.5-mac-x64.dmg');
    expect(findAppForDmg(dmg, { outDir })).toBe(app);
  });

  it('falls back to the generic mac/ dir when no per-arch dir exists', () => {
    const outDir = makeOutDir();
    const app = makeApp(outDir, 'mac');
    const dmg = path.join(outDir, 'Command-EVE-1.0.0-alpha.5-mac-arm64.dmg');
    expect(findAppForDmg(dmg, { outDir })).toBe(app);
  });

  it('returns null when no .app is staged for the DMG', () => {
    const outDir = makeOutDir();
    const dmg = path.join(outDir, 'Command-EVE-1.0.0-alpha.5-mac-arm64.dmg');
    expect(findAppForDmg(dmg, { outDir })).toBeNull();
  });
});

describe('afterAllArtifactBuild notarization self-verification (fail-closed)', () => {
  it('builds stapler validate args for the DMG', () => {
    expect(buildStaplerValidateArgs('/tmp/Command EVE.dmg')).toEqual(['stapler', 'validate', '/tmp/Command EVE.dmg']);
  });

  it('builds spctl open-assessment args with the primary-signature context', () => {
    expect(buildSpctlAssessArgs('/tmp/Command EVE.dmg')).toEqual([
      '-a',
      '-t',
      'open',
      '--context',
      'context:primary-signature',
      '/tmp/Command EVE.dmg',
    ]);
  });

  it('accepts a Notarized Developer ID verdict with exit 0', () => {
    expect(evaluateSpctlAssessment(0, 'accepted\nsource=Notarized Developer ID').ok).toBe(true);
  });

  it('rejects a Gatekeeper-denied artifact (explicit reject = hard block)', () => {
    const v = evaluateSpctlAssessment(3, 'rejected\nsource=no usable signature');
    expect(v.ok).toBe(false);
    expect(v.rejected).toBe(true);
  });

  it('is inconclusive (not a reject) when spctl prints accepted but exits non-zero', () => {
    const v = evaluateSpctlAssessment(1, 'accepted');
    expect(v.ok).toBe(false);
    expect(v.rejected).toBe(false);
  });

  it('is inconclusive when spctl produces no verdict (deprecated for DMGs on macOS 15/26)', () => {
    const v = evaluateSpctlAssessment(0, '');
    expect(v.ok).toBe(false);
    expect(v.rejected).toBe(false);
  });

  it('passes verification when stapler validates and spctl accepts', () => {
    const calls: string[] = [];
    const result = verifyNotarizationStapled('/tmp/Command EVE.dmg', {
      runValidate: (p: string) => calls.push(`validate:${p}`),
      runSpctl: () => ({ status: 0, output: 'accepted\nsource=Notarized Developer ID' }),
    });
    expect(result).toBe(true);
    expect(calls).toEqual(['validate:/tmp/Command EVE.dmg']);
  });

  it('throws when stapler validate fails (no ticket stapled)', () => {
    expect(() =>
      verifyNotarizationStapled('/tmp/Command EVE.dmg', {
        runValidate: () => {
          throw new Error('does not have a ticket stapled to it');
        },
        runSpctl: () => ({ status: 0, output: 'accepted' }),
      })
    ).toThrow(/ticket stapled/);
  });

  it('throws when spctl rejects even though staple validated', () => {
    expect(() =>
      verifyNotarizationStapled('/tmp/Command EVE.dmg', {
        runValidate: () => undefined,
        runSpctl: () => ({ status: 3, output: 'rejected\nsource=no usable signature' }),
        spctlDelayMs: 0,
      })
    ).toThrow(/self-verification FAILED/);
  });

  it('passes after bounded retry when spctl lags (non-accepted twice, then accepted)', () => {
    let spctlCalls = 0;
    const result = verifyNotarizationStapled('/tmp/Command EVE.dmg', {
      runValidate: () => undefined,
      runSpctl: () => {
        spctlCalls += 1;
        // Transient Gatekeeper-DB lag: no verdict yet for the first two calls,
        // then accepted on the third.
        if (spctlCalls < 3) return { status: 0, output: '' };
        return { status: 0, output: 'accepted\nsource=Notarized Developer ID' };
      },
      spctlAttempts: 5,
      spctlDelayMs: 0,
    });
    expect(result).toBe(true);
    expect(spctlCalls).toBe(3);
  });

  it('treats an inconclusive spctl as authoritative-staple PASS after retries (does NOT throw)', () => {
    let spctlCalls = 0;
    // stapler validate already proved the staple; spctl that never returns a
    // verdict (status 0, no "accepted"/"rejected") is the macOS 15/26 deprecation
    // false-negative, NOT a rejection — it must NOT fail the build. Retries are
    // still exhausted first in case the verdict was merely lagging.
    const result = verifyNotarizationStapled('/tmp/Command EVE.dmg', {
      runValidate: () => undefined,
      runSpctl: () => {
        spctlCalls += 1;
        return { status: 0, output: '' };
      },
      spctlAttempts: 4,
      spctlDelayMs: 0,
    });
    expect(result).toBe(true);
    expect(spctlCalls).toBe(4);
  });

  it('STILL throws after retries when spctl EXPLICITLY rejects (real Gatekeeper block)', () => {
    expect(() =>
      verifyNotarizationStapled('/tmp/Command EVE.dmg', {
        runValidate: () => undefined,
        runSpctl: () => ({ status: 3, output: 'rejected\nsource=no usable signature' }),
        spctlAttempts: 4,
        spctlDelayMs: 0,
      })
    ).toThrow(/self-verification FAILED/);
  });

  it('does NOT retry — throws immediately — when stapler validate fails (staple proof is authoritative)', () => {
    let spctlCalls = 0;
    expect(() =>
      verifyNotarizationStapled('/tmp/Command EVE.dmg', {
        runValidate: () => {
          throw new Error('does not have a ticket stapled to it');
        },
        runSpctl: () => {
          spctlCalls += 1;
          return { status: 0, output: 'accepted' };
        },
        spctlAttempts: 5,
        spctlDelayMs: 0,
      })
    ).toThrow(/ticket stapled/);
    // stapler validate failure short-circuits before any spctl assessment.
    expect(spctlCalls).toBe(0);
  });

  it('stops retrying as soon as spctl accepts (no extra attempts)', () => {
    let spctlCalls = 0;
    const result = verifyNotarizationStapled('/tmp/Command EVE.dmg', {
      runValidate: () => undefined,
      runSpctl: () => {
        spctlCalls += 1;
        return { status: 0, output: 'accepted\nsource=Notarized Developer ID' };
      },
      spctlAttempts: 5,
      spctlDelayMs: 0,
    });
    expect(result).toBe(true);
    expect(spctlCalls).toBe(1);
  });
});

describe('afterAllArtifactBuild VERSION-TRUTH guard (fail-closed version consistency)', () => {
  const versionTempDirs: string[] = [];
  const makeOutDirWithApp = (): string => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ce-version-'));
    versionTempDirs.push(dir);
    fs.mkdirSync(path.join(dir, 'mac-arm64', 'Command EVE.app'), { recursive: true });
    return dir;
  };
  afterEach(() => {
    while (versionTempDirs.length) fs.rmSync(versionTempDirs.pop() as string, { recursive: true, force: true });
  });

  it('reports no mismatches when Info.plist + asar both equal the source version', () => {
    expect(
      collectVersionMismatches('1.2.12', {
        shortVersion: '1.2.12',
        bundleVersion: '1.2.12',
        asarVersion: '1.2.12',
      })
    ).toEqual([]);
  });

  it('flags the 1.1.7-class footgun: app.asar version lags the source-of-truth', () => {
    const mismatches = collectVersionMismatches('1.2.12', {
      shortVersion: '1.1.7',
      bundleVersion: '1.1.7',
      asarVersion: '1.1.7',
    });
    expect(mismatches).toHaveLength(3);
    expect(mismatches.join(' ')).toContain('1.1.7');
    expect(mismatches.join(' ')).toContain('electron-updater');
  });

  it('flags a partial mismatch (Info.plist correct but packaged asar stale)', () => {
    const mismatches = collectVersionMismatches('1.2.12', {
      shortVersion: '1.2.12',
      bundleVersion: '1.2.12',
      asarVersion: '1.1.7',
    });
    expect(mismatches).toHaveLength(1);
    expect(mismatches[0]).toContain('app.asar');
  });

  it('passes the built-app check when every stamped version matches the source', () => {
    const calls: string[] = [];
    expect(() =>
      verifyBuiltVersionMatchesSource(
        { outDir: makeOutDirWithApp() },
        {
          readRootVersion: () => '1.2.12',
          readInfoPlistVersions: (p: string) => {
            calls.push(`plist:${path.basename(p)}`);
            return { shortVersion: '1.2.12', bundleVersion: '1.2.12' };
          },
          readAsarPackageVersion: (p: string) => {
            calls.push(`asar:${path.basename(p)}`);
            return '1.2.12';
          },
        }
      )
    ).not.toThrow();
    expect(calls).toEqual(['plist:Command EVE.app', 'asar:Command EVE.app']);
  });

  it('THROWS (blocks the build) when the built app stamps the wrong version', () => {
    expect(() =>
      verifyBuiltVersionMatchesSource(
        { outDir: makeOutDirWithApp() },
        {
          readRootVersion: () => '1.2.12',
          readInfoPlistVersions: () => ({ shortVersion: '1.1.7', bundleVersion: '1.1.7' }),
          readAsarPackageVersion: () => '1.1.7',
        }
      )
    ).toThrow(/VERSION-TRUTH.*does NOT stamp the source-of-truth version \(1\.2\.12\)/s);
  });

  it('is a no-op when no built macOS .app exists (e.g. windows/linux-only run)', () => {
    const emptyOut = fs.mkdtempSync(path.join(os.tmpdir(), 'ce-version-empty-'));
    versionTempDirs.push(emptyOut);
    expect(() =>
      verifyBuiltVersionMatchesSource(
        { outDir: emptyOut },
        {
          readRootVersion: () => '1.2.12',
          // These must never be called when no .app is present.
          readInfoPlistVersions: () => {
            throw new Error('should not read plist when no app exists');
          },
          readAsarPackageVersion: () => {
            throw new Error('should not read asar when no app exists');
          },
        }
      )
    ).not.toThrow();
  });
});

describe('afterAllArtifactBuild UPDATE-FEED guard (post-hdiutil metadata)', () => {
  const feedTempDirs: string[] = [];
  const makeOutDir = (): string => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ce-update-feed-'));
    feedTempDirs.push(dir);
    return dir;
  };

  afterEach(() => {
    while (feedTempDirs.length) fs.rmSync(feedTempDirs.pop() as string, { recursive: true, force: true });
  });

  it('collects only current-version macOS update artifacts and ignores stale release files', () => {
    const outDir = makeOutDir();
    const stale = path.join(outDir, 'Command-EVE-1.7.4-mac-arm64.dmg');
    const dmg = path.join(outDir, 'Command-EVE-1.7.8-mac-arm64.dmg');
    const zip = path.join(outDir, 'Command-EVE-1.7.8-mac-arm64.zip');
    fs.writeFileSync(stale, 'old-dmg');
    fs.writeFileSync(dmg, 'new-dmg');
    fs.writeFileSync(zip, 'new-zip');

    const result = collectMacUpdateArtifactGroups(
      { outDir, artifactPaths: [stale, dmg, zip] },
      { readRootVersion: () => '1.7.8' }
    );

    expect([...result.groups.keys()]).toEqual(['arm64']);
    expect(result.groups.get('arm64')?.dmg.url).toBe('Command-EVE-1.7.8-mac-arm64.dmg');
    expect(result.groups.get('arm64')?.zip.url).toBe('Command-EVE-1.7.8-mac-arm64.zip');
  });

  it('builds electron-updater mac metadata from final zip and dmg hashes', () => {
    const yml = buildMacUpdateYml({
      version: '1.7.8',
      files: {
        zip: { url: 'Command-EVE-1.7.8-mac-arm64.zip', sha512: 'ziphash', size: 10 },
        dmg: { url: 'Command-EVE-1.7.8-mac-arm64.dmg', sha512: 'dmghash', size: 20 },
      },
      releaseDate: '2026-07-08T17:56:00Z',
      releaseNotes: 'Command EVE 1.7.8',
    });

    expect(yml).toContain('version: 1.7.8');
    expect(yml).toContain('url: Command-EVE-1.7.8-mac-arm64.zip');
    expect(yml).toContain('url: Command-EVE-1.7.8-mac-arm64.dmg');
    expect(yml).toContain('path: Command-EVE-1.7.8-mac-arm64.zip');
    expect(yml).toContain("releaseDate: '2026-07-08T17:56:00Z'");
  });

  it('loads multiline release notes from the explicit release file', () => {
    const notesPath = path.join(makeOutDir(), 'release-notes.md');
    fs.writeFileSync(notesPath, '## Neu\n\n- Hintergrund-Updates\n- Ruhiger Neustart\n');

    expect(
      resolveMacUpdateReleaseNotes('1.8.12', {
        env: { COMMAND_EVE_RELEASE_NOTES_FILE: notesPath },
      })
    ).toBe('## Neu\n\n- Hintergrund-Updates\n- Ruhiger Neustart');
  });

  it('fails closed when an explicit release notes file is empty', () => {
    const notesPath = path.join(makeOutDir(), 'release-notes.md');
    fs.writeFileSync(notesPath, '   \n');

    expect(() =>
      resolveMacUpdateReleaseNotes('1.8.12', {
        env: { COMMAND_EVE_RELEASE_NOTES_FILE: notesPath },
      })
    ).toThrow(/release notes file is empty/);
  });

  it('rewrites stale arm64 yml and version.json from the final artifact bytes', () => {
    const outDir = makeOutDir();
    const dmg = path.join(outDir, 'Command-EVE-1.7.8-mac-arm64.dmg');
    const zip = path.join(outDir, 'Command-EVE-1.7.8-mac-arm64.zip');
    fs.writeFileSync(path.join(outDir, 'latest-arm64-mac.yml'), 'version: 1.7.4\n');
    fs.writeFileSync(path.join(outDir, 'version.json'), JSON.stringify({ version: '1.7.4' }));
    fs.writeFileSync(dmg, 'final-dmg-bytes');
    fs.writeFileSync(zip, 'final-zip-bytes');

    const written = writeMacUpdateFeedMetadata(
      { outDir, artifactPaths: [dmg, zip] },
      {
        readRootVersion: () => '1.7.8',
        releaseDate: '2026-07-08T17:56:00Z',
        releaseNotes: 'Command EVE 1.7.8',
      }
    );

    expect(written.map((file: string) => path.basename(file))).toEqual(['latest-arm64-mac.yml', 'version.json']);
    const yml = fs.readFileSync(path.join(outDir, 'latest-arm64-mac.yml'), 'utf8');
    expect(yml).toContain('version: 1.7.8');
    expect(yml).toContain(`sha512: ${sha512Base64(zip)}`);
    expect(yml).toContain(`sha512: ${sha512Base64(dmg)}`);
    expect(yml).not.toContain('1.7.4');

    const versionJson = JSON.parse(fs.readFileSync(path.join(outDir, 'version.json'), 'utf8'));
    expect(versionJson).toEqual({
      version: '1.7.8',
      released_at: '2026-07-08T17:56:00Z',
      arm64: 'Command-EVE-1.7.8-mac-arm64.dmg',
    });
  });

  it('removes stale generic mac metadata for an arm64-only update feed', () => {
    const outDir = makeOutDir();
    const dmg = path.join(outDir, 'Command-EVE-1.7.91-mac-arm64.dmg');
    const zip = path.join(outDir, 'Command-EVE-1.7.91-mac-arm64.zip');
    fs.writeFileSync(path.join(outDir, 'latest-mac.yml'), 'version: 1.7.91\nsha512: stale-pre-staple\n');
    fs.writeFileSync(dmg, 'final-arm64-dmg-bytes');
    fs.writeFileSync(zip, 'final-arm64-zip-bytes');

    const written = writeMacUpdateFeedMetadata(
      { outDir, artifactPaths: [dmg, zip] },
      {
        readRootVersion: () => '1.7.91',
        releaseDate: '2026-07-09T01:34:00Z',
      }
    );

    expect(written.map((file: string) => path.basename(file))).toEqual(['latest-arm64-mac.yml', 'version.json']);
    expect(fs.existsSync(path.join(outDir, 'latest-mac.yml'))).toBe(false);
    expect(fs.readFileSync(path.join(outDir, 'latest-arm64-mac.yml'), 'utf8')).toContain(
      `sha512: ${sha512Base64(dmg)}`
    );
  });

  it('blocks incomplete mac update feeds when the zip is missing', () => {
    expect(() =>
      buildMacUpdateYml({
        version: '1.7.8',
        files: {
          dmg: { url: 'Command-EVE-1.7.8-mac-arm64.dmg', sha512: 'dmghash', size: 20 },
        },
        releaseDate: '2026-07-08T17:56:00Z',
        releaseNotes: 'Command EVE 1.7.8',
      })
    ).toThrow(/missing macOS zip artifact/);
  });
});

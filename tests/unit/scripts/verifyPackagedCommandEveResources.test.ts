import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  COMMAND_EVE_HERMES_WHEEL,
  COMMAND_EVE_PRESENTATION_PYTHON_WHEELS,
  COMMAND_EVE_PUBLIC_KEY_FILES,
  verifyPackagedCommandEveResources,
} from '../../../scripts/release/verify-packaged-command-eve-resources.mjs';

describe('packaged Command EVE resource truth', () => {
  let tempRoot = '';
  let appPath = '';
  let resourcesPath = '';
  let sourcePublicDir = '';
  let sourceArtifactManifestPath = '';
  let executablePath = '';

  beforeEach(() => {
    tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'command-eve-packaged-resources-'));
    appPath = path.join(tempRoot, 'mac-arm64', 'Command EVE.app');
    resourcesPath = path.join(appPath, 'Contents', 'Resources');
    sourcePublicDir = path.join(tempRoot, 'public');
    sourceArtifactManifestPath = path.resolve('resources/bundled-python-artifacts/manifest.json');
    executablePath = path.join(appPath, 'Contents', 'MacOS', 'Command EVE');
    fs.mkdirSync(resourcesPath, { recursive: true });
    fs.mkdirSync(sourcePublicDir, { recursive: true });
    fs.mkdirSync(path.dirname(executablePath), { recursive: true });
    fs.writeFileSync(executablePath, 'fake thin arm64 Mach-O for an injected lipo result');
    fs.cpSync(
      path.resolve('resources/bundled-hermes/presentation'),
      path.join(resourcesPath, 'bundled-hermes', 'presentation'),
      { recursive: true }
    );

    // G2 (CEVE-18205): the Hermes wheel is now pinned like the presentation
    // wheels, so the fake packaged app has to carry the real bytes.
    fs.cpSync(
      path.resolve(`resources/bundled-hermes/${COMMAND_EVE_HERMES_WHEEL.filename}`),
      path.join(resourcesPath, 'bundled-hermes', COMMAND_EVE_HERMES_WHEEL.filename)
    );
    const runnerRoot = path.join(resourcesPath, 'bundled-hermes', 'uvx', 'aarch64-apple-darwin');
    fs.mkdirSync(runnerRoot, { recursive: true });
    const runnerPath = path.join(runnerRoot, 'uvx');
    fs.writeFileSync(runnerPath, '#!/bin/sh\nexit 0\n', { mode: 0o700 });
    const runnerSha256 = crypto.createHash('sha256').update(fs.readFileSync(runnerPath)).digest('hex');
    const artifactReceipt = {
      schema_version: 'command-eve-uvx-artifact-receipt/v1',
      upstream: 'astral-sh/uv',
      version: '0.0.0-test',
      target: 'aarch64-apple-darwin',
      archive_name: 'uv-aarch64-apple-darwin.tar.gz',
      archive_sha256: 'a'.repeat(64),
      archive_entry: 'uvx',
      runner_filename: 'uvx',
      runner_sha256: runnerSha256,
      provenance: 'official-astral-release-attestation/v1',
      attestation: { repo: 'astral-sh/uv', release_tag: 'v0.0.0-test' },
    };
    const artifactReceiptPath = path.join(runnerRoot, 'uvx-artifact-receipt.json');
    fs.writeFileSync(artifactReceiptPath, `${JSON.stringify(artifactReceipt)}\n`);
    fs.writeFileSync(
      path.join(resourcesPath, 'bundled-hermes', 'uvx', 'uvx-manifest.json'),
      `${JSON.stringify({
        schema_version: 'command-eve-uvx-runner/v1',
        upstream: 'astral-sh/uv',
        version: '0.0.0-test',
        artifacts: [
          {
            target: 'aarch64-apple-darwin',
            archive_name: 'uv-aarch64-apple-darwin.tar.gz',
            archive_sha256: 'a'.repeat(64),
            archive_entry: 'uvx',
            runner_filename: 'uvx',
            runner_sha256: runnerSha256,
            artifact_receipt_sha256: crypto
              .createHash('sha256')
              .update(fs.readFileSync(artifactReceiptPath))
              .digest('hex'),
            attestation: { repo: 'astral-sh/uv', release_tag: 'v0.0.0-test' },
          },
        ],
      })}\n`
    );

    const artifactManifestBytes = fs.readFileSync(sourceArtifactManifestPath);
    const artifactManifest = JSON.parse(artifactManifestBytes.toString('utf8')) as {
      version: string;
      runtime_version: string;
      common_packages: Array<{
        name: string;
        version: string;
        import_name: string;
        filename: string;
        sha256: string;
        license: string;
      }>;
      platforms: Record<
        string,
        Array<{
          name: string;
          version: string;
          import_name: string;
          filename: string;
          sha256: string;
          license: string;
        }>
      >;
    };
    const runtimeKey = 'darwin-arm64';
    const artifactDirectory = path.join(resourcesPath, 'python', 'artifact-site-packages');
    fs.mkdirSync(artifactDirectory, { recursive: true });
    const packages = [
      ...artifactManifest.common_packages.map((entry) => ({ ...entry, scope: 'common' })),
      ...artifactManifest.platforms[runtimeKey].map((entry) => ({ ...entry, scope: runtimeKey })),
    ];
    for (const entry of packages) {
      const distName = entry.name.replace(/[-_.]+/g, '_');
      const metadataDirectory = path.join(artifactDirectory, `${distName}-${entry.version}.dist-info`);
      fs.mkdirSync(metadataDirectory, { recursive: true });
      fs.writeFileSync(path.join(metadataDirectory, 'METADATA'), `Name: ${entry.name}\nVersion: ${entry.version}\n`);
    }
    const nativeFiles = ['PIL/fake.dylib', 'lxml/fake.so'];
    for (const relativePath of nativeFiles) {
      const target = path.join(artifactDirectory, relativePath);
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, 'fake arm64 native module');
    }
    fs.writeFileSync(
      path.join(artifactDirectory, 'command-eve-artifact-python-runtime.json'),
      `${JSON.stringify(
        {
          version: artifactManifest.runtime_version,
          build_manifest_version: artifactManifest.version,
          build_manifest_sha256: crypto.createHash('sha256').update(artifactManifestBytes).digest('hex'),
          python_version: '3.12.13',
          runtime_key: runtimeKey,
          network_install_allowed: false,
          probe_status: 'pass',
          packages: packages.map((entry) => ({
            name: entry.name,
            version: entry.version,
            import_name: entry.import_name,
            wheel: entry.filename,
            wheel_sha256: entry.sha256,
            license: entry.license,
            scope: entry.scope,
          })),
          native_files: nativeFiles,
        },
        null,
        2
      )}\n`
    );

    for (const fileName of COMMAND_EVE_PUBLIC_KEY_FILES) {
      const bytes = fs.readFileSync(path.resolve('public', fileName));
      fs.writeFileSync(path.join(sourcePublicDir, fileName), bytes);
      fs.writeFileSync(path.join(resourcesPath, fileName), bytes);
    }
  });

  afterEach(() => {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  });

  const listArchiveEntriesWithReviewedAdapter = (archive: string) => {
    const entries = execFileSync('/usr/bin/unzip', ['-Z1', archive], { encoding: 'utf8' })
      .split(/\r?\n/)
      .filter(Boolean);
    return archive.endsWith(COMMAND_EVE_HERMES_WHEEL.filename) ? [...entries, 'tools/browser_use_cli.py'] : entries;
  };

  const verify = (overrides = {}, injected = {}) =>
    verifyPackagedCommandEveResources(
      {
        appPath,
        sourcePublicDir,
        sourceArtifactManifestPath,
        resourcesPath,
        expectedArch: 'arm64',
        productFilename: 'Command EVE',
        ...overrides,
      },
      {
        readArchitectures: () => ['arm64'],
        listArchiveEntries: listArchiveEntriesWithReviewedAdapter,
        ...injected,
      }
    );

  it('is wired into the electron-builder afterPack hook', () => {
    const afterPackSource = fs.readFileSync(path.resolve('scripts/afterPack.js'), 'utf8');

    expect(afterPackSource).toContain("import('./release/verify-packaged-command-eve-resources.mjs')");
    expect(afterPackSource).toContain('await verifyCommandEvePackagedResources');
  });

  it('accepts both byte-identical public keys at the packaged process.resourcesPath', () => {
    const result = verify();

    expect(result.status).toBe('PASS');
    expect(result.resources_path).toBe(resourcesPath);
    expect(result.keys.map((key) => key.file)).toEqual(COMMAND_EVE_PUBLIC_KEY_FILES);
    expect(result.presentation_python.offline_only).toBe(true);
    expect(result.presentation_python.wheels.map((wheel) => wheel.file)).toEqual(
      COMMAND_EVE_PRESENTATION_PYTHON_WHEELS.map((wheel) => wheel.filename)
    );
    expect(result.artifact_python.packages).toHaveLength(13);
    expect(result.artifact_python.native_files).toHaveLength(2);
    expect(result.browser_use_runner).toMatchObject({
      target: 'aarch64-apple-darwin',
      file: 'uvx',
      architectures: ['arm64'],
    });
    expect(result.hermes_wheel.required_entries).toEqual(['tools/browser_use_cli.py']);
  });

  it('fails closed when the Browser Use uvx resource is absent or altered', () => {
    const runner = path.join(resourcesPath, 'bundled-hermes', 'uvx', 'aarch64-apple-darwin', 'uvx');
    fs.appendFileSync(runner, 'tampered');

    expect(() => verify()).toThrow(/Browser Use uvx runner failed its SHA-256 pin/);
  });

  it('rejects a blocked-artifact Browser Use manifest even if fixture bytes exist', () => {
    const manifestPath = path.join(resourcesPath, 'bundled-hermes', 'uvx', 'uvx-manifest.json');
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    manifest.status = 'BLOCKED_ARTIFACT';
    fs.writeFileSync(manifestPath, `${JSON.stringify(manifest)}\n`);

    expect(() => verify()).toThrow(/Browser Use uvx manifest violates/);
  });

  it('rejects an unreviewed Browser Use artifact receipt or runner architecture', () => {
    const receiptPath = path.join(
      resourcesPath,
      'bundled-hermes',
      'uvx',
      'aarch64-apple-darwin',
      'uvx-artifact-receipt.json'
    );
    const receipt = JSON.parse(fs.readFileSync(receiptPath, 'utf8'));
    receipt.provenance = 'forged';
    fs.writeFileSync(receiptPath, `${JSON.stringify(receipt)}\n`);
    expect(() => verify()).toThrow(/artifact receipt violates the reviewed Astral contract/);

    fs.writeFileSync(
      receiptPath,
      `${JSON.stringify({ ...receipt, provenance: 'official-astral-release-attestation/v1' })}\n`
    );
    expect(() =>
      verify(
        {},
        {
          readArchitectures: (file: string) => (file.endsWith(`${path.sep}uvx`) ? ['x86_64'] : ['arm64']),
        }
      )
    ).toThrow(/runner must be thin arm64/);
  });

  it('rejects an artifact receipt that is not pinned by the manifest', () => {
    const manifestPath = path.join(resourcesPath, 'bundled-hermes', 'uvx', 'uvx-manifest.json');
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    manifest.artifacts[0].artifact_receipt_sha256 = '0'.repeat(64);
    fs.writeFileSync(manifestPath, `${JSON.stringify(manifest)}\n`);

    expect(() => verify()).toThrow(/artifact receipt violates the reviewed Astral contract/);
  });

  it('fails closed when python-pptx is absent from the packaged app', () => {
    fs.rmSync(
      path.join(resourcesPath, 'bundled-hermes', 'presentation', COMMAND_EVE_PRESENTATION_PYTHON_WHEELS[0].filename)
    );

    expect(() => verify()).toThrow(/packaged python_pptx-1\.0\.2-py3-none-any\.whl is missing/);
  });

  it('fails closed when a presentation wheel differs from its SHA-256 pin', () => {
    fs.appendFileSync(
      path.join(resourcesPath, 'bundled-hermes', 'presentation', COMMAND_EVE_PRESENTATION_PYTHON_WHEELS[1].filename),
      'tampered'
    );

    expect(() => verify()).toThrow(/failed its SHA-256 pin/);
  });

  it('rejects a presentation wheel that contains an unexpected native binary', () => {
    expect(() => verify({}, { listArchiveEntries: () => ['pptx/__init__.py', 'pptx/native/bridge.so'] })).toThrow(
      /unexpectedly contains native binaries/
    );
  });

  // ── G2 (CEVE-18205): the Hermes wheel gets the SAME three checks ──────────
  //
  // Before this, `hermes_agent` appeared NOWHERE in the verifier: the one wheel
  // carrying the agent runtime shipped unverified while eleven presentation
  // wheels were pinned to the byte. These three mirror the presentation cases so
  // the two can never drift into different levels of rigour.

  it('reports the packaged Hermes wheel with its pinned identity', () => {
    const result = verify();
    expect(result.hermes_wheel).toMatchObject({
      package: 'hermes-agent',
      version: COMMAND_EVE_HERMES_WHEEL.version,
      file: COMMAND_EVE_HERMES_WHEEL.filename,
      sha256: COMMAND_EVE_HERMES_WHEEL.sha256,
      native_entries: 0,
    });
    expect(result.hermes_wheel.bytes).toBeGreaterThan(0);
  });

  it('rejects the current wheel when it lacks the reviewed Browser Use adapter', () => {
    expect(() =>
      verify(
        {},
        {
          listArchiveEntries: (archive: string) =>
            execFileSync('/usr/bin/unzip', ['-Z1', archive], { encoding: 'utf8' }).split(/\r?\n/).filter(Boolean),
        }
      )
    ).toThrow(/reviewed Hermes wheel is missing required Browser Use adapter entries/);
  });

  it('fails closed when the Hermes wheel is absent from the packaged app', () => {
    fs.rmSync(path.join(resourcesPath, 'bundled-hermes', COMMAND_EVE_HERMES_WHEEL.filename));

    expect(() => verify()).toThrow(/packaged hermes_agent-.*\.whl is missing/);
  });

  it('fails closed when the Hermes wheel differs from its SHA-256 pin', () => {
    // One appended byte is the whole point: a wheel that is merely the right NAME
    // is exactly the failure mode an unpinned check could not see.
    fs.appendFileSync(path.join(resourcesPath, 'bundled-hermes', COMMAND_EVE_HERMES_WHEEL.filename), 'tampered');

    expect(() => verify()).toThrow(/hermes_agent-.*failed its SHA-256 pin/);
  });

  it('rejects a Hermes wheel that contains a native binary — the notarization tripwire', () => {
    // electron-builder.yml drops resources/bundled-hermes/web/** because Apple
    // notarytool inspects INSIDE .whl files. A native payload here would fail
    // notarization only AFTER a full signed build; this fails it at pack time.
    expect(() =>
      verify(
        {},
        {
          listArchiveEntries: (archive: string) =>
            archive.endsWith(COMMAND_EVE_HERMES_WHEEL.filename)
              ? ['hermes_agent/__init__.py', 'hermes_agent/_relay.abi3.so']
              : ['pptx/__init__.py'],
        }
      )
    ).toThrow(/hermes_agent-.*unexpectedly contains native binaries/);
  });

  it('fails closed when the signed Artifact Python receipt is stale', () => {
    const receipt = path.join(
      resourcesPath,
      'python',
      'artifact-site-packages',
      'command-eve-artifact-python-runtime.json'
    );
    const parsed = JSON.parse(fs.readFileSync(receipt, 'utf8'));
    parsed.build_manifest_sha256 = '0'.repeat(64);
    fs.writeFileSync(receipt, `${JSON.stringify(parsed)}\n`);

    expect(() => verify()).toThrow(/Artifact Python receipt violates/);
  });

  it('fails closed when any bundled Python bytecode cache would enter the signed artifact', () => {
    const cacheDirectory = path.join(resourcesPath, 'python', 'lib', 'python3.12', '__pycache__');
    fs.mkdirSync(cacheDirectory, { recursive: true });
    fs.writeFileSync(path.join(cacheDirectory, 'pathlib.cpython-312.pyc'), 'absolute build path');

    expect(() => verify()).toThrow(/bundled Python runtime contains bytecode caches/);
  });

  it('fails closed when the server public key is absent from the app', () => {
    fs.rmSync(path.join(resourcesPath, 'command-eve-license-public-key-server.pem'));

    expect(() => verify()).toThrow(/packaged command-eve-license-public-key-server\.pem is missing/);
  });

  it('fails closed when a packaged public key differs by one byte', () => {
    fs.appendFileSync(path.join(resourcesPath, 'command-eve-license-public-key.pem'), '\n');

    expect(() => verify()).toThrow(/not byte-identical/);
  });

  it('rejects a convenient directory that is not Electron process.resourcesPath', () => {
    expect(() => verify({ resourcesPath: sourcePublicDir })).toThrow(
      /resourcesPath must be the packaged Electron path/
    );
  });

  it('rejects a non-arm64 or universal executable in the arm64 release lane', () => {
    expect(() => verify({}, { readArchitectures: () => ['arm64', 'x86_64'] })).toThrow(
      /expected a thin arm64 app executable/
    );
  });

  it('blocks the build when private-key scanning finds material in the app', () => {
    fs.writeFileSync(
      path.join(resourcesPath, 'license-signing.key'),
      '-----BEGIN PRIVATE KEY-----\nforbidden\n-----END PRIVATE KEY-----\n'
    );

    expect(() => verify()).toThrow(/PRIVATE KEY material exists in the app bundle/);
  });

  it('rejects a symlinked packaged public key even when its bytes match', () => {
    const packagedKey = path.join(resourcesPath, 'command-eve-license-public-key-server.pem');
    fs.rmSync(packagedKey);
    fs.symlinkSync(path.join(sourcePublicDir, 'command-eve-license-public-key-server.pem'), packagedKey);

    expect(() => verify()).toThrow(/must be a real regular file/);
  });
});

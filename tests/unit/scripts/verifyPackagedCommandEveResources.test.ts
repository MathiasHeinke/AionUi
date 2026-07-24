import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
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

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  COMMAND_EVE_PUBLIC_KEY_FILES,
  verifyPackagedCommandEveResources,
} from '../../../scripts/release/verify-packaged-command-eve-resources.mjs';

describe('packaged Command EVE resource truth', () => {
  let tempRoot = '';
  let appPath = '';
  let resourcesPath = '';
  let sourcePublicDir = '';
  let executablePath = '';

  beforeEach(() => {
    tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'command-eve-packaged-resources-'));
    appPath = path.join(tempRoot, 'mac-arm64', 'Command EVE.app');
    resourcesPath = path.join(appPath, 'Contents', 'Resources');
    sourcePublicDir = path.join(tempRoot, 'public');
    executablePath = path.join(appPath, 'Contents', 'MacOS', 'Command EVE');
    fs.mkdirSync(resourcesPath, { recursive: true });
    fs.mkdirSync(sourcePublicDir, { recursive: true });
    fs.mkdirSync(path.dirname(executablePath), { recursive: true });
    fs.writeFileSync(executablePath, 'fake thin arm64 Mach-O for an injected lipo result');

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

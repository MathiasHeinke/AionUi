import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  COMMAND_EVE_NODE_PTY_ELECTRON_STARTUP_TIMEOUT_MS,
  COMMAND_EVE_NODE_PTY_SMOKE_SENTINEL,
  verifyPackagedNodePty,
  verifyPackagedNodePtySignatures,
} from './verify-packaged-node-pty-core.mjs';

const fixture = (version = '1.1.0') => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'eve-node-pty-proof-'));
  const resourcesPath = path.join(root, 'Resources');
  const packageRoot = path.join(resourcesPath, 'app.asar.unpacked', 'node_modules', 'node-pty');
  const binaryRoot = path.join(packageRoot, 'build', 'Release');
  fs.mkdirSync(path.join(packageRoot, 'lib'), { recursive: true });
  fs.mkdirSync(binaryRoot, { recursive: true });
  fs.writeFileSync(
    path.join(packageRoot, 'package.json'),
    JSON.stringify({ name: 'node-pty', version, main: './lib/index.js' })
  );
  fs.writeFileSync(path.join(packageRoot, 'lib', 'index.js'), 'module.exports = {};\n');
  fs.writeFileSync(
    path.join(packageRoot, 'lib', 'unixTerminal.js'),
    [
      "helperPath = helperPath.replace(/app\\.asar(?!\\.unpacked)/, 'app.asar.unpacked');",
      "helperPath = helperPath.replace(/node_modules\\.asar(?!\\.unpacked)/, 'node_modules.asar.unpacked');",
      '',
    ].join('\n')
  );
  fs.writeFileSync(path.join(binaryRoot, 'pty.node'), 'fixture');
  fs.writeFileSync(path.join(binaryRoot, 'spawn-helper'), 'fixture', { mode: 0o755 });
  const smokeScriptPath = path.join(root, 'smoke.cjs');
  fs.writeFileSync(smokeScriptPath, 'process.exit(0);\n');
  return { root, resourcesPath, packageRoot, binaryRoot, smokeScriptPath };
};

const smokeReceipt = (value, overrides = {}) =>
  `${COMMAND_EVE_NODE_PTY_SMOKE_SENTINEL} ${JSON.stringify({
    electron: '42.8.1',
    node: '24.18.1',
    modules: '146',
    arch: 'arm64',
    ptyNodePath: path.join(value.binaryRoot, 'pty.node'),
    ...overrides,
  })}\n`;

test('proves the exact package, runtime-first arm64 binaries and Electron ABI smoke', () => {
  const value = fixture();
  const calls = [];
  const receipt = verifyPackagedNodePty({
    resourcesPath: value.resourcesPath,
    expectedArch: 'arm64',
    electronExecutable: '/fake/Electron',
    smokeScriptPath: value.smokeScriptPath,
    requireElectronSmoke: true,
    runCommand: (command, args, options) => {
      calls.push([command, args, options]);
      if (command === '/usr/bin/lipo') return { status: 0, stdout: 'arm64\n', stderr: '' };
      return { status: 0, stdout: smokeReceipt(value), stderr: '' };
    },
  });
  assert.equal(receipt.version, '1.1.0');
  assert.equal(receipt.binaryRoot, value.binaryRoot);
  assert.equal(receipt.smoke, 'pass');
  assert.equal(receipt.electronAbiSmoke.modules, '146');
  assert.equal(calls.filter(([command]) => command === '/usr/bin/lipo').length, 2);
  assert.equal(calls.filter(([command]) => command === '/fake/Electron').length, 1);
  assert.equal(
    calls.find(([command]) => command === '/fake/Electron')?.[2]?.timeout,
    COMMAND_EVE_NODE_PTY_ELECTRON_STARTUP_TIMEOUT_MS
  );
});

test('fails closed on a wrong package version, missing helper or wrong architecture', () => {
  const wrongVersion = fixture('1.0.0');
  assert.throws(
    () =>
      verifyPackagedNodePty({
        resourcesPath: wrongVersion.resourcesPath,
        runCommand: () => ({ status: 0, stdout: 'arm64\n', stderr: '' }),
      }),
    /unexpected package contract/
  );

  const missingHelper = fixture();
  fs.unlinkSync(path.join(missingHelper.binaryRoot, 'spawn-helper'));
  assert.throws(
    () =>
      verifyPackagedNodePty({
        resourcesPath: missingHelper.resourcesPath,
        runCommand: () => ({ status: 0, stdout: 'arm64\n', stderr: '' }),
      }),
    /spawn-helper is missing/
  );

  const wrongArch = fixture();
  assert.throws(
    () =>
      verifyPackagedNodePty({
        resourcesPath: wrongArch.resourcesPath,
        runCommand: () => ({ status: 0, stdout: 'x86_64\n', stderr: '' }),
      }),
    /expected \[arm64\]/
  );

  const universalArch = fixture();
  assert.throws(
    () =>
      verifyPackagedNodePty({
        resourcesPath: universalArch.resourcesPath,
        runCommand: () => ({ status: 0, stdout: 'arm64 x86_64\n', stderr: '' }),
      }),
    /expected \[arm64\]/
  );
});

test('rejects symlinked packaged files and mismatched Electron smoke receipts', () => {
  const symlinked = fixture();
  const realManifest = path.join(symlinked.root, 'manifest.json');
  fs.renameSync(path.join(symlinked.packageRoot, 'package.json'), realManifest);
  fs.symlinkSync(realManifest, path.join(symlinked.packageRoot, 'package.json'));
  assert.throws(
    () =>
      verifyPackagedNodePty({
        resourcesPath: symlinked.resourcesPath,
        runCommand: () => ({ status: 0, stdout: 'arm64\n', stderr: '' }),
      }),
    /package\.json must not be a symlink/
  );

  const wrongLoadedBinary = fixture();
  assert.throws(
    () =>
      verifyPackagedNodePty({
        resourcesPath: wrongLoadedBinary.resourcesPath,
        electronExecutable: '/fake/Electron',
        smokeScriptPath: wrongLoadedBinary.smokeScriptPath,
        requireElectronSmoke: true,
        runCommand: (command) =>
          command === '/usr/bin/lipo'
            ? { status: 0, stdout: 'arm64\n', stderr: '' }
            : {
                status: 0,
                stdout: smokeReceipt(wrongLoadedBinary, { ptyNodePath: '/tmp/wrong/pty.node' }),
                stderr: '',
              },
      }),
    /Electron ABI smoke loaded/
  );
});

test('normalizes x64 Mach-O output and defines the universal architecture contract', () => {
  const x64 = fixture();
  const x64Receipt = verifyPackagedNodePty({
    resourcesPath: x64.resourcesPath,
    expectedArch: 'x64',
    runCommand: () => ({ status: 0, stdout: 'x86_64\n', stderr: '' }),
  });
  assert.deepEqual(x64Receipt.architectures['pty.node'], ['x86_64']);

  const universal = fixture();
  const universalReceipt = verifyPackagedNodePty({
    resourcesPath: universal.resourcesPath,
    expectedArch: 'universal',
    runCommand: () => ({ status: 0, stdout: 'arm64 x86_64\n', stderr: '' }),
  });
  assert.deepEqual(universalReceipt.architectures['spawn-helper'], ['arm64', 'x86_64']);
});

test('keeps the source dependency pinned to the verifier contract', () => {
  const rootManifest = JSON.parse(fs.readFileSync(new URL('../../package.json', import.meta.url), 'utf8'));
  assert.equal(rootManifest.dependencies['node-pty'], '1.1.0');
});

test('keeps the packaged smoke fail-closed while allowing macOS cold native startup', () => {
  const smokeSource = fs.readFileSync(new URL('./smoke-packaged-node-pty.cjs', import.meta.url), 'utf8');
  assert.match(smokeSource, /const SMOKE_TIMEOUT_MS = 60_000;/);
  assert.match(smokeSource, /}, SMOKE_TIMEOUT_MS\);/);
  assert.ok(COMMAND_EVE_NODE_PTY_ELECTRON_STARTUP_TIMEOUT_MS > 60_000);
});

test('runs the final packaged proof after transforms and before fuse hardening', () => {
  const hookSource = fs.readFileSync(new URL('../afterPack.js', import.meta.url), 'utf8');
  const finalVerifier = hookSource.indexOf('async function verifyFinalPackagedState');
  const asarPatch = hookSource.indexOf('await patchPackagedNodePty({', finalVerifier);
  const nativeProof = hookSource.indexOf('await verifyPackagedNodePty({', finalVerifier);
  assert.ok(finalVerifier >= 0);
  assert.ok(finalVerifier < asarPatch);
  assert.ok(asarPatch < nativeProof);

  const sameArchBranch = hookSource.indexOf('if (!isCrossCompile && !needsSameArchRebuild && !forceRebuild)');
  const sameArchProof = hookSource.indexOf('await verifyFinalPackagedState({', sameArchBranch);
  const sameArchFuse = hookSource.indexOf('await applyPackagedElectronFusePolicy(', sameArchProof);
  const sameArchReturn = hookSource.indexOf('return;', sameArchFuse);
  assert.ok(sameArchBranch >= 0);
  assert.ok(sameArchBranch < sameArchProof);
  assert.ok(sameArchProof < sameArchFuse);
  assert.ok(sameArchFuse < sameArchReturn);

  const rebuildGate = hookSource.indexOf('if (failedModules.length > 0)');
  const rebuiltProof = hookSource.indexOf('await verifyFinalPackagedState({', rebuildGate);
  const rebuiltFuse = hookSource.indexOf('await applyPackagedElectronFusePolicy(', rebuiltProof);
  assert.ok(rebuildGate >= 0);
  assert.ok(rebuildGate < rebuiltProof);
  assert.ok(rebuiltProof < rebuiltFuse);
});

test('targets both nested native signatures after electron-builder signing', () => {
  const value = fixture();
  const targets = [];
  verifyPackagedNodePtySignatures({
    resourcesPath: value.resourcesPath,
    runCommand: (_command, args) => {
      targets.push(args.at(-1));
      return { status: 0, stdout: '', stderr: '' };
    },
  });
  assert.deepEqual(
    targets.toSorted(),
    [path.join(value.binaryRoot, 'pty.node'), path.join(value.binaryRoot, 'spawn-helper')].toSorted()
  );
});

test('requires the nested binaries to match the outer Developer ID team', () => {
  const value = fixture();
  const appPath = path.join(value.root, 'Command EVE.app');
  fs.mkdirSync(appPath);
  const identity = 'Developer ID Application: FYN Labs LLC (NHNQ7Q5H28)';
  const display = (teamIdentifier = 'NHNQ7Q5H28', authority = identity, signature = 'signed') => ({
    status: 0,
    stdout: '',
    stderr: `Signature=${signature}\nAuthority=${authority}\nTeamIdentifier=${teamIdentifier}\n`,
  });
  const valid = verifyPackagedNodePtySignatures({
    appPath,
    resourcesPath: value.resourcesPath,
    requireDeveloperId: true,
    runCommand: (_command, args) => (args[0] === '--display' ? display() : { status: 0, stdout: '', stderr: '' }),
  });
  assert.equal(valid.appMetadata.teamIdentifier, 'NHNQ7Q5H28');

  assert.throws(
    () =>
      verifyPackagedNodePtySignatures({
        appPath,
        resourcesPath: value.resourcesPath,
        requireDeveloperId: true,
        runCommand: (_command, args) => {
          if (args[0] !== '--display') return { status: 0, stdout: '', stderr: '' };
          return args.at(-1) === appPath ? display() : display('OTHERTEAM');
        },
      }),
    /TeamIdentifier OTHERTEAM does not match/
  );

  assert.throws(
    () =>
      verifyPackagedNodePtySignatures({
        appPath,
        resourcesPath: value.resourcesPath,
        requireDeveloperId: true,
        runCommand: (_command, args) =>
          args[0] === '--display'
            ? args.at(-1) === appPath
              ? display()
              : display('not set', '', 'adhoc')
            : { status: 0, stdout: '', stderr: '' },
      }),
    /not signed by a Developer ID Application authority/
  );
});

test('propagates a nonzero nested codesign verification', () => {
  const value = fixture();
  assert.throws(
    () =>
      verifyPackagedNodePtySignatures({
        resourcesPath: value.resourcesPath,
        runCommand: () => ({ status: 1, stdout: '', stderr: 'invalid signature' }),
      }),
    /pty\.node signature: invalid signature/
  );
});

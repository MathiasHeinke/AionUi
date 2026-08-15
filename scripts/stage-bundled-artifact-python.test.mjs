import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  COMMAND_EVE_ARTIFACT_PYTHON_BUILD_VERSION,
  artifactPythonProbeArgs,
  assertCombinedWheelLayout,
  assertRuntimeDependencyClosure,
  evaluateDependencyMarkersWithPackaging,
  extractWheel,
  inspectWheel,
  readBuildManifest,
  removePreviouslySpreadFiles,
  resolvePackageSources,
  safeWheelEntryPath,
  stripBytecodeCaches,
  writeArtifactComplianceFiles,
} from './stage-bundled-artifact-python.mjs';
import { HERMES_RUNTIME_LOCK, parseHermesRuntimeLock } from './hermes/fetch-bundled-hermes-runtime.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const MANIFEST = path.resolve(HERE, '..', 'resources', 'bundled-python-artifacts', 'manifest.json');

test('artifact Python manifest resolves the exact reviewed macOS and Windows closures', () => {
  const manifest = readBuildManifest(MANIFEST);
  assert.equal(manifest.version, COMMAND_EVE_ARTIFACT_PYTHON_BUILD_VERSION);

  for (const [platform, arch, expectedCount] of [
    ['darwin', 'arm64', 13],
    ['win32', 'x64', 14],
  ]) {
    const resolved = resolvePackageSources({
      manifestPath: MANIFEST,
      manifest,
      platform,
      arch,
      includeHermesRuntime: false,
    });
    assert.equal(resolved.packages.length, expectedCount);
    const expectedNames = [
      'Pillow',
      'XlsxWriter',
      'charset-normalizer',
      'defusedxml',
      'et-xmlfile',
      'lxml',
      'openpyxl',
      'pypdf',
      'python-docx',
      'python-pptx',
      'qrcode',
      'reportlab',
      'typing-extensions',
      ...(platform === 'win32' ? ['colorama'] : []),
    ];
    assert.deepEqual(resolved.packages.map((entry) => entry.name).sort(), expectedNames.sort());
    assert.equal(
      resolved.packages.some((entry) => entry.name === 'PyMuPDF'),
      false
    );
    assert.equal(
      resolved.packages.every((entry) => entry.license.length > 0),
      true
    );
  }
});

test('darwin-arm64 adds the exact Hermes runtime closure while Windows remains unchanged', () => {
  const manifest = readBuildManifest(MANIFEST);
  const darwinBase = resolvePackageSources({
    manifestPath: MANIFEST,
    manifest,
    platform: 'darwin',
    arch: 'arm64',
    includeHermesRuntime: false,
  });
  const windows = resolvePackageSources({ manifestPath: MANIFEST, manifest, platform: 'win32', arch: 'x64' });
  const lock = parseHermesRuntimeLock(fs.readFileSync(HERMES_RUNTIME_LOCK, 'utf8'));
  const baseNames = new Set(darwinBase.packages.map((entry) => entry.name.toLowerCase().replace(/[-_.]+/g, '-')));
  const stagedRuntime = lock.filter((entry) => !baseNames.has(entry.name.toLowerCase().replace(/[-_.]+/g, '-')));

  assert.equal(darwinBase.packages.length + stagedRuntime.length, 88);
  assert.equal(stagedRuntime.length, 75);
  assert.equal(
    stagedRuntime.some((entry) => entry.name === 'hermes-agent' && entry.version === '0.20.0'),
    true
  );
  assert.equal(
    stagedRuntime.some((entry) => entry.name === 'ddgs' && entry.version === '9.14.4'),
    true
  );
  assert.equal(windows.packages.length, 14);
  assert.equal(
    windows.packages.some((entry) => entry.scope === 'hermes-runtime'),
    false
  );
});

test('wheel extraction path guard rejects traversal, absolute paths and symlinky separators', () => {
  assert.equal(safeWheelEntryPath('package/module.py'), path.join('package', 'module.py'));
  for (const unsafe of ['../escape.py', '/absolute.py', 'package/../../escape.py', 'package\\escape.py', '']) {
    assert.throws(() => safeWheelEntryPath(unsafe), /Unsafe wheel entry path/);
  }
});

test('dependency closure evaluates Windows markers and fails closed when qrcode lacks colorama', () => {
  const qrcode = {
    name: 'qrcode',
    metadata: 'Name: qrcode\nVersion: 8.2\nRequires-Dist: colorama ; sys_platform == "win32"\n',
  };
  const installed = new Map([['qrcode', qrcode]]);

  assert.doesNotThrow(() => assertRuntimeDependencyClosure(installed, 'darwin-arm64', '3.12.13'));
  assert.throws(
    () => assertRuntimeDependencyClosure(installed, 'win32-x64', '3.12.13'),
    /missing colorama on win32-x64/
  );

  installed.set('colorama', { name: 'colorama', metadata: 'Name: colorama\nVersion: 0.4.6\n' });
  assert.doesNotThrow(() => assertRuntimeDependencyClosure(installed, 'win32-x64', '3.12.13'));
});

test('dependency closure evaluates the locked CPython implementation and compound platform markers', () => {
  const root = {
    name: 'runtime-root',
    metadata: [
      'Name: runtime-root',
      'Version: 1.0.0',
      'Requires-Dist: pycparser; implementation_name != "PyPy"',
      "Requires-Dist: cffi; platform_python_implementation != 'PyPy'",
      'Requires-Dist: colorama; platform_system == "Windows"',
      "Requires-Dist: typing-extensions; python_full_version < '3.11'",
      "Requires-Dist: pywin32; sys_platform == 'win32' and python_version < '3.14'",
      "Requires-Dist: uvicorn; sys_platform != 'emscripten'",
      'Requires-Dist: ruamel-yaml-clib; platform_python_implementation == "CPython" and python_version < "3.15"',
      '',
    ].join('\n'),
  };
  const installed = new Map(
    ['runtime-root', 'pycparser', 'cffi', 'uvicorn', 'ruamel-yaml-clib'].map((name) => [
      name,
      name === 'runtime-root' ? root : { name, metadata: `Name: ${name}\nVersion: 1.0.0\n` },
    ])
  );

  assert.doesNotThrow(() => assertRuntimeDependencyClosure(installed, 'darwin-arm64', '3.12.13'));

  installed.set('colorama', { name: 'colorama', metadata: 'Name: colorama\nVersion: 0.4.6\n' });
  installed.set('pywin32', { name: 'pywin32', metadata: 'Name: pywin32\nVersion: 311\n' });
  assert.doesNotThrow(() => assertRuntimeDependencyClosure(installed, 'win32-x64', '3.12.13'));
});

test('dependency markers compare python_version as major.minor and reject unknown variables', () => {
  const exactMinor = new Map([
    [
      'runtime-root',
      {
        name: 'runtime-root',
        metadata: 'Name: runtime-root\nVersion: 1.0.0\nRequires-Dist: exact-python; python_version == "3.12"\n',
      },
    ],
  ]);
  assert.throws(
    () => assertRuntimeDependencyClosure(exactMinor, 'darwin-arm64', '3.12.13'),
    /missing exact-python on darwin-arm64/
  );

  const unknown = new Map([
    [
      'runtime-root',
      {
        name: 'runtime-root',
        metadata: 'Name: runtime-root\nVersion: 1.0.0\nRequires-Dist: unsafe; platform_release == "unknown"\n',
      },
    ],
  ]);
  assert.throws(
    () => assertRuntimeDependencyClosure(unknown, 'darwin-arm64', '3.12.13'),
    /Unsupported Artifact Python dependency marker/
  );
});

test('dependency marker evaluation delegates full PEP 508 grammar to the pinned packaging runtime', (t) => {
  const root = makeTempDir(t);
  const interpreter = path.join(root, 'python3.12');
  const targetDirectory = path.join(root, 'artifact-site-packages');
  fs.writeFileSync(interpreter, 'python');
  fs.mkdirSync(targetDirectory);
  const complexMarker =
    '(sys_platform == "darwin" and platform_machine == "arm64") or ' +
    '(sys_platform == "linux" and "android" not in platform_release)';
  const installed = new Map([
    [
      'runtime-root',
      {
        name: 'runtime-root',
        metadata: [
          'Name: runtime-root',
          'Version: 1.0.0',
          `Requires-Dist: nemo-relay; ${complexMarker}`,
          "Requires-Dist: colorama; platform_system == 'Windows'",
          '',
        ].join('\n'),
      },
    ],
  ]);
  let invocation;
  const activity = evaluateDependencyMarkersWithPackaging(
    { installed, interpreter, targetDirectory },
    {
      spawnSync(command, args, options) {
        invocation = { command, args, options };
        return {
          status: 0,
          stdout: JSON.stringify({
            version: 'command-eve-pep508-marker-evaluator/v1',
            results: [true, false],
          }),
          stderr: '',
        };
      },
    }
  );

  assert.equal(invocation.command, interpreter);
  assert.deepEqual(invocation.args.slice(0, 5), ['-B', '-I', '-P', '-S', '-c']);
  assert.equal(invocation.args.at(-1), targetDirectory);
  assert.deepEqual(JSON.parse(invocation.options.input), [complexMarker, "platform_system == 'Windows'"]);
  assert.equal(activity.get(complexMarker), true);
  assert.equal(activity.get("platform_system == 'Windows'"), false);
});

test('dependency marker evaluation rejects malformed subprocess receipts', (t) => {
  const root = makeTempDir(t);
  const interpreter = path.join(root, 'python3.12');
  const targetDirectory = path.join(root, 'artifact-site-packages');
  fs.writeFileSync(interpreter, 'python');
  fs.mkdirSync(targetDirectory);
  const installed = new Map([
    [
      'runtime-root',
      {
        name: 'runtime-root',
        metadata: 'Name: runtime-root\nVersion: 1.0.0\nRequires-Dist: unsafe; sys_platform == "darwin"\n',
      },
    ],
  ]);

  assert.throws(
    () =>
      evaluateDependencyMarkersWithPackaging(
        { installed, interpreter, targetDirectory },
        { spawnSync: () => ({ status: 0, stdout: '{"version":"wrong","results":[true]}', stderr: '' }) }
      ),
    /invalid receipt/
  );
});

test('compliance output preserves a verified metadata-only license declaration without inventing text', (t) => {
  const targetDirectory = makeTempDir(t);
  fs.mkdirSync(path.join(targetDirectory, 'primp-1.3.1.dist-info'));
  fs.mkdirSync(path.join(targetDirectory, 'ruamel_yaml-0.18.17.dist-info', 'licenses'), { recursive: true });
  fs.writeFileSync(
    path.join(targetDirectory, 'ruamel_yaml-0.18.17.dist-info', 'licenses', 'LICENSE'),
    'ruamel exact license text\n'
  );
  fs.mkdirSync(path.join(targetDirectory, 'uvloop-0.22.1.dist-info', 'licenses'), { recursive: true });
  fs.writeFileSync(
    path.join(targetDirectory, 'uvloop-0.22.1.dist-info', 'licenses', 'LICENSE-APACHE'),
    'uvloop Apache text\n'
  );
  fs.writeFileSync(
    path.join(targetDirectory, 'uvloop-0.22.1.dist-info', 'licenses', 'LICENSE-MIT'),
    'uvloop MIT text\n'
  );
  const packages = [
    {
      name: 'primp',
      version: '1.3.1',
      license: 'MIT License',
      filename: 'primp-1.3.1-cp310-abi3-macosx_11_0_arm64.whl',
      sha256: 'a'.repeat(64),
    },
    {
      name: 'ruamel.yaml',
      version: '0.18.17',
      license: 'MIT License',
      filename: 'ruamel_yaml-0.18.17-py3-none-any.whl',
      sha256: 'b'.repeat(64),
    },
    {
      name: 'uvloop',
      version: '0.22.1',
      license: 'MIT OR Apache-2.0',
      filename: 'uvloop-0.22.1-cp312-cp312-macosx_11_0_arm64.whl',
      sha256: 'c'.repeat(64),
    },
  ];

  writeArtifactComplianceFiles({ targetDirectory, packages, manifest: { python_version: '3.12.13' } });

  const notices = fs.readFileSync(path.join(targetDirectory, 'THIRD_PARTY_NOTICES.txt'), 'utf8');
  assert.match(notices, /primp 1\.3\.1/);
  assert.match(notices, /License: MIT License/);
  assert.match(notices, /No separate license text was shipped in this exact wheel/);
  assert.match(notices, /ruamel exact license text/);
  assert.match(notices, /uvloop Apache text/);
  assert.match(notices, /uvloop MIT text/);
  assert.equal((notices.match(/No separate license text was shipped/g) || []).length, 1);
  const sbom = JSON.parse(fs.readFileSync(path.join(targetDirectory, 'sbom.cyclonedx.json'), 'utf8'));
  assert.equal(sbom.components[0].licenses[0].license.name, 'MIT License');
});

test('isolated artifact probe explicitly disables bytecode writes', () => {
  const args = artifactPythonProbeArgs([], '/tmp/artifact-site');

  assert.deepEqual(args.slice(0, 4), ['-B', '-I', '-P', '-S']);
  assert.equal(args[4], '-c');
  assert.match(args[5], /ARTIFACT_PYTHON_READY/);
});

test('bytecode cleanup covers the complete staged Python tree without following runtime symlinks', (t) => {
  const pythonRoot = makeTempDir(t);
  const stdlibCache = path.join(pythonRoot, 'lib', 'python3.12', '__pycache__');
  const artifactCache = path.join(pythonRoot, 'artifact-site-packages', 'pkg', '__pycache__');
  fs.mkdirSync(stdlibCache, { recursive: true });
  fs.mkdirSync(artifactCache, { recursive: true });
  fs.writeFileSync(path.join(stdlibCache, 'pathlib.cpython-312.pyc'), 'absolute-build-path');
  fs.writeFileSync(path.join(artifactCache, 'module.cpython-312.pyc'), 'cache');
  fs.writeFileSync(path.join(pythonRoot, 'lib', 'python3.12', 'pathlib.py'), '# source stays\n');
  fs.symlinkSync('python3.12', path.join(pythonRoot, 'python3'));

  stripBytecodeCaches(pythonRoot);

  assert.equal(fs.existsSync(stdlibCache), false);
  assert.equal(fs.existsSync(artifactCache), false);
  assert.equal(fs.existsSync(path.join(pythonRoot, 'lib', 'python3.12', 'pathlib.py')), true);
  assert.equal(fs.readlinkSync(path.join(pythonRoot, 'python3')), 'python3.12');
});

test('an interrupted stage removes only its pinned spread scripts before retry', (t) => {
  const pythonRoot = makeTempDir(t);
  const targetDirectory = path.join(pythonRoot, 'artifact-site-packages');
  const stagedScript = path.join(pythonRoot, 'bin', 'vba_extract.py');
  const unrelatedScript = path.join(pythonRoot, 'bin', 'python-tool');
  fs.mkdirSync(targetDirectory, { recursive: true });
  fs.mkdirSync(path.dirname(stagedScript), { recursive: true });
  fs.writeFileSync(stagedScript, 'partial wheel output');
  fs.writeFileSync(unrelatedScript, 'bundled interpreter tool');

  removePreviouslySpreadFiles(targetDirectory, pythonRoot, new Set(['bin/vba_extract.py']));

  assert.equal(fs.existsSync(stagedScript), false);
  assert.equal(fs.readFileSync(unrelatedScript, 'utf8'), 'bundled interpreter tool');
});

// ---------------------------------------------------------------------------
// Pro-verdict Gate 2: wheel-mutation security tests (fail-closed staging)
//
// Synthetic wheels are built with a minimal STORE-only ZIP writer (compression
// method 0, correct CRC32 in local headers + central directory, UTF-8 names)
// so every tampered variant can be fed through inspectWheel / extractWheel.
// NOTE: inspectWheel does NOT re-hash the wheel bytes against entry.sha256 —
// the wheel-bytes-vs-pin gate lives in resolvePackageSources. The sha256 field
// below is recomputed per buffer purely for entry-shape fidelity with the
// production call sites.
// ---------------------------------------------------------------------------

const CRC32_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let index = 0; index < 256; index += 1) {
    let value = index;
    for (let bit = 0; bit < 8; bit += 1) {
      value = value & 1 ? (value >>> 1) ^ 0xedb88320 : value >>> 1;
    }
    table[index] = value >>> 0;
  }
  return table;
})();

function crc32(buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) crc = (crc >>> 8) ^ CRC32_TABLE[(crc ^ byte) & 0xff];
  return (crc ^ 0xffffffff) >>> 0;
}

// Minimal STORE-only ZIP writer: local file headers, central directory, EOCD.
// Filenames are written as UTF-8 with general-purpose flag bit 11 set so NFC/
// NFD variants survive yauzl's decodeStrings exactly as queued.
function buildStoredZip(entries) {
  const localParts = [];
  const centralParts = [];
  let offset = 0;
  for (const { name, data } of entries) {
    const nameBytes = Buffer.from(name, 'utf8');
    const crc = crc32(data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0); // local file header signature
    local.writeUInt16LE(20, 4); // version needed to extract
    local.writeUInt16LE(0x0800, 6); // general purpose flag: UTF-8 names
    local.writeUInt16LE(0, 8); // compression method: STORE
    local.writeUInt16LE(0, 10); // last mod time
    local.writeUInt16LE(0x21, 12); // last mod date: 1980-01-01
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(data.length, 18); // compressed size
    local.writeUInt32LE(data.length, 22); // uncompressed size
    local.writeUInt16LE(nameBytes.length, 26);
    local.writeUInt16LE(0, 28); // extra field length
    localParts.push(local, nameBytes, data);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0); // central directory header signature
    central.writeUInt16LE(20, 4); // version made by
    central.writeUInt16LE(20, 6); // version needed to extract
    central.writeUInt16LE(0x0800, 8);
    central.writeUInt16LE(0, 10);
    central.writeUInt16LE(0, 12);
    central.writeUInt16LE(0x21, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(data.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(nameBytes.length, 28);
    central.writeUInt16LE(0, 30); // extra field length
    central.writeUInt16LE(0, 32); // comment length
    central.writeUInt16LE(0, 34); // disk number start
    central.writeUInt16LE(0, 36); // internal file attributes
    central.writeUInt32LE((0o100644 << 16) >>> 0, 38); // external attributes: regular file, 0644
    central.writeUInt32LE(offset, 42); // relative offset of local header
    centralParts.push(central, nameBytes);
    offset += 30 + nameBytes.length + data.length;
  }
  const centralDirectory = Buffer.concat(centralParts);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0); // end of central directory signature
  eocd.writeUInt16LE(0, 4); // number of this disk
  eocd.writeUInt16LE(0, 6); // disk with start of central directory
  eocd.writeUInt16LE(entries.length, 8); // central directory records on this disk
  eocd.writeUInt16LE(entries.length, 10); // total central directory records
  eocd.writeUInt32LE(centralDirectory.length, 12);
  eocd.writeUInt32LE(offset, 16); // offset of central directory start
  eocd.writeUInt16LE(0, 20); // comment length
  return Buffer.concat([...localParts, centralDirectory, eocd]);
}

function recordDigest(buffer) {
  return `sha256=${crypto.createHash('sha256').update(buffer).digest('base64url')}`;
}

// Builds a well-formed synthetic wheel and lets each test mutate exactly one
// property (payload bytes, RECORD rows, entry names) via transformRecord or
// the injected files map. dist-info METADATA/WHEEL/RECORD are synthesized to
// satisfy the inspectWheel metadata contract unless a test overrides them.
function buildSyntheticWheel({ distribution = 'mutation-pkg', version = '1.0.0', files = {}, transformRecord } = {}) {
  const moduleName = distribution.replaceAll('-', '_');
  const distInfo = `${moduleName}-${version}.dist-info`;
  const archiveFiles = new Map();
  for (const [name, data] of Object.entries(files)) {
    archiveFiles.set(name, Buffer.isBuffer(data) ? data : Buffer.from(String(data), 'utf8'));
  }
  if (!archiveFiles.has(`${distInfo}/METADATA`)) {
    archiveFiles.set(
      `${distInfo}/METADATA`,
      Buffer.from(`Metadata-Version: 2.1\nName: ${distribution}\nVersion: ${version}\nLicense: MIT\n`, 'utf8')
    );
  }
  if (!archiveFiles.has(`${distInfo}/WHEEL`)) {
    archiveFiles.set(
      `${distInfo}/WHEEL`,
      Buffer.from(
        'Wheel-Version: 1.0\nGenerator: eve-mutation-test\nRoot-Is-Purelib: true\nTag: py3-none-any\n',
        'utf8'
      )
    );
  }
  const recordPath = `${distInfo}/RECORD`;
  let recordRows = [];
  for (const [name, data] of archiveFiles) {
    recordRows.push({ path: name, hash: recordDigest(data), size: String(data.length) });
  }
  if (transformRecord) recordRows = transformRecord(recordRows, archiveFiles);
  const recordLines = recordRows.map((row) => `${row.path},${row.hash},${row.size}`);
  recordLines.push(`${recordPath},,`);
  archiveFiles.set(recordPath, Buffer.from(`${recordLines.join('\n')}\n`, 'utf8'));
  return buildStoredZip([...archiveFiles].map(([name, data]) => ({ name, data })));
}

function makeTempDir(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'eve-wheel-mutation-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  return directory;
}

function stageSyntheticWheel(t, options = {}) {
  const directory = makeTempDir(t);
  const buffer = buildSyntheticWheel(options);
  const distribution = options.distribution || 'mutation-pkg';
  const version = options.version || '1.0.0';
  const filename = `${distribution.replaceAll('-', '_')}-${version}-py3-none-any.whl`;
  const wheelPath = path.join(directory, filename);
  fs.writeFileSync(wheelPath, buffer);
  return {
    name: distribution,
    version,
    filename,
    sha256: crypto.createHash('sha256').update(buffer).digest('hex'),
    wheelPath,
  };
}

test('mutation baseline: a well-formed synthetic wheel passes inspectWheel', async (t) => {
  const entry = stageSyntheticWheel(t, { files: { 'mutation_pkg/module.py': "print('ok')\n" } });
  const inspection = await inspectWheel(entry);
  assert.ok(inspection.filePaths.includes('mutation_pkg/module.py'));
  assert.ok(inspection.filePaths.includes('mutation_pkg-1.0.0.dist-info/METADATA'));
  assert.ok(inspection.filePaths.includes('mutation_pkg-1.0.0.dist-info/RECORD'));
  assert.deepEqual(inspection.tags, ['py3-none-any']);
  assert.match(inspection.metadataSha256, /^[a-f0-9]{64}$/);
});

test('mutation (a): one flipped byte in a .py file breaks the RECORD hash', async (t) => {
  const original = Buffer.from("print('payload-v1')\n", 'utf8');
  const tampered = Buffer.from(original);
  tampered[8] = tampered[8] ^ 0x01; // single-bit flip, length unchanged
  assert.notEqual(recordDigest(tampered), recordDigest(original));
  const entry = stageSyntheticWheel(t, {
    files: { 'mutation_pkg/module.py': tampered },
    transformRecord: (rows) =>
      rows.map((row) =>
        row.path === 'mutation_pkg/module.py'
          ? { ...row, hash: recordDigest(original), size: String(original.length) } // RECORD keeps the ORIGINAL hash
          : row
      ),
  });
  await assert.rejects(() => inspectWheel(entry), /Wheel RECORD hash mismatch for mutation_pkg\/module\.py/);
});

test('mutation (b): an extra archive file absent from RECORD is rejected', async (t) => {
  const entry = stageSyntheticWheel(t, {
    files: { 'mutation_pkg/module.py': 'ok\n', 'mutation_pkg/smuggled.py': 'import os\n' },
    transformRecord: (rows) => rows.filter((row) => row.path !== 'mutation_pkg/smuggled.py'),
  });
  await assert.rejects(() => inspectWheel(entry), /Wheel RECORD is missing archive file mutation_pkg\/smuggled\.py/);
});

test('mutation (c): RECORD naming a file absent from the archive is rejected', async (t) => {
  const ghost = Buffer.from('ghost payload\n', 'utf8');
  const entry = stageSyntheticWheel(t, {
    files: { 'mutation_pkg/module.py': 'ok\n' },
    transformRecord: (rows) => [
      ...rows,
      { path: 'mutation_pkg/ghost.py', hash: recordDigest(ghost), size: String(ghost.length) },
    ],
  });
  await assert.rejects(() => inspectWheel(entry), /Wheel RECORD names a missing archive file mutation_pkg\/ghost\.py/);
});

test('mutation (d): a wrong hash recorded in RECORD for an intact file is rejected', async (t) => {
  const entry = stageSyntheticWheel(t, {
    files: { 'mutation_pkg/module.py': 'honest content\n' },
    transformRecord: (rows) =>
      rows.map((row) =>
        row.path === 'mutation_pkg/module.py'
          ? { ...row, hash: recordDigest(Buffer.from('attacker-controlled', 'utf8')) }
          : row
      ),
  });
  await assert.rejects(() => inspectWheel(entry), /Wheel RECORD hash mismatch for mutation_pkg\/module\.py/);
});

test('mutation (d2): a wrong size recorded in RECORD for an intact file is rejected', async (t) => {
  const content = Buffer.from('size matters\n', 'utf8');
  const entry = stageSyntheticWheel(t, {
    files: { 'mutation_pkg/module.py': content },
    transformRecord: (rows) =>
      rows.map((row) => (row.path === 'mutation_pkg/module.py' ? { ...row, size: String(content.length + 1) } : row)),
  });
  await assert.rejects(() => inspectWheel(entry), /Wheel RECORD size mismatch for mutation_pkg\/module\.py/);
});

test('mutation (e): casefold collision A.py + a.py in the same wheel is rejected', async (t) => {
  const entry = stageSyntheticWheel(t, {
    files: { 'mutation_pkg/A.py': 'first\n', 'mutation_pkg/a.py': 'second\n' },
  });
  await assert.rejects(() => inspectWheel(entry), /casefold\/NFC path collision/);
});

test('mutation (f): NFC/NFD unicode filename collision in the same wheel is rejected', async (t) => {
  const entry = stageSyntheticWheel(t, {
    files: { 'mutation_pkg/ä.py': 'nfc form\n', 'mutation_pkg/ä.py': 'nfd form\n' },
  });
  await assert.rejects(() => inspectWheel(entry), /casefold\/NFC path collision/);
});

test('mutation (g): the path guard rejects backslash traversal and Windows ADS-style names directly', () => {
  for (const unsafe of ['package\\..\\escape.py', 'package\\escape.py', 'file.py:stream', 'C:/loot/escape.py']) {
    assert.throws(() => safeWheelEntryPath(unsafe), /Unsafe wheel entry path/);
  }
});

test('mutation (g): inspectWheel fail-closes on a wheel carrying a backslash-traversal entry', async (t) => {
  const entry = stageSyntheticWheel(t, { files: { 'package\\..\\escape.py': 'escape\n' } });
  // Two-layer rejection: yauzl normalizes backslashes to '/' and its own
  // validateFileName rejects the '..' relative path ("invalid relative path")
  // before the entry handler runs; the raw backslash form is independently
  // rejected by the script's safeWheelEntryPath (covered by the direct test).
  await assert.rejects(() => inspectWheel(entry), /Unsafe wheel entry path|invalid relative path/);
});

test('mutation (g): inspectWheel and extractWheel fail-close on a Windows ADS-style entry name', async (t) => {
  const entry = stageSyntheticWheel(t, { files: { 'mutation_pkg/file.py:stream': 'ads payload\n' } });
  await assert.rejects(() => inspectWheel(entry), /Unsafe wheel entry path/);

  const directory = makeTempDir(t);
  const pythonRoot = path.join(directory, 'python');
  const targetDirectory = path.join(pythonRoot, 'artifact-site-packages');
  fs.mkdirSync(targetDirectory, { recursive: true });
  await assert.rejects(
    () => extractWheel(entry.wheelPath, targetDirectory, pythonRoot, 'darwin', new Set()),
    /Unsafe wheel entry path/
  );
});

test('mutation (h): .data entries outside purelib/platlib/scripts are fail-closed rejected', async (t) => {
  const entry = stageSyntheticWheel(t, {
    files: {
      'mutation_pkg/module.py': 'ok\n',
      'mutation_pkg-1.0.0.data/headers/sneaky.h': '/* not in the signed contract */\n',
    },
  });
  await assert.rejects(() => inspectWheel(entry), /Wheel \.data scheme is unsupported/);
});

test('mutation (h): .data purelib/scripts entries pass inspectWheel and extractWheel spreads them per wheel spec', async (t) => {
  const entry = stageSyntheticWheel(t, {
    files: {
      'mutation_pkg/module.py': 'ok\n',
      'mutation_pkg-1.0.0.data/purelib/mutation_pkg_data/data.txt': 'payload\n',
      'mutation_pkg-1.0.0.data/scripts/mutation-tool': '#!/bin/sh\necho hi\n',
    },
  });
  const inspection = await inspectWheel(entry);
  assert.ok(inspection.filePaths.includes('mutation_pkg-1.0.0.data/purelib/mutation_pkg_data/data.txt'));
  assert.ok(inspection.filePaths.includes('mutation_pkg-1.0.0.data/scripts/mutation-tool'));

  const directory = makeTempDir(t);
  const pythonRoot = path.join(directory, 'python');
  const targetDirectory = path.join(pythonRoot, 'artifact-site-packages');
  fs.mkdirSync(targetDirectory, { recursive: true });
  const spreadFiles = new Set();
  await extractWheel(entry.wheelPath, targetDirectory, pythonRoot, 'darwin', spreadFiles);

  assert.equal(fs.readFileSync(path.join(targetDirectory, 'mutation_pkg', 'module.py'), 'utf8'), 'ok\n');
  assert.equal(fs.readFileSync(path.join(targetDirectory, 'mutation_pkg_data', 'data.txt'), 'utf8'), 'payload\n');
  assert.equal(fs.readFileSync(path.join(pythonRoot, 'bin', 'mutation-tool'), 'utf8'), '#!/bin/sh\necho hi\n');
  assert.deepEqual([...spreadFiles].sort(), [path.join('bin', 'mutation-tool')]);
});

test('assertCombinedWheelLayout rejects cross-wheel file collisions and accepts disjoint wheels', () => {
  const colliding = [
    { filename: 'one-1.0-py3-none-any.whl', wheelInspection: { filePaths: ['shared_pkg/module.py'] } },
    { filename: 'two-2.0-py3-none-any.whl', wheelInspection: { filePaths: ['shared_pkg/module.py'] } },
  ];
  assert.throws(() => assertCombinedWheelLayout(colliding, 'darwin'), /wheels collide at shared_pkg\/module\.py/);

  const disjoint = [
    { filename: 'one-1.0-py3-none-any.whl', wheelInspection: { filePaths: ['alpha/x.py'] } },
    { filename: 'two-2.0-py3-none-any.whl', wheelInspection: { filePaths: ['beta/y.py'] } },
  ];
  assert.doesNotThrow(() => assertCombinedWheelLayout(disjoint, 'darwin'));
});

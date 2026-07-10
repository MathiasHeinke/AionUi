const { execFileSync } = require('node:child_process');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { isDeepStrictEqual } = require('node:util');

const RECEIPT_SCHEMA_VERSION = 1;
const RECEIPT_TYPE = 'command-eve-final-aioncore-artifact';
const PRE_SIGN_SCOPE = 'pre-sign-input';
const FINAL_ARTIFACT_SCOPE = 'post-sign-delivery-artifact';

function normalizeSha256(value) {
  const normalized = typeof value === 'string' ? value.trim().toLowerCase() : '';
  return /^[0-9a-f]{64}$/.test(normalized) ? normalized : null;
}

function sha256File(filePath, deps = {}) {
  const readFile = deps.readFile || fs.readFileSync;
  return crypto.createHash('sha256').update(readFile(filePath)).digest('hex');
}

function normalizeRelativePath(value) {
  return value.split(path.sep).join('/');
}

function deriveMacArchFromAppPath(appPath) {
  const parentName = path.basename(path.dirname(appPath));
  const match = /^mac-(arm64|x64|universal)$/.exec(parentName);
  return match?.[1] || null;
}

function discoverMacAppPaths(outDir) {
  const appPaths = [];
  for (const subdir of ['mac-arm64', 'mac-x64', 'mac-universal', 'mac']) {
    const directory = path.join(outDir, subdir);
    if (!fs.existsSync(directory)) continue;
    for (const entry of fs.readdirSync(directory)) {
      if (entry.endsWith('.app')) appPaths.push(path.join(directory, entry));
    }
  }
  return appPaths;
}

function resolveAioncoreBundle(appPath, archHint = null) {
  const bundleRoot = path.join(appPath, 'Contents', 'Resources', 'bundled-aioncore');
  if (!fs.existsSync(bundleRoot)) {
    throw new Error(`FINAL-AIONCORE-ARTIFACT: bundled AionCore root is missing from ${path.basename(appPath)}`);
  }

  const preferredKey = archHint && archHint !== 'universal' ? `darwin-${archHint}` : null;
  const runtimeKeys =
    preferredKey && fs.existsSync(path.join(bundleRoot, preferredKey))
      ? [preferredKey]
      : fs
          .readdirSync(bundleRoot, { withFileTypes: true })
          .filter((entry) => entry.isDirectory() && entry.name.startsWith('darwin-'))
          .map((entry) => entry.name);
  if (runtimeKeys.length !== 1) {
    throw new Error(
      `FINAL-AIONCORE-ARTIFACT: expected exactly one matching darwin runtime in ${bundleRoot}, found ${runtimeKeys.join(', ') || 'none'}`
    );
  }

  const runtimeKey = runtimeKeys[0];
  const runtimeDir = path.join(bundleRoot, runtimeKey);
  const manifestPath = path.join(runtimeDir, 'manifest.json');
  const binaryPath = path.join(runtimeDir, 'aioncore');
  if (!fs.existsSync(manifestPath) || !fs.existsSync(binaryPath)) {
    throw new Error(`FINAL-AIONCORE-ARTIFACT: ${runtimeKey} is missing aioncore or manifest.json`);
  }
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  return { runtimeKey, runtimeDir, manifestPath, binaryPath, manifest };
}

function verifyCodeSignature(binaryPath, deps = {}) {
  const runner =
    deps.verifyCodeSignature ||
    ((target) => execFileSync('codesign', ['--verify', '--strict', '--verbose=2', target], { stdio: 'pipe' }));
  runner(binaryPath);
}

function inspectFinalAioncoreArtifact(options, deps = {}) {
  const { appPath, outDir, version } = options;
  const archHint = options.archHint || deriveMacArchFromAppPath(appPath);
  const { runtimeKey, binaryPath, manifest } = resolveAioncoreBundle(appPath, archHint);
  const manifestBinarySha256 = normalizeSha256(manifest.binarySha256);
  const preSignBinarySha256 = normalizeSha256(manifest.preSignBinarySha256);
  if (manifest.binarySha256Scope !== PRE_SIGN_SCOPE) {
    throw new Error(
      `FINAL-AIONCORE-ARTIFACT: manifest binarySha256Scope must be ${PRE_SIGN_SCOPE}, got ${String(manifest.binarySha256Scope)}`
    );
  }
  if (!manifestBinarySha256 || !preSignBinarySha256 || manifestBinarySha256 !== preSignBinarySha256) {
    throw new Error('FINAL-AIONCORE-ARTIFACT: manifest pre-sign binary hashes are missing or inconsistent');
  }

  const sourceSha256 = normalizeSha256(manifest.sourceSha256);
  if (manifest.sourceType === 'command-eve-local-build' && sourceSha256 !== preSignBinarySha256) {
    throw new Error('FINAL-AIONCORE-ARTIFACT: local source hash is not bound to the pre-sign binary hash');
  }

  verifyCodeSignature(binaryPath, deps);
  const finalArtifactSha256 = sha256File(binaryPath, deps);
  const productName = options.productName || path.basename(appPath, '.app');
  const arch = manifest.arch || runtimeKey.replace(/^darwin-/, '');
  const receiptCore = {
    schemaVersion: RECEIPT_SCHEMA_VERSION,
    receiptType: RECEIPT_TYPE,
    app: {
      productName,
      version,
      relativePath: normalizeRelativePath(path.relative(outDir, appPath)),
    },
    aioncore: {
      runtimeKey,
      version: manifest.version,
      sourceType: manifest.sourceType,
      sourceCommit: manifest.source?.commit || null,
      sourceSha256,
      archiveSha256: normalizeSha256(manifest.archiveSha256),
      relativePath: normalizeRelativePath(path.relative(appPath, binaryPath)),
      preSignBinarySha256,
      finalArtifactSha256,
      codeSignatureVerified: true,
    },
    integrity: {
      manifestHashScope: PRE_SIGN_SCOPE,
      finalArtifactHashScope: FINAL_ARTIFACT_SCOPE,
      signingChangedBytes: preSignBinarySha256 !== finalArtifactSha256,
    },
  };
  const safeVersion = String(version).replace(/[^0-9A-Za-z._-]/g, '_');
  const receiptPath = path.join(outDir, 'release-receipts', `Command-EVE-${safeVersion}-mac-${arch}-runtime.json`);
  return { receiptCore, receiptPath };
}

function writeFinalAioncoreArtifactReceipt(options, deps = {}) {
  const { receiptCore, receiptPath } = inspectFinalAioncoreArtifact(options, deps);
  const generatedAt = (deps.now || new Date()).toISOString();
  const receipt = { ...receiptCore, generatedAt };
  const receiptDir = path.dirname(receiptPath);
  fs.mkdirSync(receiptDir, { recursive: true });
  const temporaryPath = `${receiptPath}.${process.pid}.tmp`;
  fs.writeFileSync(temporaryPath, `${JSON.stringify(receipt, null, 2)}\n`, { mode: 0o644 });
  fs.renameSync(temporaryPath, receiptPath);
  verifyFinalAioncoreArtifactReceipt(options, deps);
  return receiptPath;
}

function verifyFinalAioncoreArtifactReceipt(options, deps = {}) {
  const { receiptCore, receiptPath } = inspectFinalAioncoreArtifact(options, deps);
  if (!fs.existsSync(receiptPath)) {
    throw new Error(`FINAL-AIONCORE-ARTIFACT: missing external receipt ${receiptPath}`);
  }
  const receipt = JSON.parse(fs.readFileSync(receiptPath, 'utf8'));
  const { generatedAt, ...actualCore } = receipt;
  if (!Number.isFinite(Date.parse(generatedAt)) || !isDeepStrictEqual(actualCore, receiptCore)) {
    throw new Error(
      `FINAL-AIONCORE-ARTIFACT: receipt does not match the signed app bytes for ${path.basename(options.appPath)}`
    );
  }
  return receiptPath;
}

function verifyFinalAioncoreArtifactReceipts(options, deps = {}) {
  const appPaths = discoverMacAppPaths(options.outDir);
  if (appPaths.length === 0) return [];
  return appPaths.map((appPath) =>
    verifyFinalAioncoreArtifactReceipt(
      {
        ...options,
        appPath,
        productName: path.basename(appPath, '.app'),
        archHint: deriveMacArchFromAppPath(appPath),
      },
      deps
    )
  );
}

module.exports = {
  FINAL_ARTIFACT_SCOPE,
  PRE_SIGN_SCOPE,
  RECEIPT_SCHEMA_VERSION,
  RECEIPT_TYPE,
  deriveMacArchFromAppPath,
  discoverMacAppPaths,
  inspectFinalAioncoreArtifact,
  normalizeSha256,
  resolveAioncoreBundle,
  sha256File,
  verifyFinalAioncoreArtifactReceipt,
  verifyFinalAioncoreArtifactReceipts,
  writeFinalAioncoreArtifactReceipt,
};

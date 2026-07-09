/**
 * Prepare aioncore binary for packaging.
 *
 * Resolution order:
 *  1. Pinned GitHub release download (version + SHA256 are mandatory)
 *
 * Output: {projectRoot}/resources/bundled-aioncore/{platform}-{arch}/
 *   - aioncore[.exe]
 *   - manifest.json
 *   - managed-resources/...
 *
 * @module prepare-aioncore
 */

const { execFileSync } = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { verifyBundledAioncoreResources } = require('./verify-bundled-aioncore-resources');

const GITHUB_OWNER = 'iOfficeAI';
const GITHUB_REPO = 'AionCore';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function ensureDirectory(dirPath) {
  if (!fs.existsSync(dirPath)) {
    fs.mkdirSync(dirPath, { recursive: true });
  }
}

function removeDirectorySafe(dirPath) {
  fs.rmSync(dirPath, { recursive: true, force: true });
}

function copyFileSafe(sourcePath, targetPath) {
  ensureDirectory(path.dirname(targetPath));
  fs.copyFileSync(sourcePath, targetPath);
}

function ensureExecutableMode(filePath) {
  if (process.platform === 'win32') return;
  try {
    fs.chmodSync(filePath, 0o755);
  } catch {}
}

function writeJson(filePath, payload) {
  fs.writeFileSync(filePath, JSON.stringify(payload, null, 2) + '\n', 'utf-8');
}

function readJsonSafe(filePath) {
  try {
    if (!fs.existsSync(filePath)) return null;
    return JSON.parse(fs.readFileSync(filePath, 'utf-8'));
  } catch {
    return null;
  }
}

function normalizeSha256(value) {
  const sha = typeof value === 'string' ? value.trim().toLowerCase() : '';
  return /^[0-9a-f]{64}$/.test(sha) ? sha : null;
}

function sha256File(filePath) {
  return crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
}

function resolveExpectedAioncoreSha256(projectRoot, runtimeKey, explicitSha256) {
  const explicit = normalizeSha256(explicitSha256 || process.env.AIONUI_BACKEND_SHA256);
  if (explicit) return explicit;

  const pkg = readJsonSafe(path.join(projectRoot, 'package.json'));
  const pinned = normalizeSha256(pkg?.aioncoreSha256?.[runtimeKey]);
  if (pinned) return pinned;

  throw new Error(
    `Missing pinned AionCore SHA256 for ${runtimeKey}. Add package.json aioncoreSha256.${runtimeKey} ` +
      'or set AIONUI_BACKEND_SHA256 for an explicit version override.'
  );
}

function verifyFileSha256(filePath, expectedSha256) {
  const expected = normalizeSha256(expectedSha256);
  if (!expected) throw new Error('Expected AionCore SHA256 is missing or malformed');
  const actual = sha256File(filePath);
  if (actual !== expected) {
    throw new Error(`AionCore SHA256 mismatch for ${path.basename(filePath)}: expected ${expected}, got ${actual}`);
  }
  return actual;
}

function getBinaryName(platform) {
  return platform === 'win32' ? 'aioncore.exe' : 'aioncore';
}

function prepareManagedResources(binaryPath, targetDir) {
  const bundleOut = path.join(targetDir, 'managed-resources');
  const dataDir = path.join(targetDir, '.prepare-data');

  removeDirectorySafe(bundleOut);
  removeDirectorySafe(dataDir);
  ensureDirectory(bundleOut);
  ensureDirectory(dataDir);

  console.log(`  Preparing managed resources under ${path.relative(process.cwd(), bundleOut)}`);
  execFileSync(binaryPath, ['--data-dir', dataDir, 'prepare-managed-resources', '--bundle-out', bundleOut], {
    stdio: 'inherit',
    env: {
      ...process.env,
      AIONUI_BUNDLED_MANAGED_RESOURCES: '',
    },
  });

  removeDirectorySafe(dataDir);
  return bundleOut;
}

function verifyPreparedBundle(projectRoot, platform, arch) {
  return verifyBundledAioncoreResources({
    resourcesDir: path.join(projectRoot, 'resources'),
    electronPlatformName: platform,
    targetArch: arch,
  });
}

// ---------------------------------------------------------------------------
// Source resolvers
// ---------------------------------------------------------------------------

/**
 * Build the release asset filename for the given platform/arch/tag.
 *
 * Expected asset naming convention:
 *   aioncore-v0.1.0-aarch64-apple-darwin.tar.gz
 */
function getAssetName(platform, arch, tag) {
  const archMap = { x64: 'x86_64', arm64: 'aarch64' };
  const platformMap = {
    darwin: 'apple-darwin',
    linux: 'unknown-linux-gnu',
    win32: 'pc-windows-msvc',
  };
  const normalizedArch = archMap[arch];
  const normalizedPlatform = platformMap[platform];
  if (!normalizedArch || !normalizedPlatform) return null;
  const ext = platform === 'win32' ? '.zip' : '.tar.gz';
  return `aioncore-${tag}-${normalizedArch}-${normalizedPlatform}${ext}`;
}

function getDownloadUrl(assetName, tag) {
  return `https://github.com/${GITHUB_OWNER}/${GITHUB_REPO}/releases/download/${tag}/${assetName}`;
}

function downloadFile(url, outputPath) {
  console.log(`  Downloading aioncore from ${url}`);
  if (process.platform === 'win32') {
    const ps = `$ProgressPreference='SilentlyContinue'; Invoke-WebRequest -Uri '${url}' -OutFile '${outputPath.replace(/'/g, "''")}'`;
    execFileSync('powershell', ['-NoProfile', '-NonInteractive', '-Command', ps], {
      timeout: 120000,
    });
    return;
  }
  try {
    execFileSync('curl', ['-L', '--fail', '--silent', '--show-error', '-o', outputPath, url], { timeout: 120000 });
  } catch {
    execFileSync('wget', ['-q', '-O', outputPath, url], { timeout: 120000 });
  }
}

function extractArchive(archivePath, outputDir, platform) {
  ensureDirectory(outputDir);
  if (platform === 'win32' || archivePath.endsWith('.zip')) {
    if (platform === 'win32') {
      const ps = `Expand-Archive -LiteralPath '${archivePath.replace(/'/g, "''")}' -DestinationPath '${outputDir.replace(/'/g, "''")}' -Force`;
      execFileSync('powershell', ['-NoProfile', '-NonInteractive', '-Command', ps]);
    } else {
      execFileSync('unzip', ['-o', archivePath, '-d', outputDir]);
    }
  } else {
    execFileSync('tar', ['-xzf', archivePath, '-C', outputDir]);
  }
}

function findBinaryInDir(dir, binaryName) {
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isFile() && entry.name === binaryName) return fullPath;
    if (entry.isDirectory()) {
      const found = findBinaryInDir(fullPath, binaryName);
      if (found) return found;
    }
  }
  return null;
}

function downloadAndExtract(platform, arch, tag, expectedSha256) {
  const assetName = getAssetName(platform, arch, tag);
  if (!assetName) {
    throw new Error(`Unsupported aioncore target: ${platform}-${arch}`);
  }

  const url = getDownloadUrl(assetName, tag);
  const tempDir = path.join(os.tmpdir(), 'aioncore-prepare', tag, `${platform}-${arch}`);
  const archivePath = path.join(tempDir, assetName);
  const extractDir = path.join(tempDir, 'extracted');

  removeDirectorySafe(tempDir);
  ensureDirectory(tempDir);

  downloadFile(url, archivePath);
  const archiveSha256 = verifyFileSha256(archivePath, expectedSha256);
  extractArchive(archivePath, extractDir, platform);

  const binaryName = getBinaryName(platform);
  const binaryPath = findBinaryInDir(extractDir, binaryName);
  if (!binaryPath) {
    throw new Error(`Binary ${binaryName} not found in downloaded archive`);
  }

  return { binaryPath, tempDir, url, archiveSha256 };
}

// ---------------------------------------------------------------------------
// Main export
// ---------------------------------------------------------------------------

/**
 * Prepare aioncore binary for packaging.
 *
 * @param {object} options - Configuration options
 * @param {string} options.projectRoot - Project root directory
 * @param {string} options.platform - Target platform (process.platform)
 * @param {string} options.arch - Target architecture (process.arch)
 * @param {string} options.version - Pinned backend version
 * @returns {{ prepared: true; dir: string; sourceType: string }}
 */
function prepareAioncore(options) {
  const { projectRoot, platform, arch, version, expectedSha256: explicitSha256 } = options;
  const runtimeKey = `${platform}-${arch}`;
  const expectedSha256 = resolveExpectedAioncoreSha256(projectRoot, runtimeKey, explicitSha256);

  if (typeof version !== 'string' || !version.trim() || version.trim() === 'latest') {
    throw new Error('AionCore version must be pinned; mutable "latest" builds are disabled');
  }
  const normalizedVersion = version.trim();
  const tag = normalizedVersion.startsWith('v') ? normalizedVersion : `v${normalizedVersion}`;

  const targetDir = path.join(projectRoot, 'resources', 'bundled-aioncore', runtimeKey);
  const binaryName = getBinaryName(platform);
  const targetBinaryPath = path.join(targetDir, binaryName);
  const targetManifestPath = path.join(targetDir, 'manifest.json');

  console.log(`Preparing aioncore for ${runtimeKey} (version: ${tag})`);

  const existingManifest = readJsonSafe(targetManifestPath);
  const existingBinarySha256 = fs.existsSync(targetBinaryPath) ? sha256File(targetBinaryPath) : null;
  if (
    existingBinarySha256 &&
    existingManifest?.version === tag &&
    normalizeSha256(existingManifest?.archiveSha256) === expectedSha256 &&
    normalizeSha256(existingManifest?.binarySha256) === existingBinarySha256
  ) {
    ensureExecutableMode(targetBinaryPath);
    const verification = verifyPreparedBundle(projectRoot, platform, arch);
    if (verification.missing.length === 0) {
      console.log(`  Reusing bundled aioncore: resources/bundled-aioncore/${runtimeKey}/${binaryName}`);
      return { prepared: true, dir: targetDir, sourceType: existingManifest.sourceType || 'existing' };
    }

    console.warn(
      `  Existing bundled aioncore is incomplete; regenerating managed resources: ${verification.missing.join(', ')}`
    );
    const bundledManagedResourcesDir = prepareManagedResources(targetBinaryPath, targetDir);
    const manifest = {
      ...existingManifest,
      platform,
      arch,
      version: tag,
      generatedAt: new Date().toISOString(),
      sourceType: existingManifest.sourceType || 'existing',
      files: Array.from(new Set([binaryName, 'managed-resources/'])),
    };
    writeJson(targetManifestPath, manifest);
    console.log(`  Repaired bundled managed resources: ${bundledManagedResourcesDir}`);
    return { prepared: true, dir: targetDir, sourceType: existingManifest.sourceType || 'existing' };
  }

  removeDirectorySafe(targetDir);
  ensureDirectory(targetDir);

  let sourcePath = null;
  let sourceType = 'none';
  let sourceDetail = {};
  let tempDir = null;

  // 1. Download from GitHub releases
  if (!sourcePath) {
    try {
      const result = downloadAndExtract(platform, arch, tag, expectedSha256);
      sourcePath = result.binaryPath;
      tempDir = result.tempDir;
      sourceType = 'download';
      sourceDetail = { url: result.url };
      console.log(`  Downloaded from GitHub releases`);
    } catch (error) {
      console.warn(`  Download failed: ${error.message}`);
    }
  }

  // Write result
  if (sourcePath) {
    copyFileSafe(sourcePath, targetBinaryPath);
    ensureExecutableMode(targetBinaryPath);
    const binarySha256 = sha256File(targetBinaryPath);
    const bundledManagedResourcesDir = prepareManagedResources(targetBinaryPath, targetDir);

    // The release tag is the authoritative version — the aioncore
    // binary does not expose a --version flag (it has --app-version which
    // takes a value, not a self-report).
    const manifest = {
      platform,
      arch,
      version: tag,
      generatedAt: new Date().toISOString(),
      sourceType,
      source: sourceDetail,
      archiveSha256: expectedSha256,
      binarySha256,
      files: [binaryName, 'managed-resources/'],
    };

    writeJson(targetManifestPath, manifest);
    console.log(
      `  Bundled aioncore prepared: resources/bundled-aioncore/${runtimeKey}/${binaryName} [source=${sourceType}]`
    );
    console.log(`  Bundled managed resources prepared: ${bundledManagedResourcesDir}`);

    if (tempDir) removeDirectorySafe(tempDir);
    return { prepared: true, dir: targetDir, sourceType };
  }

  throw new Error(`aioncore binary not found for ${runtimeKey} (tag: ${tag})`);
}

module.exports = {
  normalizeSha256,
  prepareAioncore,
  resolveExpectedAioncoreSha256,
  sha256File,
  verifyFileSha256,
};

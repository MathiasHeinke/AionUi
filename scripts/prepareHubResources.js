/**
 * prepareHubResources.js
 *
 * Downloads the AionHub index.json and all extension zip packages
 * into resources/hub/ so they are bundled with the app as local fallback.
 *
 * Called during the build pipeline before electron-builder runs.
 *
 * Environment variables:
 *   AIONUI_HUB_TAG    - Explicit commit/tag override (default: pinned immutable commit)
 *   AIONUI_HUB_SHA256_MANIFEST - JSON file with filename -> SHA256 pins for an override
 *   AIONUI_HUB_SKIP   - Set to '1' to skip hub resource preparation
 */

const fs = require('fs');
const path = require('path');
const https = require('https');
const crypto = require('crypto');

const PROJECT_ROOT = path.resolve(__dirname, '..');
const HUB_DIR = path.join(PROJECT_ROOT, 'resources', 'hub');

const DEFAULT_TAG = 'f9570c40796cc23365970a645c0841b8d2cc7c15';
const ALLOWED_DOWNLOAD_HOSTS = new Set(['raw.githubusercontent.com', 'cdn.jsdelivr.net']);
const DEFAULT_SHA256_BY_FILE = Object.freeze({
  'index.json': '70b77aade1f3df761f5375367498f1c7cc630741597e21c8e6f247a477142a16',
  'aionext-auggie.zip': '61c6c8e831f87b0f157ed5e8fa6354d067dea8deccc6db6538355a96c55037c3',
  'aionext-claude.zip': '171d9cff7561d52de52300f904f592d0f13e432e7ff181de09e111622686a73f',
  'aionext-codebuddy.zip': 'a5e1d51a76d75cdb1c60ea476dc09e0bf78605d8f19fb416c180e4f81659b85d',
  'aionext-codex.zip': 'bc922eb3604246e41754199acae7c8d5ac4b1445d2cc4c42a167b17e872b4bf6',
  'aionext-goose.zip': 'bee13963d1484ea157eff5938d22fed9b6076a1926e2e2d469a49cda5121c413',
  'aionext-opencode.zip': 'cb8654acd7479056aafe215ecdb1714b18066b713734053a132f4c6a1be8d867',
  'aionext-qwen.zip': 'e688c713d06fcc17e1a2747217e20a98997810350081488b64ac02ea1c2b63e4',
});
const BASE_URLS = [
  `https://raw.githubusercontent.com/iOfficeAI/AionHub/${process.env.AIONUI_HUB_TAG || DEFAULT_TAG}/`,
  `https://cdn.jsdelivr.net/gh/iOfficeAI/AionHub@${process.env.AIONUI_HUB_TAG || DEFAULT_TAG}/`,
];

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function ensureDir(dir) {
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

function normalizeSha256(value) {
  const sha = typeof value === 'string' ? value.trim().toLowerCase() : '';
  return /^[0-9a-f]{64}$/.test(sha) ? sha : null;
}

function assertTrustedDownloadUrl(urlText) {
  const url = new URL(urlText);
  if (url.protocol !== 'https:' || !ALLOWED_DOWNLOAD_HOSTS.has(url.hostname)) {
    throw new Error(`Untrusted AionHub download URL: ${url.toString()}`);
  }
  return url;
}

function resolveHubDownloadUrl(baseUrl, relativePath) {
  if (
    typeof relativePath !== 'string' ||
    !relativePath ||
    /^[a-z][a-z\d+.-]*:/i.test(relativePath) ||
    relativePath.startsWith('/') ||
    relativePath.startsWith('\\') ||
    relativePath.split(/[\\/]/).includes('..')
  ) {
    throw new Error(`Invalid AionHub relative asset path: ${String(relativePath)}`);
  }
  return assertTrustedDownloadUrl(new URL(relativePath, baseUrl).toString()).toString();
}

function verifyFileSha256(filePath, expectedSha256) {
  const expected = normalizeSha256(expectedSha256);
  if (!expected) throw new Error(`Missing or malformed pinned SHA256 for ${path.basename(filePath)}`);
  const actual = crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
  if (actual !== expected) {
    throw new Error(`SHA256 mismatch for ${path.basename(filePath)}: expected ${expected}, got ${actual}`);
  }
  return actual;
}

function loadPinnedSha256ByFile(tag) {
  if (tag === DEFAULT_TAG) return DEFAULT_SHA256_BY_FILE;
  const manifestPath = process.env.AIONUI_HUB_SHA256_MANIFEST;
  if (!manifestPath) {
    throw new Error(
      `AIONUI_HUB_TAG=${tag} has no pinned SHA256 manifest. Update DEFAULT_TAG/DEFAULT_SHA256_BY_FILE ` +
        'or provide AIONUI_HUB_SHA256_MANIFEST.'
    );
  }
  const parsed = JSON.parse(fs.readFileSync(path.resolve(manifestPath), 'utf8'));
  for (const [file, sha] of Object.entries(parsed)) {
    if (!normalizeSha256(sha)) throw new Error(`Invalid SHA256 pin for ${file} in ${manifestPath}`);
  }
  return parsed;
}

/**
 * Download a URL to a local file path. Tries each base URL in order.
 * Returns the base URL that succeeded.
 */
async function downloadFile(relativePath, destPath) {
  for (const base of BASE_URLS) {
    const url = resolveHubDownloadUrl(base, relativePath);
    try {
      await downloadUrl(url, destPath);
      return url;
    } catch (error) {
      console.warn(`  [hub] Failed from ${url}: ${error.message}`);
    }
  }
  throw new Error(`Failed to download ${relativePath} from all mirrors`);
}

function downloadUrl(url, destPath) {
  return new Promise((resolve, reject) => {
    const follow = (url, redirectCount = 0) => {
      if (redirectCount > 5) {
        reject(new Error('Too many redirects'));
        return;
      }

      const trustedUrl = assertTrustedDownloadUrl(url);
      const request = https.get(trustedUrl, (res) => {
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          res.resume();
          follow(new URL(res.headers.location, trustedUrl).toString(), redirectCount + 1);
          return;
        }

        if (res.statusCode !== 200) {
          res.resume();
          reject(new Error(`HTTP ${res.statusCode}`));
          return;
        }

        const file = fs.createWriteStream(destPath);
        res.pipe(file);
        file.on('finish', () => {
          file.close();
          resolve();
        });
        file.on('error', (err) => {
          fs.rmSync(destPath, { force: true });
          reject(err);
        });
      });
      request.setTimeout(30_000, () => request.destroy(new Error('AionHub download timed out')));
      request.on('error', (error) => {
        fs.rmSync(destPath, { force: true });
        reject(error);
      });
    };

    follow(url);
  });
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function prepareHubResources() {
  if (process.env.AIONUI_HUB_SKIP === '1') {
    console.log('[hub] Skipping hub resource preparation (AIONUI_HUB_SKIP=1)');
    return { skipped: true };
  }

  const tag = process.env.AIONUI_HUB_TAG || DEFAULT_TAG;
  const sha256ByFile = loadPinnedSha256ByFile(tag);
  console.log(`[hub] Preparing hub resources from tag: ${tag}`);

  // Clean and create target directory
  if (fs.existsSync(HUB_DIR)) {
    fs.rmSync(HUB_DIR, { recursive: true, force: true });
  }
  ensureDir(HUB_DIR);

  // Step 1: Download index.json
  const indexPath = path.join(HUB_DIR, 'index.json');
  console.log('[hub] Downloading index.json...');
  const indexUrl = await downloadFile('index.json', indexPath);
  verifyFileSha256(indexPath, sha256ByFile['index.json']);
  console.log(`[hub] index.json downloaded from ${indexUrl}`);

  // Step 2: Parse index and download all extension zips
  const index = JSON.parse(fs.readFileSync(indexPath, 'utf-8'));
  const extensions = index.extensions || {};
  const names = Object.keys(extensions);

  console.log(`[hub] Found ${names.length} extensions to bundle`);

  const results = [];
  for (const name of names) {
    const ext = extensions[name];
    const tarball = ext.dist?.tarball;
    if (!tarball) throw new Error(`[hub] ${name}: no dist.tarball`);

    const fileName = path.basename(tarball);
    const expectedSha256 = sha256ByFile[fileName];
    if (!normalizeSha256(expectedSha256)) throw new Error(`[hub] ${name}: no pinned SHA256 for ${fileName}`);
    const zipPath = path.join(HUB_DIR, fileName);
    try {
      const url = await downloadFile(tarball, zipPath);
      const sha256 = verifyFileSha256(zipPath, expectedSha256);
      const size = fs.statSync(zipPath).size;
      console.log(`[hub] ${name} -> ${path.basename(tarball)} (${(size / 1024).toFixed(1)} KB)`);
      results.push({ name, file: fileName, size, url, sha256, upstreamIntegrity: ext.dist?.integrity || null });
    } catch (error) {
      fs.rmSync(zipPath, { force: true });
      throw new Error(`[hub] Failed to prepare ${name}: ${error.message}`);
    }
  }

  // Step 3: Write manifest for debugging/verification
  const manifest = {
    tag,
    generatedAt: new Date().toISOString(),
    indexUrl,
    extensions: results,
  };
  fs.writeFileSync(path.join(HUB_DIR, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');

  console.log(`[hub] Done: ${results.length}/${names.length} extensions bundled in resources/hub/`);
  return { skipped: false, count: results.length, total: names.length };
}

// Support both direct execution and require() from build-with-builder.js
if (require.main === module) {
  prepareHubResources().catch((err) => {
    console.error('[hub] Fatal error:', err);
    process.exit(1);
  });
}

module.exports = {
  DEFAULT_TAG,
  DEFAULT_SHA256_BY_FILE,
  loadPinnedSha256ByFile,
  normalizeSha256,
  prepareHubResources,
  resolveHubDownloadUrl,
  verifyFileSha256,
};

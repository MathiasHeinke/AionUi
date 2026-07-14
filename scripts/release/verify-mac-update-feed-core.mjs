import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

export const MAC_UPDATE_FEED_VERIFIER_VERSION = 'mac-update-feed-verifier/v0';

export const MAC_UPDATE_FEED_STATUS_EXIT_CODES = {
  PASS: 0,
  BLOCKED_ARTIFACT_MISSING: 2,
  BLOCKED_METADATA_MISSING: 3,
  BLOCKED_METADATA_MALFORMED: 4,
  BLOCKED_HASH_MISMATCH: 5,
  BLOCKED_STALE_METADATA: 6,
};

function stripYamlScalar(value) {
  return String(value || '')
    .trim()
    .replace(/^['"]|['"]$/g, '');
}

export function sha512Base64(filePath, deps = {}) {
  const readFile = deps.readFile || fs.readFileSync;
  return crypto.createHash('sha512').update(readFile(filePath)).digest('base64');
}

export function parseMacReleaseArtifact(filePath) {
  const fileName = path.basename(String(filePath || ''));
  const match = fileName.match(/^Command-EVE-(.+)-mac-(arm64|x64|universal)\.(dmg|zip)$/);
  if (!match) return null;
  return {
    fileName,
    version: match[1],
    arch: match[2],
    ext: match[3],
  };
}

export function metadataFileNameForMacArch(arch) {
  if (arch === 'x64' || arch === 'universal') return 'latest-mac.yml';
  return `latest-${arch}-mac.yml`;
}

export function parseMacUpdateYml(text) {
  const result = {
    version: '',
    path: '',
    sha512: '',
    files: [],
  };
  let currentFile = null;
  for (const rawLine of String(text || '').split(/\r?\n/)) {
    const line = rawLine.trimEnd();
    const versionMatch = line.match(/^version:\s*(.+)$/);
    if (versionMatch) {
      result.version = stripYamlScalar(versionMatch[1]);
      continue;
    }
    const pathMatch = line.match(/^path:\s*(.+)$/);
    if (pathMatch) {
      result.path = stripYamlScalar(pathMatch[1]);
      continue;
    }
    const rootShaMatch = line.match(/^sha512:\s*(.+)$/);
    if (rootShaMatch) {
      result.sha512 = stripYamlScalar(rootShaMatch[1]);
      continue;
    }
    const urlMatch = line.match(/^\s*-\s*url:\s*(.+)$/);
    if (urlMatch) {
      currentFile = { url: stripYamlScalar(urlMatch[1]), sha512: '', size: undefined };
      result.files.push(currentFile);
      continue;
    }
    const fileShaMatch = line.match(/^\s+sha512:\s*(.+)$/);
    if (fileShaMatch && currentFile) {
      currentFile.sha512 = stripYamlScalar(fileShaMatch[1]);
      continue;
    }
    const sizeMatch = line.match(/^\s+size:\s*(\d+)$/);
    if (sizeMatch && currentFile) {
      currentFile.size = Number(sizeMatch[1]);
    }
  }
  return result;
}

function makeResult(status, detail, extra = {}) {
  return {
    version: MAC_UPDATE_FEED_VERIFIER_VERSION,
    status,
    exit_code: MAC_UPDATE_FEED_STATUS_EXIT_CODES[status] ?? 1,
    detail,
    ...extra,
  };
}

function hasCurrentArchArtifacts(outDir, version, arch, deps = {}) {
  const exists = deps.exists || fs.existsSync;
  return ['dmg', 'zip'].some((ext) => exists(path.join(outDir, `Command-EVE-${version}-mac-${arch}.${ext}`)));
}

function currentSiblingArchExists(outDir, version, arch, deps = {}) {
  const siblingArches = arch === 'arm64' ? ['x64', 'universal'] : ['arm64'];
  return siblingArches.some((sibling) => hasCurrentArchArtifacts(outDir, version, sibling, deps));
}

export function evaluateMacUpdateFeed(options = {}, deps = {}) {
  const exists = deps.exists || fs.existsSync;
  const readFileText = deps.readFileText || ((filePath) => fs.readFileSync(filePath, 'utf8'));
  const stat = deps.stat || fs.statSync;
  const dmgPath = options.dmgPath || '';
  if (!dmgPath || !exists(dmgPath)) {
    return makeResult('BLOCKED_ARTIFACT_MISSING', `DMG artifact not found: ${dmgPath || '<missing>'}`);
  }

  const parsedDmg = parseMacReleaseArtifact(dmgPath);
  if (!parsedDmg || parsedDmg.ext !== 'dmg') {
    return makeResult(
      'BLOCKED_ARTIFACT_MISSING',
      `DMG name does not match Command EVE mac artifact format: ${dmgPath}`
    );
  }

  const outDir = options.outDir || path.dirname(dmgPath);
  const version = options.version || parsedDmg.version;
  const arch = options.arch || parsedDmg.arch;
  const zipName = `Command-EVE-${version}-mac-${arch}.zip`;
  const dmgName = `Command-EVE-${version}-mac-${arch}.dmg`;
  const zipPath = path.join(outDir, zipName);
  const expectedMetadataName = metadataFileNameForMacArch(arch);
  const metadataPath = options.metadataPath || path.join(outDir, expectedMetadataName);

  if (!exists(zipPath)) {
    return makeResult('BLOCKED_ARTIFACT_MISSING', `ZIP artifact not found for update feed: ${zipPath}`);
  }

  const staleSiblingMetadataName =
    expectedMetadataName === 'latest-mac.yml' ? 'latest-arm64-mac.yml' : 'latest-mac.yml';
  const staleSiblingMetadataPath = path.join(outDir, staleSiblingMetadataName);
  if (
    !options.allowSiblingMetadata &&
    exists(staleSiblingMetadataPath) &&
    !currentSiblingArchExists(outDir, version, arch, deps)
  ) {
    return makeResult(
      'BLOCKED_STALE_METADATA',
      `Stale ${staleSiblingMetadataName} exists without current sibling artifacts for ${version}`
    );
  }

  if (!exists(metadataPath)) {
    return makeResult('BLOCKED_METADATA_MISSING', `Mac update metadata not found: ${metadataPath}`);
  }

  const parsedYml = parseMacUpdateYml(readFileText(metadataPath));
  if (!parsedYml.version || !parsedYml.path || !parsedYml.sha512 || parsedYml.files.length < 2) {
    return makeResult('BLOCKED_METADATA_MALFORMED', `Mac update metadata is incomplete: ${metadataPath}`);
  }
  if (parsedYml.version !== version) {
    return makeResult(
      'BLOCKED_STALE_METADATA',
      `Metadata version ${parsedYml.version} does not match artifact version ${version}`
    );
  }
  if (parsedYml.path !== zipName) {
    return makeResult('BLOCKED_STALE_METADATA', `Metadata path ${parsedYml.path} does not match ${zipName}`);
  }

  const expected = new Map([
    [zipName, { sha512: sha512Base64(zipPath, deps), size: stat(zipPath).size }],
    [dmgName, { sha512: sha512Base64(dmgPath, deps), size: stat(dmgPath).size }],
  ]);
  if (parsedYml.sha512 !== expected.get(zipName).sha512) {
    return makeResult('BLOCKED_HASH_MISMATCH', `Top-level sha512 does not match final ZIP bytes for ${zipName}`);
  }

  for (const [url, artifact] of expected.entries()) {
    const entry = parsedYml.files.find((file) => file.url === url);
    if (!entry) {
      return makeResult('BLOCKED_METADATA_MALFORMED', `Metadata missing files[] entry for ${url}`);
    }
    if (entry.sha512 !== artifact.sha512) {
      return makeResult('BLOCKED_HASH_MISMATCH', `Metadata sha512 for ${url} does not match final artifact bytes`);
    }
    if (typeof entry.size === 'number' && entry.size !== artifact.size) {
      return makeResult('BLOCKED_HASH_MISMATCH', `Metadata size for ${url} does not match final artifact size`);
    }
  }

  return makeResult('PASS', `Mac update feed ${path.basename(metadataPath)} matches final ${arch} DMG and ZIP`, {
    metadata_path: metadataPath,
    dmg_path: dmgPath,
    zip_path: zipPath,
    arch,
    release_version: version,
  });
}

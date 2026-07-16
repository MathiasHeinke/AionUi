import childProcess from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import { availableBytesForPath, isSafeArchiveEntry, isSafeSymlinkTarget, sha256File } from './bonsaiArtifactCore';
import {
  COLIBRI_MODEL_SNAPSHOT,
  COLIBRI_MTP_PINS,
  COLIBRI_SOURCE,
  COMMAND_EVE_COLIBRI_VERSION,
  resolveColibriPaths,
  type ColibriPaths,
} from './colibriManifest';

const DISK_HEADROOM_BYTES = 16 * 1024 ** 3;
const MAX_TAR_LIST_BYTES = 8 * 1024 * 1024;
const BUILD_TIMEOUT_MS = 45 * 60_000;
const DOCTOR_TIMEOUT_MS = 10 * 60_000;

export type ColibriTreeFile = Readonly<{
  path: string;
  sizeBytes: number;
  hashKind: 'sha256' | 'git-sha1';
  hash: string;
}>;

export type ColibriProvisionProgressReceipt = Readonly<{
  version: 'command-eve-colibri-provision-progress/v0';
  model_revision: typeof COLIBRI_MODEL_SNAPSHOT.revision;
  tree_sha256: typeof COLIBRI_MODEL_SNAPSHOT.treeSha256;
  status: 'pulling' | 'building' | 'done' | 'failed';
  stage: 'verify' | 'download' | 'extract' | 'build' | 'doctor' | 'ready';
  total: number;
  completed: number;
  percent: number;
  updated_at: string;
  current_file?: string;
  error?: string;
}>;

export type ColibriInstallStatus = Readonly<{
  installed: boolean;
  installedSizeBytes?: number;
  resumeAvailable?: boolean;
  progress?: ColibriProvisionProgressReceipt;
}>;

export type ColibriProvisionReceipt = Readonly<{
  version: typeof COMMAND_EVE_COLIBRI_VERSION;
  status: 'ready';
  observed_at: string;
  model: {
    repository: string;
    revision: string;
    file_count: number;
    size_bytes: number;
    tree_sha256: string;
  };
  runtime: {
    repository: string;
    source_commit: string;
    archive_sha256: string;
    engine_sha256: string;
  };
  doctor: { status: 'pass' };
}>;

export type ColibriProvisionOptions = Readonly<{
  userDataPath: string;
  autoDownload?: boolean;
  allowHomebrewInstall?: boolean;
  fetchImpl?: typeof fetch;
  platform?: NodeJS.Platform;
  arch?: string;
  onProgress?: (progress: ColibriProvisionProgressReceipt) => void;
}>;

type HfTreeItem = {
  type?: string;
  path?: string;
  size?: number;
  oid?: string;
  lfs?: { oid?: string; size?: number };
};

const provisions = new Map<string, Promise<{ paths: ColibriPaths; receipt: ColibriProvisionReceipt }>>();

function appendBoundedCommandOutput(current: string, chunk: Buffer): string {
  return `${current}${chunk.toString('utf8')}`.slice(-16 * 1024 * 1024);
}

function ensurePrivateDir(directory: string): void {
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  fs.chmodSync(directory, 0o700);
}

function writePrivateJson(filePath: string, value: unknown): void {
  ensurePrivateDir(path.dirname(filePath));
  const temporaryPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(temporaryPath, `${JSON.stringify(value, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
  fs.chmodSync(temporaryPath, 0o600);
  fs.renameSync(temporaryPath, filePath);
}

function readJsonRecord(filePath: string): Record<string, unknown> | undefined {
  try {
    const value = JSON.parse(fs.readFileSync(filePath, 'utf8')) as unknown;
    return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
  } catch {
    return undefined;
  }
}

function parseProgress(value: Record<string, unknown> | undefined): ColibriProvisionProgressReceipt | undefined {
  if (
    value?.version !== 'command-eve-colibri-provision-progress/v0' ||
    value.model_revision !== COLIBRI_MODEL_SNAPSHOT.revision ||
    value.tree_sha256 !== COLIBRI_MODEL_SNAPSHOT.treeSha256 ||
    !['pulling', 'building', 'done', 'failed'].includes(String(value.status || '')) ||
    !['verify', 'download', 'extract', 'build', 'doctor', 'ready'].includes(String(value.stage || '')) ||
    typeof value.total !== 'number' ||
    typeof value.completed !== 'number' ||
    typeof value.percent !== 'number' ||
    value.percent < 0 ||
    value.percent > 100 ||
    typeof value.updated_at !== 'string' ||
    !Number.isFinite(Date.parse(value.updated_at))
  ) {
    return undefined;
  }
  return value as ColibriProvisionProgressReceipt;
}

export function readColibriInstallStatus(userDataPath: string): ColibriInstallStatus {
  const paths = resolveColibriPaths(userDataPath);
  const receipt = readJsonRecord(paths.receiptPath);
  const progress = parseProgress(readJsonRecord(paths.provisionProgressPath));
  const model = receipt?.model as Record<string, unknown> | undefined;
  const runtime = receipt?.runtime as Record<string, unknown> | undefined;
  const mtpReady = COLIBRI_MTP_PINS.every((pin) => {
    try {
      return fs.statSync(path.join(paths.modelDir, pin.path)).size === pin.sizeBytes;
    } catch {
      return false;
    }
  });
  const installed =
    receipt?.version === COMMAND_EVE_COLIBRI_VERSION &&
    receipt.status === 'ready' &&
    model?.revision === COLIBRI_MODEL_SNAPSHOT.revision &&
    model?.tree_sha256 === COLIBRI_MODEL_SNAPSHOT.treeSha256 &&
    model?.size_bytes === COLIBRI_MODEL_SNAPSHOT.totalSizeBytes &&
    runtime?.source_commit === COLIBRI_SOURCE.commit &&
    typeof runtime.engine_sha256 === 'string' &&
    /^[a-f0-9]{64}$/.test(runtime.engine_sha256) &&
    fs.existsSync(paths.cliPath) &&
    fs.existsSync(paths.enginePath) &&
    mtpReady;
  return {
    installed,
    ...(installed ? { installedSizeBytes: COLIBRI_MODEL_SNAPSHOT.totalSizeBytes } : {}),
    ...(!installed && progress && progress.completed > 0 ? { resumeAvailable: true } : {}),
    ...(progress ? { progress } : {}),
  };
}

export function isSafeColibriSnapshotPath(candidate: string): boolean {
  if (!candidate || candidate.startsWith('/') || candidate.includes('\\') || candidate.includes('\0')) return false;
  const segments = candidate.split('/');
  return segments.every((segment) => segment.length > 0 && segment !== '.' && segment !== '..');
}

export function canonicalizeColibriTree(files: ReadonlyArray<ColibriTreeFile>): string {
  return files
    .toSorted((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
    .map((file) => `${file.path}\0${file.sizeBytes}\0${file.hashKind}\0${file.hash}\n`)
    .join('');
}

export function validateColibriTree(items: ReadonlyArray<HfTreeItem>): ColibriTreeFile[] {
  const files = items
    .filter((item) => item.type === 'file')
    .map((item): ColibriTreeFile => {
      const itemPath = String(item.path || '');
      const sizeBytes = Number(item.lfs?.size ?? item.size);
      const lfsHash = String(item.lfs?.oid || '')
        .replace(/^sha256:/, '')
        .toLowerCase();
      const gitHash = String(item.oid || '').toLowerCase();
      const hashKind = lfsHash ? 'sha256' : 'git-sha1';
      const hash = lfsHash || gitHash;
      if (
        !isSafeColibriSnapshotPath(itemPath) ||
        !Number.isSafeInteger(sizeBytes) ||
        sizeBytes < 0 ||
        !new RegExp(hashKind === 'sha256' ? '^[a-f0-9]{64}$' : '^[a-f0-9]{40}$').test(hash)
      ) {
        throw new Error(`Colibrì model tree contains an invalid file entry: ${itemPath || '[missing]'}.`);
      }
      return { path: itemPath, sizeBytes, hashKind, hash };
    });
  if (new Set(files.map((file) => file.path)).size !== files.length) {
    throw new Error('Colibrì model tree contains duplicate file paths.');
  }
  const total = files.reduce((sum, file) => sum + file.sizeBytes, 0);
  const treeSha256 = crypto.createHash('sha256').update(canonicalizeColibriTree(files)).digest('hex');
  if (
    files.length !== COLIBRI_MODEL_SNAPSHOT.fileCount ||
    total !== COLIBRI_MODEL_SNAPSHOT.totalSizeBytes ||
    treeSha256 !== COLIBRI_MODEL_SNAPSHOT.treeSha256
  ) {
    throw new Error('Colibrì model tree does not match the pinned snapshot manifest.');
  }
  for (const pin of COLIBRI_MTP_PINS) {
    const file = files.find((candidate) => candidate.path === pin.path);
    if (!file || file.sizeBytes !== pin.sizeBytes || file.hashKind !== 'sha256' || file.hash !== pin.sha256) {
      throw new Error(`Colibrì MTP integrity pin failed for ${pin.path}.`);
    }
  }
  return files;
}

function nextTreePage(response: Response): string | undefined {
  const link = response.headers.get('link') || '';
  for (const part of link.split(',')) {
    const match = /<([^>]+)>;\s*rel="next"/i.exec(part.trim());
    if (!match) continue;
    const next = new URL(match[1]);
    const expectedPrefix = `/api/models/${COLIBRI_MODEL_SNAPSHOT.repository}/tree/${COLIBRI_MODEL_SNAPSHOT.revision}`;
    if (next.protocol !== 'https:' || next.hostname !== 'huggingface.co' || next.pathname !== expectedPrefix) {
      throw new Error('Colibrì model tree pagination left the pinned Hugging Face endpoint.');
    }
    return next.toString();
  }
  return undefined;
}

export async function fetchPinnedColibriTree(fetchImpl: typeof fetch = fetch): Promise<ColibriTreeFile[]> {
  let url = `https://huggingface.co/api/models/${COLIBRI_MODEL_SNAPSHOT.repository}/tree/${COLIBRI_MODEL_SNAPSHOT.revision}?recursive=true&expand=true&limit=100`;
  const items: HfTreeItem[] = [];
  const seen = new Set<string>();
  while (url) {
    if (seen.has(url)) throw new Error('Colibrì model tree pagination loop detected.');
    seen.add(url);
    // Each page is bound by the prior page's signed endpoint; pagination is sequential by contract.
    // eslint-disable-next-line no-await-in-loop
    const response = await fetchImpl(url, { redirect: 'error' });
    if (!response.ok) throw new Error(`Colibrì model tree request failed (${response.status}).`);
    // eslint-disable-next-line no-await-in-loop
    const page = (await response.json()) as unknown;
    if (!Array.isArray(page)) throw new Error('Colibrì model tree response is not an array.');
    items.push(...(page as HfTreeItem[]));
    url = nextTreePage(response) || '';
  }
  return validateColibriTree(items);
}

async function hashFile(filePath: string, algorithm: 'sha256' | 'sha1', gitBlobSize?: number): Promise<string> {
  const hash = crypto.createHash(algorithm);
  if (gitBlobSize !== undefined) hash.update(`blob ${gitBlobSize}\0`);
  await new Promise<void>((resolve, reject) => {
    const stream = fs.createReadStream(filePath);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('error', reject);
    stream.on('end', resolve);
  });
  return hash.digest('hex');
}

async function verifyTreeFile(filePath: string, file: ColibriTreeFile): Promise<boolean> {
  try {
    if (fs.statSync(filePath).size !== file.sizeBytes) return false;
    const actual =
      file.hashKind === 'sha256'
        ? await hashFile(filePath, 'sha256')
        : await hashFile(filePath, 'sha1', file.sizeBytes);
    return actual === file.hash;
  } catch {
    return false;
  }
}

export function estimateReusableColibriBytes(modelDir: string, files: ReadonlyArray<ColibriTreeFile>): number {
  return files.reduce((total, file) => {
    const destinationPath = path.join(modelDir, file.path);
    let reusable = 0;
    try {
      reusable += Math.min(file.sizeBytes, Math.max(0, fs.statSync(destinationPath).size));
    } catch {
      // Missing final file contributes no reclaimable bytes.
    }
    const partPath = `${destinationPath}.part`;
    try {
      const meta = JSON.parse(fs.readFileSync(`${partPath}.json`, 'utf8')) as { hash?: string; size?: number };
      const partialSize = fs.statSync(partPath).size;
      if (meta.hash === file.hash && meta.size === file.sizeBytes && partialSize > 0 && partialSize < file.sizeBytes) {
        reusable += partialSize;
      }
    } catch {
      // Invalid partial metadata cannot reduce the disk admission requirement.
    }
    return total + reusable;
  }, 0);
}

function encodeSnapshotPath(filePath: string): string {
  return filePath.split('/').map(encodeURIComponent).join('/');
}

async function writeResponseToFile(args: {
  response: Response;
  partPath: string;
  append: boolean;
  initialBytes: number;
  expectedBytes: number;
  onBytes: (downloadedBytes: number) => void;
}): Promise<void> {
  if (!args.response.body) throw new Error('Colibrì download returned no body.');
  const handle = await fs.promises.open(args.partPath, args.append ? 'a' : 'w', 0o600);
  let downloaded = args.initialBytes;
  try {
    const reader = args.response.body.getReader();
    while (true) {
      // A response stream is ordered and must be written serially.
      // eslint-disable-next-line no-await-in-loop
      const { value, done } = await reader.read();
      if (done) break;
      if (!value?.byteLength) continue;
      downloaded += value.byteLength;
      if (downloaded > args.expectedBytes) throw new Error('Colibrì download exceeded its pinned byte size.');
      // eslint-disable-next-line no-await-in-loop
      await handle.write(value);
      args.onBytes(downloaded);
    }
    await handle.sync();
  } finally {
    await handle.close();
  }
  if (downloaded !== args.expectedBytes) throw new Error('Colibrì download ended before its pinned byte size.');
  fs.chmodSync(args.partPath, 0o600);
}

async function downloadTreeFile(args: {
  file: ColibriTreeFile;
  destinationPath: string;
  fetchImpl: typeof fetch;
  onBytes: (downloadedBytes: number) => void;
}): Promise<void> {
  if (await verifyTreeFile(args.destinationPath, args.file)) {
    args.onBytes(args.file.sizeBytes);
    return;
  }
  fs.rmSync(args.destinationPath, { force: true });
  ensurePrivateDir(path.dirname(args.destinationPath));
  const partPath = `${args.destinationPath}.part`;
  const metaPath = `${partPath}.json`;
  let offset = 0;
  let etag = '';
  try {
    const meta = JSON.parse(fs.readFileSync(metaPath, 'utf8')) as { hash?: string; size?: number; etag?: string };
    const partialSize = fs.statSync(partPath).size;
    if (meta.hash === args.file.hash && meta.size === args.file.sizeBytes && partialSize < args.file.sizeBytes) {
      offset = partialSize;
      etag = String(meta.etag || '');
    }
  } catch {
    offset = 0;
  }
  if (!offset) {
    fs.rmSync(partPath, { force: true });
    fs.rmSync(metaPath, { force: true });
  }
  const url = `https://huggingface.co/${COLIBRI_MODEL_SNAPSHOT.repository}/resolve/${COLIBRI_MODEL_SNAPSHOT.revision}/${encodeSnapshotPath(args.file.path)}?download=true`;
  const response = await args.fetchImpl(url, {
    redirect: 'follow',
    headers: offset ? { Range: `bytes=${offset}-`, ...(etag ? { 'If-Range': etag } : {}) } : undefined,
  });
  if (!response.ok) throw new Error(`Colibrì model file download failed (${response.status}).`);
  const finalUrl = new URL(response.url || url);
  if (finalUrl.protocol !== 'https:') throw new Error('Colibrì download followed a non-HTTPS redirect.');
  const append = offset > 0 && response.status === 206;
  const initialBytes = append ? offset : 0;
  const responseEtag = response.headers.get('etag')?.trim() || etag;
  writePrivateJson(metaPath, { hash: args.file.hash, size: args.file.sizeBytes, etag: responseEtag });
  await writeResponseToFile({
    response,
    partPath,
    append,
    initialBytes,
    expectedBytes: args.file.sizeBytes,
    onBytes: args.onBytes,
  });
  if (!(await verifyTreeFile(partPath, args.file))) throw new Error(`Colibrì file hash mismatch: ${args.file.path}.`);
  fs.renameSync(partPath, args.destinationPath);
  fs.rmSync(metaPath, { force: true });
}

async function downloadSourceArchive(paths: ColibriPaths, fetchImpl: typeof fetch): Promise<void> {
  try {
    if (
      fs.statSync(paths.sourceArchivePath).size === COLIBRI_SOURCE.sizeBytes &&
      (await sha256File(paths.sourceArchivePath)) === COLIBRI_SOURCE.sha256
    ) {
      return;
    }
  } catch {
    // Download below.
  }
  fs.rmSync(paths.sourceArchivePath, { force: true });
  const response = await fetchImpl(COLIBRI_SOURCE.url, { redirect: 'follow' });
  if (!response.ok) throw new Error(`Colibrì source download failed (${response.status}).`);
  const sourceFile: ColibriTreeFile = {
    path: COLIBRI_SOURCE.fileName,
    sizeBytes: COLIBRI_SOURCE.sizeBytes,
    hashKind: 'sha256',
    hash: COLIBRI_SOURCE.sha256,
  };
  await writeResponseToFile({
    response,
    partPath: `${paths.sourceArchivePath}.part`,
    append: false,
    initialBytes: 0,
    expectedBytes: COLIBRI_SOURCE.sizeBytes,
    onBytes: () => undefined,
  });
  if (!(await verifyTreeFile(`${paths.sourceArchivePath}.part`, sourceFile))) {
    throw new Error('Colibrì source archive hash mismatch.');
  }
  fs.renameSync(`${paths.sourceArchivePath}.part`, paths.sourceArchivePath);
}

function validateExtractedTree(root: string, current = root): void {
  const stat = fs.lstatSync(current);
  if (stat.isSymbolicLink()) {
    if (!isSafeSymlinkTarget(root, current, fs.readlinkSync(current))) {
      throw new Error('Colibrì source archive contains an escaping symlink.');
    }
    return;
  }
  if (stat.isDirectory()) {
    for (const name of fs.readdirSync(current)) validateExtractedTree(root, path.join(current, name));
    return;
  }
  if (!stat.isFile()) throw new Error('Colibrì source archive contains an unsupported filesystem entry.');
}

function runTar(args: string[]): string {
  const result = childProcess.spawnSync('/usr/bin/tar', args, { encoding: 'utf8', maxBuffer: MAX_TAR_LIST_BYTES });
  if (result.status !== 0) throw new Error('Colibrì source archive extraction failed.');
  return result.stdout || '';
}

function extractSource(paths: ColibriPaths): void {
  const entries = runTar(['-tzf', paths.sourceArchivePath]).split(/\r?\n/).filter(Boolean);
  if (!entries.length || entries.some((entry) => !isSafeArchiveEntry(entry))) {
    throw new Error('Colibrì source archive contains an unsafe path.');
  }
  ensurePrivateDir(paths.runtimeParentDir);
  const stage = path.join(paths.runtimeParentDir, `.stage-${process.pid}-${Date.now()}`);
  fs.rmSync(stage, { recursive: true, force: true });
  fs.mkdirSync(stage, { recursive: true, mode: 0o700 });
  try {
    runTar(['-xzf', paths.sourceArchivePath, '-C', stage]);
    const extracted = path.join(stage, COLIBRI_SOURCE.archiveRoot);
    validateExtractedTree(extracted);
    fs.rmSync(paths.runtimeDir, { recursive: true, force: true });
    fs.renameSync(extracted, paths.runtimeDir);
  } finally {
    fs.rmSync(stage, { recursive: true, force: true });
  }
}

function commandPath(candidates: string[]): string | undefined {
  return candidates.find((candidate) => fs.existsSync(candidate));
}

async function runCommand(
  command: string,
  args: string[],
  options: { timeoutMs: number; env?: NodeJS.ProcessEnv }
): Promise<{ status: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = childProcess.spawn(command, args, {
      env: options.env ?? process.env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk: Buffer) => {
      stdout = appendBoundedCommandOutput(stdout, chunk);
    });
    child.stderr.on('data', (chunk: Buffer) => {
      stderr = appendBoundedCommandOutput(stderr, chunk);
    });
    const timer = setTimeout(() => {
      child.kill('SIGTERM');
      setTimeout(() => child.kill('SIGKILL'), 5_000).unref();
    }, options.timeoutMs);
    child.once('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once('exit', (status) => {
      clearTimeout(timer);
      resolve({ status, stdout, stderr });
    });
  });
}

async function ensureBuildPrerequisites(allowHomebrewInstall: boolean): Promise<void> {
  if (!commandPath(['/usr/bin/make']) || !commandPath(['/usr/bin/clang']) || !commandPath(['/usr/bin/python3'])) {
    throw new Error('Colibrì needs the macOS Command Line Tools (make, clang and python3).');
  }
  const brew = commandPath(['/opt/homebrew/bin/brew', '/usr/local/bin/brew']);
  if (!brew) return;
  const prefix = childProcess.spawnSync(brew, ['--prefix', 'libomp'], { encoding: 'utf8', timeout: 10_000 });
  const ompRoot = String(prefix.stdout || '').trim();
  if (prefix.status === 0 && fs.existsSync(path.join(ompRoot, 'include', 'omp.h'))) return;
  if (!allowHomebrewInstall) {
    throw new Error(
      'Colibrì needs Homebrew libomp for usable multi-core inference. Enable managed installation first.'
    );
  }
  const install = await runCommand(brew, ['install', 'libomp'], { timeoutMs: 30 * 60_000 });
  if (install.status !== 0) throw new Error('Homebrew could not install libomp for Colibrì.');
}

async function buildAndVerifyRuntime(paths: ColibriPaths, allowHomebrewInstall: boolean): Promise<void> {
  await ensureBuildPrerequisites(allowHomebrewInstall);
  const build = await runCommand(
    '/usr/bin/make',
    ['-C', path.join(paths.runtimeDir, 'c'), 'glm', 'METAL=1', 'ARCH=native'],
    {
      timeoutMs: BUILD_TIMEOUT_MS,
      env: { ...process.env, PATH: `/opt/homebrew/bin:/usr/local/bin:${process.env.PATH || ''}` },
    }
  );
  if (build.status !== 0 || !fs.existsSync(paths.enginePath)) {
    throw new Error(`Colibrì Metal runtime build failed: ${build.stderr.slice(-1000)}`);
  }
  fs.chmodSync(paths.cliPath, 0o700);
  fs.chmodSync(paths.enginePath, 0o700);
  const doctor = await runCommand(
    '/usr/bin/python3',
    [paths.cliPath, 'doctor', '--model', paths.modelDir, '--ctx', '65536', '--json'],
    { timeoutMs: DOCTOR_TIMEOUT_MS }
  );
  if (doctor.status !== 0) throw new Error('Colibrì doctor did not accept the pinned local installation.');
}

function progressWriter(paths: ColibriPaths, callback?: ColibriProvisionOptions['onProgress']) {
  let lastAt = 0;
  let lastPercent = -1;
  return (
    input: Omit<
      ColibriProvisionProgressReceipt,
      'version' | 'model_revision' | 'tree_sha256' | 'updated_at' | 'percent'
    >
  ): void => {
    const percent =
      input.status === 'done' ? 100 : Math.min(99, Math.floor((input.completed / Math.max(1, input.total)) * 100));
    const now = Date.now();
    if (input.status !== 'done' && input.status !== 'failed' && percent === lastPercent && now - lastAt < 500) return;
    const progress: ColibriProvisionProgressReceipt = {
      version: 'command-eve-colibri-provision-progress/v0',
      model_revision: COLIBRI_MODEL_SNAPSHOT.revision,
      tree_sha256: COLIBRI_MODEL_SNAPSHOT.treeSha256,
      ...input,
      percent,
      updated_at: new Date(now).toISOString(),
    };
    writePrivateJson(paths.provisionProgressPath, progress);
    callback?.(progress);
    lastAt = now;
    lastPercent = percent;
  };
}

async function ensureColibriArtifactsOnce(
  options: ColibriProvisionOptions
): Promise<{ paths: ColibriPaths; receipt: ColibriProvisionReceipt }> {
  const platform = options.platform ?? process.platform;
  const arch = options.arch ?? process.arch;
  if (platform !== 'darwin' || arch !== 'arm64') {
    throw new Error('Colibrì is currently available only on Apple Silicon Macs.');
  }
  const current = readColibriInstallStatus(options.userDataPath);
  const paths = resolveColibriPaths(options.userDataPath);
  if (current.installed) {
    return { paths, receipt: readJsonRecord(paths.receiptPath) as ColibriProvisionReceipt };
  }
  if (!options.autoDownload) throw new Error('Colibrì is not installed yet.');
  for (const directory of [paths.root, paths.downloadsDir, paths.runtimeParentDir, paths.modelDir]) {
    ensurePrivateDir(directory);
  }
  const emit = progressWriter(paths, options.onProgress);
  const fetchImpl = options.fetchImpl ?? fetch;
  const tree = await fetchPinnedColibriTree(fetchImpl);
  const total = COLIBRI_MODEL_SNAPSHOT.totalSizeBytes + COLIBRI_SOURCE.sizeBytes;
  let completed = 0;
  emit({ status: 'pulling', stage: 'verify', total, completed });
  const freeBytes = availableBytesForPath(paths.root);
  const reusableModelBytes = estimateReusableColibriBytes(paths.modelDir, tree);
  let reclaimableSourceBytes = 0;
  try {
    reclaimableSourceBytes = Math.min(COLIBRI_SOURCE.sizeBytes, fs.statSync(paths.sourceArchivePath).size);
  } catch {
    // Source archive is not present yet.
  }
  const requiredNewBytes = Math.max(0, total - reusableModelBytes - reclaimableSourceBytes);
  if (freeBytes < requiredNewBytes + DISK_HEADROOM_BYTES) {
    throw new Error('Colibrì needs about 400 GB free disk plus installation headroom.');
  }
  await downloadSourceArchive(paths, fetchImpl);
  completed += COLIBRI_SOURCE.sizeBytes;
  for (const file of tree) {
    // Intentionally serialize 384 GB of verified model I/O to avoid disk and memory spikes.
    // eslint-disable-next-line no-await-in-loop
    await downloadTreeFile({
      file,
      destinationPath: path.join(paths.modelDir, file.path),
      fetchImpl,
      onBytes: (fileBytes) =>
        emit({
          status: 'pulling',
          stage: 'download',
          total,
          completed: completed + fileBytes,
          current_file: file.path,
        }),
    });
    completed += file.sizeBytes;
  }
  emit({ status: 'building', stage: 'extract', total, completed });
  extractSource(paths);
  emit({ status: 'building', stage: 'build', total, completed });
  await buildAndVerifyRuntime(paths, options.allowHomebrewInstall === true);
  emit({ status: 'building', stage: 'doctor', total, completed });
  const receipt: ColibriProvisionReceipt = {
    version: COMMAND_EVE_COLIBRI_VERSION,
    status: 'ready',
    observed_at: new Date().toISOString(),
    model: {
      repository: COLIBRI_MODEL_SNAPSHOT.repository,
      revision: COLIBRI_MODEL_SNAPSHOT.revision,
      file_count: COLIBRI_MODEL_SNAPSHOT.fileCount,
      size_bytes: COLIBRI_MODEL_SNAPSHOT.totalSizeBytes,
      tree_sha256: COLIBRI_MODEL_SNAPSHOT.treeSha256,
    },
    runtime: {
      repository: COLIBRI_SOURCE.repository,
      source_commit: COLIBRI_SOURCE.commit,
      archive_sha256: COLIBRI_SOURCE.sha256,
      engine_sha256: await sha256File(paths.enginePath),
    },
    doctor: { status: 'pass' },
  };
  writePrivateJson(paths.receiptPath, receipt);
  emit({ status: 'done', stage: 'ready', total, completed: total });
  return { paths, receipt };
}

export async function ensureColibriArtifacts(
  options: ColibriProvisionOptions
): Promise<{ paths: ColibriPaths; receipt: ColibriProvisionReceipt }> {
  const key = path.resolve(options.userDataPath);
  const existing = provisions.get(key);
  if (existing) return existing;
  const paths = resolveColibriPaths(options.userDataPath);
  const task = ensureColibriArtifactsOnce(options).catch((error) => {
    const previous = readColibriInstallStatus(options.userDataPath).progress;
    const emit = progressWriter(paths, options.onProgress);
    emit({
      status: 'failed',
      stage: previous?.stage ?? 'verify',
      total: COLIBRI_MODEL_SNAPSHOT.totalSizeBytes + COLIBRI_SOURCE.sizeBytes,
      completed: previous?.completed ?? 0,
      error: error instanceof Error ? error.message.slice(0, 500) : String(error).slice(0, 500),
    });
    throw error;
  });
  provisions.set(key, task);
  try {
    return await task;
  } finally {
    if (provisions.get(key) === task) provisions.delete(key);
  }
}

export function isColibriProvisionInFlight(userDataPath: string): boolean {
  return provisions.has(path.resolve(userDataPath));
}

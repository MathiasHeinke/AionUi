import childProcess from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

import {
  availableBytesForPath,
  buildResumeDecision,
  isSafeArchiveEntry,
  isSafeSymlinkTarget,
  sha256File,
  verifyPinnedArtifactFile,
} from './bonsaiArtifactCore';
import {
  BONSAI_MODEL_ARTIFACT,
  BONSAI_RUNTIME_ARTIFACT,
  BONSAI_RUNTIME_RELEASE,
  COMMAND_EVE_BONSAI_PILOT_VERSION,
  resolveBonsaiPilotPaths,
  type BonsaiPilotPaths,
  type BonsaiPinnedArtifact,
} from './bonsaiManifest';

const DISK_HEADROOM_BYTES = 2 * 1024 ** 3;
const DOWNLOAD_META_VERSION = 'command-eve-bonsai-download/v0';
const MAX_TAR_LIST_BYTES = 4 * 1024 * 1024;

type DownloadMeta = Readonly<{
  version: typeof DOWNLOAD_META_VERSION;
  artifactId: BonsaiPinnedArtifact['id'];
  etag: string;
  expectedSizeBytes: number;
  expectedSha256: string;
}>;

export type BonsaiProvisionProgress = Readonly<{
  stage: 'verify' | 'download' | 'extract' | 'ready';
  artifact?: BonsaiPinnedArtifact['id'];
  downloadedBytes?: number;
  expectedBytes?: number;
  message: string;
}>;

export type BonsaiProvisionProgressReceipt = Readonly<{
  version: 'command-eve-bonsai-provision-progress/v0';
  status: 'pulling' | 'done' | 'failed';
  artifact?: BonsaiPinnedArtifact['id'];
  total: number;
  completed: number;
  percent: number;
  updated_at: string;
  error?: string;
}>;

export type BonsaiInstallStatus = Readonly<{
  installed: boolean;
  installedSizeBytes?: number;
  progress?: BonsaiProvisionProgressReceipt;
}>;

export type BonsaiProvisionOptions = Readonly<{
  userDataPath: string;
  autoDownload?: boolean;
  fetchImpl?: typeof fetch;
  onProgress?: (progress: BonsaiProvisionProgress) => void;
}>;

export type BonsaiProvisionReceipt = Readonly<{
  version: typeof COMMAND_EVE_BONSAI_PILOT_VERSION;
  status: 'ready';
  observed_at: string;
  model: {
    file: string;
    size_bytes: number;
    sha256: string;
  };
  runtime: {
    tag: string;
    source_commit: string;
    archive_sha256: string;
    server_sha256: string;
  };
}>;

const inFlightDownloads = new Map<string, Promise<void>>();
const inFlightProvisions = new Map<string, Promise<{ paths: BonsaiPilotPaths; receipt: BonsaiProvisionReceipt }>>();

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

function isNonnegativeNumber(candidate: unknown): candidate is number {
  return typeof candidate === 'number' && Number.isFinite(candidate) && candidate >= 0;
}

function parseProvisionProgress(
  value: Record<string, unknown> | undefined
): BonsaiProvisionProgressReceipt | undefined {
  if (
    value?.version !== 'command-eve-bonsai-provision-progress/v0' ||
    !['pulling', 'done', 'failed'].includes(String(value.status || '')) ||
    !isNonnegativeNumber(value.total) ||
    !isNonnegativeNumber(value.completed) ||
    !isNonnegativeNumber(value.percent) ||
    value.percent > 100 ||
    typeof value.updated_at !== 'string' ||
    !Number.isFinite(Date.parse(value.updated_at)) ||
    (value.artifact !== undefined && value.artifact !== 'runtime' && value.artifact !== 'model') ||
    (value.error !== undefined && typeof value.error !== 'string')
  ) {
    return undefined;
  }
  return value as BonsaiProvisionProgressReceipt;
}

export function readBonsaiInstallStatus(userDataPath: string): BonsaiInstallStatus {
  const paths = resolveBonsaiPilotPaths(userDataPath);
  const receipt = readJsonRecord(paths.receiptPath);
  const progress = parseProvisionProgress(readJsonRecord(paths.provisionProgressPath));
  let installedSizeBytes: number | undefined;
  try {
    installedSizeBytes = fs.statSync(paths.modelPath).size;
  } catch {
    installedSizeBytes = undefined;
  }
  const receiptReady =
    receipt?.version === COMMAND_EVE_BONSAI_PILOT_VERSION &&
    receipt.status === 'ready' &&
    (receipt.model as Record<string, unknown> | undefined)?.sha256 === BONSAI_MODEL_ARTIFACT.sha256 &&
    (receipt.runtime as Record<string, unknown> | undefined)?.server_sha256 === BONSAI_RUNTIME_RELEASE.serverSha256;
  const installed =
    receiptReady && installedSizeBytes === BONSAI_MODEL_ARTIFACT.sizeBytes && fs.existsSync(paths.serverPath);
  return {
    installed,
    ...(installedSizeBytes !== undefined ? { installedSizeBytes } : {}),
    ...(progress ? { progress } : {}),
  };
}

export function buildProgressEmitter(
  paths: BonsaiPilotPaths,
  callback?: BonsaiProvisionOptions['onProgress']
): (progress: BonsaiProvisionProgress) => void {
  const expectedTotal = BONSAI_RUNTIME_ARTIFACT.sizeBytes + BONSAI_MODEL_ARTIFACT.sizeBytes;
  const downloaded = new Map<BonsaiPinnedArtifact['id'], number>();
  let lastPersistedAt = 0;
  let lastPersistedPercent = -1;
  let lastPersistedStage: BonsaiProvisionProgress['stage'] | undefined;
  let lastPersistedArtifact: BonsaiPinnedArtifact['id'] | undefined;
  return (progress) => {
    if (progress.artifact && typeof progress.downloadedBytes === 'number') {
      downloaded.set(progress.artifact, progress.downloadedBytes);
    }
    const completed = [...downloaded.values()].reduce((sum, value) => sum + value, 0);
    const done = progress.stage === 'ready';
    const percent = done ? 100 : Math.min(99, Math.floor((completed / expectedTotal) * 100));
    const now = Date.now();
    const shouldPersist =
      done ||
      progress.stage !== lastPersistedStage ||
      progress.artifact !== lastPersistedArtifact ||
      percent !== lastPersistedPercent ||
      now - lastPersistedAt >= 500;
    if (shouldPersist) {
      writePrivateJson(paths.provisionProgressPath, {
        version: 'command-eve-bonsai-provision-progress/v0',
        status: done ? 'done' : 'pulling',
        ...(progress.artifact ? { artifact: progress.artifact } : {}),
        total: expectedTotal,
        completed: done ? expectedTotal : completed,
        percent,
        updated_at: new Date(now).toISOString(),
      } satisfies BonsaiProvisionProgressReceipt);
      lastPersistedAt = now;
      lastPersistedPercent = percent;
      lastPersistedStage = progress.stage;
      lastPersistedArtifact = progress.artifact;
    }
    callback?.(progress);
  };
}

function writeFailedProgress(paths: BonsaiPilotPaths, error: unknown): void {
  writePrivateJson(paths.provisionProgressPath, {
    version: 'command-eve-bonsai-provision-progress/v0',
    status: 'failed',
    total: BONSAI_RUNTIME_ARTIFACT.sizeBytes + BONSAI_MODEL_ARTIFACT.sizeBytes,
    completed: 0,
    percent: 0,
    updated_at: new Date().toISOString(),
    error: error instanceof Error ? error.message.slice(0, 500) : String(error).slice(0, 500),
  } satisfies BonsaiProvisionProgressReceipt);
}

function readDownloadMeta(filePath: string): DownloadMeta | undefined {
  try {
    const value = JSON.parse(fs.readFileSync(filePath, 'utf8')) as Partial<DownloadMeta>;
    if (
      value.version !== DOWNLOAD_META_VERSION ||
      (value.artifactId !== 'model' && value.artifactId !== 'runtime') ||
      typeof value.etag !== 'string' ||
      value.etag.trim().length === 0 ||
      !Number.isSafeInteger(value.expectedSizeBytes) ||
      typeof value.expectedSha256 !== 'string'
    ) {
      return undefined;
    }
    return value as DownloadMeta;
  } catch {
    return undefined;
  }
}

function responseContentLength(response: Response): number | undefined {
  const value = Number(response.headers.get('content-length'));
  return Number.isSafeInteger(value) && value >= 0 ? value : undefined;
}

function assertHttpsResponse(response: Response, artifact: BonsaiPinnedArtifact): void {
  const responseUrl = new URL(response.url || artifact.url);
  if (responseUrl.protocol !== 'https:') {
    throw new Error(`Refused non-HTTPS redirect while downloading Bonsai ${artifact.id}.`);
  }
}

async function writeResponseBody(args: {
  response: Response;
  partPath: string;
  append: boolean;
  initialBytes: number;
  expectedBytes: number;
  onProgress?: BonsaiProvisionOptions['onProgress'];
  artifact: BonsaiPinnedArtifact;
}): Promise<void> {
  if (!args.response.body) throw new Error(`Bonsai ${args.artifact.id} download returned no body.`);
  const handle = await fs.promises.open(args.partPath, args.append ? 'a' : 'w', 0o600);
  let downloadedBytes = args.initialBytes;
  try {
    const reader = args.response.body.getReader();
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      if (!value || value.byteLength === 0) continue;
      downloadedBytes += value.byteLength;
      if (downloadedBytes > args.expectedBytes) {
        throw new Error(`Bonsai ${args.artifact.id} download exceeded its pinned byte size.`);
      }
      let offset = 0;
      while (offset < value.byteLength) {
        const result = await handle.write(value, offset, value.byteLength - offset, null);
        offset += result.bytesWritten;
      }
      args.onProgress?.({
        stage: 'download',
        artifact: args.artifact.id,
        downloadedBytes,
        expectedBytes: args.expectedBytes,
        message: `Downloading local model component (${Math.floor((downloadedBytes / args.expectedBytes) * 100)}%).`,
      });
    }
    await handle.sync();
  } finally {
    await handle.close();
  }
  fs.chmodSync(args.partPath, 0o600);
}

export async function downloadPinnedBonsaiArtifact(args: {
  destinationPath: string;
  artifact: BonsaiPinnedArtifact;
  fetchImpl?: typeof fetch;
  onProgress?: BonsaiProvisionOptions['onProgress'];
}): Promise<void> {
  const key = path.resolve(args.destinationPath);
  const existing = inFlightDownloads.get(key);
  if (existing) return existing;

  const task = (async () => {
    const validDestination = await verifyPinnedArtifactFile(args.destinationPath, args.artifact);
    if (validDestination.ok) return;
    if (fs.existsSync(args.destinationPath)) fs.rmSync(args.destinationPath, { force: true });

    ensurePrivateDir(path.dirname(args.destinationPath));
    const partPath = `${args.destinationPath}.part`;
    const metaPath = `${partPath}.json`;
    let partialSizeBytes = fs.existsSync(partPath) ? fs.statSync(partPath).size : 0;
    const meta = readDownloadMeta(metaPath);
    const metaMatches =
      meta?.artifactId === args.artifact.id &&
      meta.expectedSizeBytes === args.artifact.sizeBytes &&
      meta.expectedSha256 === args.artifact.sha256;
    if (!metaMatches || partialSizeBytes >= args.artifact.sizeBytes) {
      fs.rmSync(partPath, { force: true });
      fs.rmSync(metaPath, { force: true });
      partialSizeBytes = 0;
    }

    const remainingBytes = args.artifact.sizeBytes - partialSizeBytes;
    const availableBytes = availableBytesForPath(path.dirname(args.destinationPath));
    if (availableBytes < remainingBytes + DISK_HEADROOM_BYTES) {
      throw new Error('Not enough free disk space for the local model pilot.');
    }

    const resume = buildResumeDecision({
      partialSizeBytes,
      expectedSizeBytes: args.artifact.sizeBytes,
      etag: metaMatches ? meta?.etag : undefined,
    });
    const fetchImpl = args.fetchImpl ?? fetch;
    const response = await fetchImpl(args.artifact.url, {
      method: 'GET',
      headers: resume.headers,
      redirect: 'follow',
    });
    if (!response.ok) throw new Error(`Bonsai ${args.artifact.id} download failed (${response.status}).`);
    assertHttpsResponse(response, args.artifact);

    const append = resume.append && response.status === 206;
    const initialBytes = append ? resume.offset : 0;
    const expectedResponseBytes = args.artifact.sizeBytes - initialBytes;
    const contentLength = responseContentLength(response);
    if (contentLength === undefined || contentLength !== expectedResponseBytes) {
      throw new Error(
        `Bonsai ${args.artifact.id} content length mismatch: expected ${expectedResponseBytes}, got ${String(contentLength)}.`
      );
    }
    if (append) {
      const contentRange = response.headers.get('content-range') || '';
      const expectedRange = `bytes ${resume.offset}-${args.artifact.sizeBytes - 1}/${args.artifact.sizeBytes}`;
      if (contentRange !== expectedRange) {
        throw new Error(`Bonsai ${args.artifact.id} resume response did not start at the requested byte.`);
      }
      const resumedEtag = response.headers.get('etag')?.trim();
      if (resumedEtag && resumedEtag !== meta?.etag) {
        throw new Error(`Bonsai ${args.artifact.id} resume response changed its ETag.`);
      }
    }

    const etag = response.headers.get('etag')?.trim() || '';
    if (etag) {
      writePrivateJson(metaPath, {
        version: DOWNLOAD_META_VERSION,
        artifactId: args.artifact.id,
        etag,
        expectedSizeBytes: args.artifact.sizeBytes,
        expectedSha256: args.artifact.sha256,
      } satisfies DownloadMeta);
    } else {
      fs.rmSync(metaPath, { force: true });
    }

    await writeResponseBody({
      response,
      partPath,
      append,
      initialBytes,
      expectedBytes: args.artifact.sizeBytes,
      onProgress: args.onProgress,
      artifact: args.artifact,
    });
    const verified = await verifyPinnedArtifactFile(partPath, args.artifact);
    if (!verified.ok) throw new Error(`Bonsai ${args.artifact.id} verification failed: ${verified.error}.`);
    fs.renameSync(partPath, args.destinationPath);
    fs.chmodSync(args.destinationPath, 0o600);
    fs.rmSync(metaPath, { force: true });
  })();

  inFlightDownloads.set(key, task);
  try {
    await task;
  } finally {
    if (inFlightDownloads.get(key) === task) inFlightDownloads.delete(key);
  }
}

function validateExtractedTree(root: string, current = root): void {
  const stat = fs.lstatSync(current);
  if (stat.isSymbolicLink()) {
    const target = fs.readlinkSync(current);
    if (!isSafeSymlinkTarget(root, current, target)) {
      throw new Error('Bonsai runtime archive contains an escaping symlink.');
    }
    return;
  }
  if (stat.isDirectory()) {
    for (const name of fs.readdirSync(current)) validateExtractedTree(root, path.join(current, name));
    return;
  }
  if (!stat.isFile()) throw new Error('Bonsai runtime archive contains an unsupported filesystem entry.');
}

function runTar(args: string[]): string {
  const result = childProcess.spawnSync('/usr/bin/tar', args, {
    encoding: 'utf8',
    maxBuffer: MAX_TAR_LIST_BYTES,
  });
  if (result.status !== 0) throw new Error('Local model runtime archive extraction failed.');
  return result.stdout || '';
}

async function extractPinnedRuntime(paths: BonsaiPilotPaths): Promise<void> {
  const entries = runTar(['-tzf', paths.runtimeArchivePath]).split(/\r?\n/).filter(Boolean);
  if (entries.length === 0 || entries.some((entry) => !isSafeArchiveEntry(entry))) {
    throw new Error('Local model runtime archive contains an unsafe path.');
  }

  ensurePrivateDir(paths.runtimeParentDir);
  const stage = path.join(paths.runtimeParentDir, `.stage-${process.pid}-${Date.now()}`);
  fs.rmSync(stage, { recursive: true, force: true });
  fs.mkdirSync(stage, { recursive: true, mode: 0o700 });
  try {
    runTar(['-xzf', paths.runtimeArchivePath, '-C', stage]);
    const extractedRoot = path.join(stage, BONSAI_RUNTIME_RELEASE.archiveRoot);
    validateExtractedTree(extractedRoot);
    const extractedServer = path.join(extractedRoot, BONSAI_RUNTIME_RELEASE.serverFileName);
    const serverSha256 = await sha256File(extractedServer);
    if (serverSha256 !== BONSAI_RUNTIME_RELEASE.serverSha256) {
      throw new Error('Local model runtime executable hash mismatch.');
    }

    // Node fetch does not normally attach quarantine, but Finder/browser seeded
    // artifacts can. The pinned archive hash is the trust anchor; remove the
    // attribute only after that archive and the executable have been verified.
    childProcess.spawnSync('/usr/bin/xattr', ['-dr', 'com.apple.quarantine', extractedRoot], {
      encoding: 'utf8',
    });
    const quarantineCheck = childProcess.spawnSync('/usr/bin/xattr', ['-pr', 'com.apple.quarantine', extractedRoot], {
      encoding: 'utf8',
    });
    if (
      quarantineCheck.error ||
      (quarantineCheck.status !== 0 && quarantineCheck.status !== 1) ||
      (quarantineCheck.status === 0 && Boolean(quarantineCheck.stdout?.trim()))
    ) {
      throw new Error('Local model runtime quarantine could not be removed safely.');
    }
    fs.chmodSync(extractedRoot, 0o700);
    fs.chmodSync(extractedServer, 0o755);
    fs.rmSync(paths.runtimeDir, { recursive: true, force: true });
    fs.renameSync(extractedRoot, paths.runtimeDir);
  } finally {
    fs.rmSync(stage, { recursive: true, force: true });
  }
}

async function ensureBonsaiPilotArtifactsOnce(
  options: BonsaiProvisionOptions
): Promise<{ paths: BonsaiPilotPaths; receipt: BonsaiProvisionReceipt }> {
  if (process.platform !== 'darwin' || process.arch !== 'arm64') {
    throw new Error('The local model pilot is only available on Apple Silicon Macs.');
  }
  const paths = resolveBonsaiPilotPaths(options.userDataPath);
  const emitProgress = buildProgressEmitter(paths, options.onProgress);
  for (const directory of [paths.root, paths.downloadsDir, paths.modelDir, paths.runtimeParentDir]) {
    ensurePrivateDir(directory);
  }

  emitProgress({ stage: 'verify', artifact: 'runtime', message: 'Checking local model runtime.' });
  let runtimeVerification = await verifyPinnedArtifactFile(paths.runtimeArchivePath, BONSAI_RUNTIME_ARTIFACT);
  if (!runtimeVerification.ok) {
    if (!options.autoDownload) throw new Error('Local model pilot files are not installed yet.');
    await downloadPinnedBonsaiArtifact({
      destinationPath: paths.runtimeArchivePath,
      artifact: BONSAI_RUNTIME_ARTIFACT,
      fetchImpl: options.fetchImpl,
      onProgress: emitProgress,
    });
    runtimeVerification = await verifyPinnedArtifactFile(paths.runtimeArchivePath, BONSAI_RUNTIME_ARTIFACT);
  }

  emitProgress({ stage: 'verify', artifact: 'model', message: 'Checking local model weights.' });
  let modelVerification = await verifyPinnedArtifactFile(paths.modelPath, BONSAI_MODEL_ARTIFACT);
  if (!modelVerification.ok) {
    if (!options.autoDownload) throw new Error('Local model pilot files are not installed yet.');
    await downloadPinnedBonsaiArtifact({
      destinationPath: paths.modelPath,
      artifact: BONSAI_MODEL_ARTIFACT,
      fetchImpl: options.fetchImpl,
      onProgress: emitProgress,
    });
    modelVerification = await verifyPinnedArtifactFile(paths.modelPath, BONSAI_MODEL_ARTIFACT);
  }
  if (!runtimeVerification.ok || !modelVerification.ok) {
    throw new Error('Local model pilot artifact verification failed.');
  }

  emitProgress({ stage: 'extract', artifact: 'runtime', message: 'Preparing local model runtime.' });
  await extractPinnedRuntime(paths);
  const serverSha256 = await sha256File(paths.serverPath);
  const receipt: BonsaiProvisionReceipt = {
    version: COMMAND_EVE_BONSAI_PILOT_VERSION,
    status: 'ready',
    observed_at: new Date().toISOString(),
    model: {
      file: BONSAI_MODEL_ARTIFACT.fileName,
      size_bytes: modelVerification.actualSizeBytes,
      sha256: modelVerification.actualSha256,
    },
    runtime: {
      tag: BONSAI_RUNTIME_RELEASE.tag,
      source_commit: BONSAI_RUNTIME_RELEASE.sourceCommit,
      archive_sha256: runtimeVerification.actualSha256,
      server_sha256: serverSha256,
    },
  };
  writePrivateJson(paths.receiptPath, receipt);
  emitProgress({ stage: 'ready', message: 'Local model pilot is ready.' });
  return { paths, receipt };
}

export async function ensureBonsaiPilotArtifacts(
  options: BonsaiProvisionOptions
): Promise<{ paths: BonsaiPilotPaths; receipt: BonsaiProvisionReceipt }> {
  const key = path.resolve(options.userDataPath);
  const existing = inFlightProvisions.get(key);
  if (existing) return existing;
  const task = ensureBonsaiPilotArtifactsOnce(options).catch((error) => {
    const paths = resolveBonsaiPilotPaths(options.userDataPath);
    ensurePrivateDir(paths.root);
    writeFailedProgress(paths, error);
    throw error;
  });
  inFlightProvisions.set(key, task);
  try {
    return await task;
  } finally {
    if (inFlightProvisions.get(key) === task) inFlightProvisions.delete(key);
  }
}

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { ensurePrivateDirectory, syncDirectoryDurable } from './atomicJson';
import { writePrivateDocumentImmutable } from '@process/commandEve/document/privateDocumentCache';

export type CanonicalArtifactFolder = 'bilder' | 'videos' | 'dokumente';

export type CanonicalArtifactPlacement = {
  relativePath: string;
  absolutePath: string;
  cleanupNotice?: string;
};

const SAFE_EXTENSION = /^[a-z0-9]{1,10}$/;
const MAX_COLLISIONS = 10_000;

function localDate(nowMs: number): string {
  // The visible filename follows the user's host-local calendar day on purpose.
  // It is presentation only: collision suffixes, not the date, provide identity.
  const date = new Date(nowMs);
  const year = String(date.getFullYear()).padStart(4, '0');
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

export function canonicalArtifactSlug(value: string, fallback: string): string {
  const normalized = value
    .normalize('NFKD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 72)
    .replace(/-+$/g, '');
  return normalized || fallback;
}

function assertRealWorkspace(workspaceRoot: string): string {
  const resolved = path.resolve(workspaceRoot);
  const named = fs.lstatSync(resolved);
  if (!named.isDirectory() || named.isSymbolicLink()) throw new Error('EVE_ARTIFACT_WORKSPACE_UNSAFE');
  fs.realpathSync.native(resolved);
  return resolved;
}

function chooseDestination(input: {
  workspaceRoot: string;
  folder: CanonicalArtifactFolder;
  nameHint: string;
  fallbackName: string;
  extension: string;
  nowMs: number;
}): { relativePath: string; absolutePath: string } {
  const extension = input.extension.toLowerCase().replace(/^\./, '');
  if (!SAFE_EXTENSION.test(extension)) throw new Error('EVE_ARTIFACT_EXTENSION_UNSAFE');
  const stem = `${canonicalArtifactSlug(input.nameHint, input.fallbackName)}-${localDate(input.nowMs)}`;
  for (let collision = 0; collision < MAX_COLLISIONS; collision += 1) {
    const fileName = `${stem}${collision === 0 ? '' : `-${collision + 1}`}.${extension}`;
    const relativePath = path.posix.join(input.folder, fileName);
    const absolutePath = path.resolve(input.workspaceRoot, ...relativePath.split('/'));
    if (path.relative(input.workspaceRoot, absolutePath) !== relativePath.split('/').join(path.sep)) {
      throw new Error('EVE_ARTIFACT_PATH_ESCAPE');
    }
    try {
      fs.lstatSync(absolutePath);
    } catch (error) {
      if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') {
        return { relativePath, absolutePath };
      }
      throw error;
    }
  }
  throw new Error('EVE_ARTIFACT_COLLISION_LIMIT');
}

function countStateStem(dataPath: string, workspaceRoot: string, folder: CanonicalArtifactFolder): string {
  const key = crypto.createHash('sha256').update(`${workspaceRoot}\0${folder}`).digest('hex');
  return path.join(path.resolve(dataPath), 'command-eve-artifact-folder-state', key);
}

export function recordCanonicalArtifactWrite(
  dataPath: string,
  workspaceRoot: string,
  folder: CanonicalArtifactFolder
): string | undefined {
  const stem = countStateStem(dataPath, workspaceRoot, folder);
  const writesFile = `${stem}.writes`;
  ensurePrivateDirectory(path.dirname(writesFile));
  let descriptor: number | undefined;
  let count: number;
  try {
    descriptor = fs.openSync(writesFile, fs.constants.O_CREAT | fs.constants.O_APPEND | fs.constants.O_WRONLY, 0o600);
    fs.writeSync(descriptor, Buffer.from([1]));
    count = fs.fstatSync(descriptor).size;
  } finally {
    if (descriptor !== undefined) fs.closeSync(descriptor);
  }
  let newestThreshold = 0;
  for (let threshold = 100; threshold <= count; threshold *= 2) {
    let marker: number | undefined;
    try {
      marker = fs.openSync(
        `${stem}.notice-${threshold}`,
        fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_WRONLY,
        0o600
      );
      fs.writeFileSync(marker, `${threshold}\n`, 'utf8');
      newestThreshold = threshold;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    } finally {
      if (marker !== undefined) fs.closeSync(marker);
    }
  }
  return newestThreshold > 0
    ? `Hinweis: Im Ordner „${folder}“ wurden mindestens ${newestThreshold} Artefakte angelegt. Du kannst ältere Artefakte bei Bedarf aufräumen.`
    : undefined;
}

export function publishCanonicalArtifact(input: {
  dataPath: string;
  workspaceRoot: string;
  folder: CanonicalArtifactFolder;
  nameHint: string;
  fallbackName: string;
  extension: string;
  nowMs?: number;
  bytes: Uint8Array;
  beforePublish?: (placement: Pick<CanonicalArtifactPlacement, 'relativePath' | 'absolutePath'>) => void;
}): CanonicalArtifactPlacement {
  const destination = resolveCanonicalArtifactPlacement(input);
  input.beforePublish?.(destination);
  writePrivateDocumentImmutable(input.workspaceRoot, destination.absolutePath, Buffer.from(input.bytes));
  const cleanupNotice = recordCanonicalArtifactWrite(input.dataPath, input.workspaceRoot, input.folder);
  return { ...destination, ...(cleanupNotice === undefined ? {} : { cleanupNotice }) };
}

export function resolveCanonicalArtifactPlacement(input: {
  workspaceRoot: string;
  folder: CanonicalArtifactFolder;
  nameHint: string;
  fallbackName: string;
  extension: string;
  nowMs?: number;
}): Pick<CanonicalArtifactPlacement, 'relativePath' | 'absolutePath'> {
  const workspaceRoot = assertRealWorkspace(input.workspaceRoot);
  const folderPath = path.join(workspaceRoot, input.folder);
  ensurePrivateDirectory(workspaceRoot);
  ensurePrivateDirectory(folderPath);
  return chooseDestination({
    workspaceRoot,
    folder: input.folder,
    nameHint: input.nameHint,
    fallbackName: input.fallbackName,
    extension: input.extension,
    nowMs: input.nowMs ?? Date.now(),
  });
}

export function verifyCanonicalArtifact(input: {
  workspaceRoot: string;
  relativePath: string;
  sha256: string;
  size: number;
}): { ok: true; absolutePath: string; bytes: Buffer } | { ok: false; message: string } {
  const message =
    'Die Datei wurde außerhalb von EVE verändert oder verschoben. Lege sie wieder am ursprünglichen Ort ab oder wähle sie erneut aus.';
  try {
    const workspaceRoot = assertRealWorkspace(input.workspaceRoot);
    const absolutePath = path.resolve(workspaceRoot, ...input.relativePath.split('/'));
    const relative = path.relative(workspaceRoot, absolutePath);
    if (!relative || path.isAbsolute(relative) || relative.startsWith(`..${path.sep}`)) return { ok: false, message };
    const realWorkspaceRoot = fs.realpathSync.native(workspaceRoot);
    const realAbsolutePath = fs.realpathSync.native(absolutePath);
    const realRelative = path.relative(realWorkspaceRoot, realAbsolutePath);
    if (!realRelative || path.isAbsolute(realRelative) || realRelative.startsWith(`..${path.sep}`)) {
      return { ok: false, message };
    }
    const named = fs.lstatSync(absolutePath);
    if (!named.isFile() || named.isSymbolicLink() || named.nlink !== 1 || named.size !== input.size) {
      return { ok: false, message };
    }
    const descriptor = fs.openSync(absolutePath, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0));
    try {
      const before = fs.fstatSync(descriptor);
      if (
        !before.isFile() ||
        before.nlink !== 1 ||
        before.dev !== named.dev ||
        before.ino !== named.ino ||
        before.size !== named.size
      ) {
        return { ok: false, message };
      }
      const bytes = fs.readFileSync(descriptor);
      const after = fs.fstatSync(descriptor);
      const current = fs.lstatSync(absolutePath);
      if (
        after.nlink !== 1 ||
        after.dev !== before.dev ||
        after.ino !== before.ino ||
        after.size !== before.size ||
        after.mtimeMs !== before.mtimeMs ||
        after.ctimeMs !== before.ctimeMs ||
        !current.isFile() ||
        current.isSymbolicLink() ||
        current.nlink !== 1 ||
        current.dev !== after.dev ||
        current.ino !== after.ino ||
        current.size !== after.size ||
        current.mtimeMs !== after.mtimeMs ||
        current.ctimeMs !== after.ctimeMs ||
        crypto.createHash('sha256').update(bytes).digest('hex') !== input.sha256
      ) {
        return { ok: false, message };
      }
      return { ok: true, absolutePath, bytes };
    } finally {
      fs.closeSync(descriptor);
    }
  } catch {
    return { ok: false, message };
  }
}

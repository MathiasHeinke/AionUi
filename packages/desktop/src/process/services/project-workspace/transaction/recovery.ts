import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

function containedPath(root: string, relativePath: string): string | undefined {
  if (
    relativePath.length === 0 ||
    relativePath.startsWith('/') ||
    relativePath.includes('\\') ||
    relativePath.split('/').some((segment) => segment === '' || segment === '.' || segment === '..')
  ) {
    return undefined;
  }
  const candidate = path.resolve(root, relativePath);
  const relative = path.relative(path.resolve(root), candidate);
  return relative !== '' && !relative.startsWith('..') && !path.isAbsolute(relative) ? candidate : undefined;
}

export function sha256File(file: string): string | undefined {
  try {
    const stat = fs.lstatSync(file);
    if (!stat.isFile() || stat.isSymbolicLink()) return undefined;
    return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
  } catch {
    return undefined;
  }
}

export function verifyCreatedFiles(
  root: string,
  createdFiles: Array<{ relative_path: string; sha256: string }>
): boolean {
  return createdFiles.every((entry) => {
    const file = containedPath(root, entry.relative_path);
    return file !== undefined && sha256File(file) === entry.sha256;
  });
}

function listFiles(root: string, current = root): string[] {
  if (!fs.existsSync(current)) return [];
  const out: string[] = [];
  for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
    const absolute = path.join(current, entry.name);
    if (entry.isSymbolicLink()) {
      out.push(path.relative(root, absolute).split(path.sep).join('/'));
    } else if (entry.isDirectory()) {
      out.push(...listFiles(root, absolute));
    } else {
      out.push(path.relative(root, absolute).split(path.sep).join('/'));
    }
  }
  return out.toSorted();
}

function ownedFilesAreSafe(
  root: string,
  createdFiles: Array<{ relative_path: string; sha256: string }>,
  allowMissing: boolean
): boolean {
  return createdFiles.every((entry) => {
    const file = containedPath(root, entry.relative_path);
    if (!file) return false;
    if (!fs.existsSync(file)) return allowMissing;
    return sha256File(file) === entry.sha256;
  });
}

export function hasOnlyExpectedFiles(
  root: string,
  createdFiles: Array<{ relative_path: string; sha256: string }>,
  allowedExtraFiles: string[] = []
): boolean {
  const allowed = new Set([...createdFiles.map((entry) => entry.relative_path), ...allowedExtraFiles]);
  return listFiles(root).every((relative) => allowed.has(relative));
}

/** Removes exact receipt-owned files and then only empty directories. Never recurses with rm. */
export function removeCreatedTree(
  root: string,
  createdFiles: Array<{ relative_path: string; sha256: string }>,
  createdDirectories: string[],
  allowedExtraFiles: string[] = [],
  beforeMutation: (targetPath: string) => void = () => undefined,
  allowMissingOwnedFiles = false
): boolean {
  if (
    !ownedFilesAreSafe(root, createdFiles, allowMissingOwnedFiles) ||
    !hasOnlyExpectedFiles(root, createdFiles, allowedExtraFiles)
  ) {
    return false;
  }
  for (const relative of allowedExtraFiles) {
    const file = containedPath(root, relative);
    if (!file) return false;
    try {
      beforeMutation(file);
      fs.unlinkSync(file);
    } catch (error) {
      if (allowMissingOwnedFiles && (error as NodeJS.ErrnoException).code === 'ENOENT') continue;
      return false;
    }
  }
  for (const entry of createdFiles) {
    const file = containedPath(root, entry.relative_path);
    if (!file) return false;
    try {
      beforeMutation(file);
      fs.unlinkSync(file);
    } catch (error) {
      if (allowMissingOwnedFiles && (error as NodeJS.ErrnoException).code === 'ENOENT') continue;
      return false;
    }
  }
  const directories = [...createdDirectories].toSorted(
    (left, right) => right.split('/').length - left.split('/').length || right.localeCompare(left)
  );
  for (const relative of directories) {
    const directory = containedPath(root, relative);
    if (!directory) return false;
    try {
      beforeMutation(directory);
      fs.rmdirSync(directory);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') return false;
    }
  }
  try {
    beforeMutation(root);
    fs.rmdirSync(root);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') return false;
  }
  return true;
}

/** Adoption undo: remove only unchanged additions and empty dirs, preserving the adopted root and prior files. */
export function removeAdoptionAdditions(
  root: string,
  createdFiles: Array<{ relative_path: string; sha256: string }>,
  createdDirectories: string[],
  allowedExtraFiles: string[] = [],
  beforeMutation: (targetPath: string) => void = () => undefined,
  allowMissingOwnedFiles = false
): boolean {
  if (!ownedFilesAreSafe(root, createdFiles, allowMissingOwnedFiles)) return false;
  const createdDirectoryPrefixes = createdDirectories.map((directory) => `${directory.replace(/\/$/, '')}/`);
  const owned = new Set([...createdFiles.map((entry) => entry.relative_path), ...allowedExtraFiles]);
  const unsafeExtra = listFiles(root).some(
    (relative) => !owned.has(relative) && createdDirectoryPrefixes.some((prefix) => relative.startsWith(prefix))
  );
  if (unsafeExtra) return false;
  for (const relative of allowedExtraFiles) {
    const file = containedPath(root, relative);
    if (!file) return false;
    try {
      beforeMutation(file);
      fs.unlinkSync(file);
    } catch (error) {
      if (allowMissingOwnedFiles && (error as NodeJS.ErrnoException).code === 'ENOENT') continue;
      return false;
    }
  }
  for (const entry of createdFiles) {
    const file = containedPath(root, entry.relative_path);
    if (!file) return false;
    try {
      beforeMutation(file);
      fs.unlinkSync(file);
    } catch (error) {
      if (allowMissingOwnedFiles && (error as NodeJS.ErrnoException).code === 'ENOENT') continue;
      return false;
    }
  }
  const directories = [...createdDirectories].toSorted(
    (left, right) => right.split('/').length - left.split('/').length || right.localeCompare(left)
  );
  for (const relative of directories) {
    const directory = containedPath(root, relative);
    if (!directory) return false;
    try {
      beforeMutation(directory);
      fs.rmdirSync(directory);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT' && (error as NodeJS.ErrnoException).code !== 'ENOTEMPTY') {
        return false;
      }
    }
  }
  return true;
}

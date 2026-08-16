/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import fs from 'node:fs';
import path from 'node:path';

export class CommandEvePrivateDocumentCacheError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CommandEvePrivateDocumentCacheError';
  }
}

export function ensurePrivateDocumentDirectory(rootDirectory: string, directory: string): void {
  const root = path.resolve(rootDirectory);
  const target = path.resolve(directory);
  const relative = path.relative(root, target);
  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new CommandEvePrivateDocumentCacheError('Document cache escaped the private seat home.');
  }

  const rootStat = fs.lstatSync(root);
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) {
    throw new CommandEvePrivateDocumentCacheError('Document cache root is not a regular directory.');
  }

  let current = root;
  for (const component of relative.split(path.sep).filter(Boolean)) {
    current = path.join(current, component);
    let stat: fs.Stats;
    try {
      stat = fs.lstatSync(current);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      try {
        fs.mkdirSync(current, { mode: 0o700 });
      } catch (mkdirError) {
        if ((mkdirError as NodeJS.ErrnoException).code !== 'EEXIST') throw mkdirError;
      }
      stat = fs.lstatSync(current);
    }
    if (!stat.isDirectory() || stat.isSymbolicLink()) {
      throw new CommandEvePrivateDocumentCacheError('Document cache path contains a non-directory or symbolic link.');
    }
    fs.chmodSync(current, 0o700);
  }
}

export function writePrivateDocumentAtomic(
  rootDirectory: string,
  filePath: string,
  contents: string | Uint8Array
): void {
  ensurePrivateDocumentDirectory(rootDirectory, path.dirname(filePath));
  const temporaryPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(temporaryPath, contents, { mode: 0o600, flag: 'wx' });
  fs.chmodSync(temporaryPath, 0o600);
  fs.renameSync(temporaryPath, filePath);
  fs.chmodSync(filePath, 0o600);
}

function privateDocumentMatchesExpectedBytes(filePath: string, expected: Buffer): boolean {
  const lstat = fs.lstatSync(filePath);
  if (lstat.isSymbolicLink() || !lstat.isFile() || lstat.nlink !== 1 || lstat.size !== expected.length) return false;
  const descriptor = fs.openSync(filePath, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0));
  try {
    const before = fs.fstatSync(descriptor);
    if (
      !before.isFile() ||
      before.nlink !== 1 ||
      before.dev !== lstat.dev ||
      before.ino !== lstat.ino ||
      before.size !== lstat.size ||
      before.mtimeMs !== lstat.mtimeMs ||
      before.ctimeMs !== lstat.ctimeMs
    ) {
      return false;
    }
    const actual = fs.readFileSync(descriptor);
    const after = fs.fstatSync(descriptor);
    const current = fs.lstatSync(filePath);
    return (
      after.dev === before.dev &&
      after.ino === before.ino &&
      after.size === before.size &&
      after.mtimeMs === before.mtimeMs &&
      after.ctimeMs === before.ctimeMs &&
      current.isFile() &&
      !current.isSymbolicLink() &&
      current.nlink === 1 &&
      current.dev === after.dev &&
      current.ino === after.ino &&
      current.size === after.size &&
      current.mtimeMs === after.mtimeMs &&
      current.ctimeMs === after.ctimeMs &&
      actual.equals(expected)
    );
  } finally {
    fs.closeSync(descriptor);
  }
}

function assertPrivateDocumentDirectoryDurable(directory: string): void {
  const named = fs.lstatSync(directory);
  if (!named.isDirectory() || named.isSymbolicLink()) {
    throw new CommandEvePrivateDocumentCacheError('Immutable document directory identity changed.');
  }
  const descriptor = fs.openSync(directory, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0));
  try {
    const opened = fs.fstatSync(descriptor);
    if (!opened.isDirectory() || opened.dev !== named.dev || opened.ino !== named.ino) {
      throw new CommandEvePrivateDocumentCacheError('Immutable document directory identity changed.');
    }
    fs.fsyncSync(descriptor);
    const current = fs.lstatSync(directory);
    if (
      !current.isDirectory() ||
      current.isSymbolicLink() ||
      current.dev !== opened.dev ||
      current.ino !== opened.ino
    ) {
      throw new CommandEvePrivateDocumentCacheError('Immutable document directory identity changed.');
    }
  } finally {
    fs.closeSync(descriptor);
  }
}

function ensureImmutableDocumentDirectoryDurable(rootDirectory: string, directory: string): void {
  ensurePrivateDocumentDirectory(rootDirectory, directory);
  const root = path.resolve(rootDirectory);
  const relative = path.relative(root, path.resolve(directory));
  let current = root;
  for (const component of relative.split(path.sep).filter(Boolean)) {
    const child = path.join(current, component);
    const childStat = fs.lstatSync(child);
    if (!childStat.isDirectory() || childStat.isSymbolicLink()) {
      throw new CommandEvePrivateDocumentCacheError('Immutable document directory identity changed.');
    }
    assertPrivateDocumentDirectoryDurable(current);
    current = child;
  }
}

function prepareDurablePrivateDocument(temporaryPath: string, expected: Buffer): void {
  let descriptor: number | undefined;
  try {
    descriptor = fs.openSync(temporaryPath, fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_WRONLY, 0o600);
    fs.writeFileSync(descriptor, expected);
    fs.fchmodSync(descriptor, 0o600);
    fs.fsyncSync(descriptor);
    const written = fs.fstatSync(descriptor);
    const named = fs.lstatSync(temporaryPath);
    if (
      !written.isFile() ||
      written.nlink !== 1 ||
      written.size !== expected.length ||
      written.dev !== named.dev ||
      written.ino !== named.ino
    ) {
      throw new CommandEvePrivateDocumentCacheError('Immutable document temp failed verification.');
    }
  } finally {
    if (descriptor !== undefined) fs.closeSync(descriptor);
  }
}

function publishPrivateDocumentOnce(temporaryPath: string, filePath: string, expected: Buffer): void {
  try {
    fs.linkSync(temporaryPath, filePath);
  } catch (error) {
    if (
      (error as NodeJS.ErrnoException).code !== 'EEXIST' ||
      !privateDocumentMatchesExpectedBytes(filePath, expected)
    ) {
      throw error;
    }
  }
}

function assertPrivateDocumentPublished(filePath: string, expected: Buffer): void {
  assertPrivateDocumentDirectoryDurable(path.dirname(filePath));
  if (!privateDocumentMatchesExpectedBytes(filePath, expected)) {
    throw new CommandEvePrivateDocumentCacheError('Immutable document target failed verification.');
  }
}

/**
 * The bytes must survive a crash before their manifest can become durable.
 * Create-only publication prevents a retry from replacing an earlier result.
 */
export function writePrivateDocumentImmutable(
  rootDirectory: string,
  filePath: string,
  contents: string | Uint8Array
): void {
  ensureImmutableDocumentDirectoryDurable(rootDirectory, path.dirname(filePath));
  const expected = Buffer.isBuffer(contents) ? contents : Buffer.from(contents);
  try {
    if (privateDocumentMatchesExpectedBytes(filePath, expected)) {
      assertPrivateDocumentPublished(filePath, expected);
      return;
    }
    throw new CommandEvePrivateDocumentCacheError('Immutable document target conflicts with persisted bytes.');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }

  const temporaryPath = filePath + '.' + String(process.pid) + '.' + String(Date.now()) + '.immutable.tmp';
  try {
    prepareDurablePrivateDocument(temporaryPath, expected);
    publishPrivateDocumentOnce(temporaryPath, filePath, expected);
  } finally {
    fs.rmSync(temporaryPath, { force: true });
  }
  assertPrivateDocumentPublished(filePath, expected);
}

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

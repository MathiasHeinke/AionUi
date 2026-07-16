/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import { createHash, randomBytes } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

export const MAX_PHASE_B_JSON_BYTES = 1024 * 1024;
const PHASE_B_EVIDENCE_SNIFF_BYTES = 64 * 1024;

export type PhaseBEvidenceFileTruth = {
  sha256: string;
  size_bytes: number;
  file_identity: string;
};

function sha256Descriptor(descriptor: number, captureBytes = 0): { sha256: string; prefix: Buffer } {
  const hash = createHash('sha256');
  const buffer = Buffer.allocUnsafe(1024 * 1024);
  const chunks: Buffer[] = [];
  let captured = 0;
  let bytesRead = 0;
  let position = 0;
  do {
    bytesRead = fs.readSync(descriptor, buffer, 0, buffer.length, position);
    if (bytesRead > 0) {
      const chunk = buffer.subarray(0, bytesRead);
      hash.update(chunk);
      if (captured < captureBytes) {
        const length = Math.min(chunk.length, captureBytes - captured);
        chunks.push(Buffer.from(chunk.subarray(0, length)));
        captured += length;
      }
      position += bytesRead;
    }
  } while (bytesRead > 0);
  return { sha256: hash.digest('hex'), prefix: Buffer.concat(chunks, captured) };
}

function sameFileSnapshot(left: fs.Stats, right: fs.Stats): boolean {
  return (
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.nlink === right.nlink &&
    left.size === right.size &&
    left.mtimeMs === right.mtimeMs &&
    left.ctimeMs === right.ctimeMs
  );
}

function assertSingleLinkedRegularFile(stat: fs.Stats, filePath: string): void {
  if (!stat.isFile()) throw new Error(`file must be a regular file: ${filePath}`);
  if (stat.nlink !== 1) throw new Error(`file must have exactly one hard link: ${filePath}`);
}

function fileIdentity(stat: fs.Stats, absolute: string): string {
  return stat.ino > 0 ? `${stat.dev}:${stat.ino}` : `path:${fs.realpathSync.native(absolute)}`;
}

function regularFileSnapshot(
  filePath: string,
  options: { captureBytes?: number; maxBytes?: number } = {}
): PhaseBEvidenceFileTruth & { prefix: Buffer } {
  const absolute = path.resolve(filePath);
  if (!fs.existsSync(absolute)) throw new Error(`file does not exist: ${filePath}`);
  const pathStat = fs.lstatSync(absolute);
  if (pathStat.isSymbolicLink()) throw new Error(`file must be a non-symlink regular file: ${filePath}`);
  assertSingleLinkedRegularFile(pathStat, filePath);
  if (pathStat.size < 1) throw new Error(`file must not be empty: ${filePath}`);
  if (options.maxBytes !== undefined && pathStat.size > options.maxBytes) {
    throw new Error(`file exceeds ${options.maxBytes} bytes: ${filePath}`);
  }

  const descriptor = fs.openSync(absolute, 'r');
  let openedStat: fs.Stats;
  let sha256 = '';
  let prefix = Buffer.alloc(0);
  try {
    openedStat = fs.fstatSync(descriptor);
    assertSingleLinkedRegularFile(openedStat, filePath);
    if (!sameFileSnapshot(pathStat, openedStat)) {
      throw new Error(`file identity changed before hashing: ${filePath}`);
    }
    ({ sha256, prefix } = sha256Descriptor(descriptor, options.captureBytes));
    const hashedStat = fs.fstatSync(descriptor);
    assertSingleLinkedRegularFile(hashedStat, filePath);
    if (!sameFileSnapshot(openedStat, hashedStat)) {
      throw new Error(`file changed while hashing: ${filePath}`);
    }
  } finally {
    fs.closeSync(descriptor);
  }

  const finalStat = fs.lstatSync(absolute);
  if (finalStat.isSymbolicLink()) throw new Error(`file identity changed after hashing: ${filePath}`);
  assertSingleLinkedRegularFile(finalStat, filePath);
  if (!sameFileSnapshot(openedStat, finalStat)) {
    throw new Error(`file identity changed after hashing: ${filePath}`);
  }
  return { sha256, size_bytes: openedStat.size, file_identity: fileIdentity(openedStat, absolute), prefix };
}

export function readUtf8RegularFileTruth(
  filePath: string,
  maxBytes: number = MAX_PHASE_B_JSON_BYTES
): { text: string; sha256: string; size_bytes: number } {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1) throw new Error('maxBytes must be a positive safe integer');
  const snapshot = regularFileSnapshot(filePath, { captureBytes: maxBytes, maxBytes });
  if (snapshot.prefix.byteLength !== snapshot.size_bytes) throw new Error(`file changed while reading: ${filePath}`);
  let text = '';
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(snapshot.prefix);
  } catch {
    throw new Error(`file is not valid UTF-8: ${filePath}`);
  }
  return {
    text,
    sha256: snapshot.sha256,
    size_bytes: snapshot.size_bytes,
  };
}

export function resolveExistingRegularFile(root: string, relativePath: string): string {
  const absoluteRoot = path.resolve(root);
  const normalized = relativePath.replaceAll('\\', '/');
  const segments = normalized.split('/');
  if (
    !normalized ||
    normalized.startsWith('/') ||
    normalized.startsWith('//') ||
    /^[A-Za-z]:\//u.test(normalized) ||
    segments.some((segment) => segment === '' || segment === '.' || segment === '..')
  ) {
    throw new Error(`evidence path must be relative to its bundle root: ${relativePath}`);
  }
  if (!fs.existsSync(absoluteRoot)) throw new Error(`evidence root does not exist: ${root}`);
  const rootStat = fs.lstatSync(absoluteRoot);
  if (rootStat.isSymbolicLink() || !rootStat.isDirectory()) {
    throw new Error(`evidence root must be a non-symlink directory: ${root}`);
  }
  const absolute = path.resolve(absoluteRoot, normalized);
  const relative = path.relative(absoluteRoot, absolute);
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new Error(`evidence path escapes its bundle root: ${relativePath}`);
  }

  let cursor = absoluteRoot;
  for (const [index, segment] of segments.entries()) {
    cursor = path.join(cursor, segment);
    if (!fs.existsSync(cursor)) throw new Error(`evidence file does not exist: ${relativePath}`);
    const stat = fs.lstatSync(cursor);
    if (stat.isSymbolicLink()) {
      throw new Error(`evidence path must not contain symlinks: ${relativePath}`);
    }
    const finalSegment = index === segments.length - 1;
    if ((!finalSegment && !stat.isDirectory()) || (finalSegment && !stat.isFile())) {
      throw new Error(`evidence path must resolve to a regular file: ${relativePath}`);
    }
    if (finalSegment && stat.nlink !== 1) {
      throw new Error(`evidence file must have exactly one hard link: ${relativePath}`);
    }
  }

  const realRoot = fs.realpathSync.native(absoluteRoot);
  const realAbsolute = fs.realpathSync.native(absolute);
  const realRelative = path.relative(realRoot, realAbsolute);
  if (!realRelative || realRelative.startsWith('..') || path.isAbsolute(realRelative)) {
    throw new Error(`evidence path escapes its real bundle root: ${relativePath}`);
  }
  return absolute;
}

export function regularFileTruth(filePath: string): { sha256: string; size_bytes: number } {
  const { sha256, size_bytes } = regularFileSnapshot(filePath);
  return { sha256, size_bytes };
}

export function windowsExecutableTruth(filePath: string): { sha256: string; size_bytes: number } {
  requireExtension(filePath, ['.exe'], 'Windows candidate');
  const snapshot = regularFileSnapshot(filePath, { captureBytes: PHASE_B_EVIDENCE_SNIFF_BYTES });
  const prefix = snapshot.prefix;
  if (snapshot.size_bytes < 512 || !hasAscii(prefix, 0, 'MZ') || prefix.byteLength < 0x40) {
    throw new Error(`Windows candidate is not a recognized PE executable: ${filePath}`);
  }
  const peOffset = prefix.readUInt32LE(0x3c);
  if (peOffset < 0x40 || peOffset + 26 > prefix.byteLength || !hasAscii(prefix, peOffset, 'PE\0\0')) {
    throw new Error(`Windows candidate has an invalid PE header: ${filePath}`);
  }
  const machine = prefix.readUInt16LE(peOffset + 4);
  const optionalHeaderMagic = prefix.readUInt16LE(peOffset + 24);
  if (![0x014c, 0x8664].includes(machine) || ![0x010b, 0x020b].includes(optionalHeaderMagic)) {
    throw new Error(`Windows candidate has an unsupported PE machine or optional-header format: ${filePath}`);
  }
  return { sha256: snapshot.sha256, size_bytes: snapshot.size_bytes };
}

function hasAscii(buffer: Buffer, offset: number, value: string): boolean {
  return (
    buffer.byteLength >= offset + value.length &&
    buffer.subarray(offset, offset + value.length).toString('ascii') === value
  );
}

function hasBytes(buffer: Buffer, expected: readonly number[]): boolean {
  return buffer.byteLength >= expected.length && expected.every((value, index) => buffer[index] === value);
}

function requireExtension(filePath: string, allowed: readonly string[], kind: string): void {
  const extension = path.extname(filePath).toLowerCase();
  if (!allowed.includes(extension)) throw new Error(`${kind} evidence has an unexpected file extension: ${filePath}`);
}

function requireUtf8Text(prefix: Buffer, filePath: string, kind: string): void {
  if (prefix.includes(0)) throw new Error(`${kind} evidence contains binary NUL bytes: ${filePath}`);
  try {
    new TextDecoder('utf-8', { fatal: true }).decode(prefix);
  } catch {
    throw new Error(`${kind} evidence is not valid UTF-8: ${filePath}`);
  }
}

function isImage(prefix: Buffer): boolean {
  return (
    hasBytes(prefix, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]) ||
    hasBytes(prefix, [0xff, 0xd8, 0xff]) ||
    hasAscii(prefix, 0, 'GIF87a') ||
    hasAscii(prefix, 0, 'GIF89a') ||
    (hasAscii(prefix, 0, 'RIFF') && hasAscii(prefix, 8, 'WEBP')) ||
    hasAscii(prefix, 0, 'BM')
  );
}

function isVideo(prefix: Buffer): boolean {
  return (
    hasAscii(prefix, 4, 'ftyp') ||
    hasBytes(prefix, [0x1a, 0x45, 0xdf, 0xa3]) ||
    (hasAscii(prefix, 0, 'RIFF') && hasAscii(prefix, 8, 'AVI '))
  );
}

function isAudio(prefix: Buffer): boolean {
  return (
    (hasAscii(prefix, 0, 'RIFF') && hasAscii(prefix, 8, 'WAVE')) ||
    hasAscii(prefix, 0, 'ID3') ||
    (prefix.byteLength >= 2 && prefix[0] === 0xff && (prefix[1] & 0xe0) === 0xe0) ||
    hasAscii(prefix, 0, 'OggS') ||
    hasAscii(prefix, 0, 'fLaC') ||
    hasAscii(prefix, 4, 'ftyp')
  );
}

export function regularEvidenceFileTruth(filePath: string, kind: string): PhaseBEvidenceFileTruth {
  const maxBytes = kind === 'json' ? MAX_PHASE_B_JSON_BYTES : undefined;
  const snapshot = regularFileSnapshot(filePath, {
    captureBytes: kind === 'json' ? MAX_PHASE_B_JSON_BYTES : PHASE_B_EVIDENCE_SNIFF_BYTES,
    maxBytes,
  });
  const prefix = snapshot.prefix;

  if (kind === 'json') {
    requireExtension(filePath, ['.json'], kind);
    requireUtf8Text(prefix, filePath, kind);
    try {
      JSON.parse(prefix.toString('utf8'));
    } catch {
      throw new Error(`json evidence is not parseable JSON: ${filePath}`);
    }
  } else if (kind === 'markdown') {
    requireExtension(filePath, ['.md', '.markdown'], kind);
    requireUtf8Text(prefix, filePath, kind);
  } else if (kind === 'log') {
    requireExtension(filePath, ['.log', '.txt'], kind);
    requireUtf8Text(prefix, filePath, kind);
  } else if (kind === 'report') {
    requireExtension(filePath, ['.md', '.markdown', '.txt'], kind);
    requireUtf8Text(prefix, filePath, kind);
  } else if (kind === 'image' || kind === 'screenshot') {
    requireExtension(filePath, ['.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp'], kind);
    if (!isImage(prefix)) throw new Error(`${kind} evidence does not have a recognized image signature: ${filePath}`);
  } else if (kind === 'video') {
    requireExtension(filePath, ['.mp4', '.m4v', '.mov', '.webm', '.avi'], kind);
    if (!isVideo(prefix)) throw new Error(`video evidence does not have a recognized container signature: ${filePath}`);
  } else if (kind === 'audio') {
    requireExtension(filePath, ['.wav', '.mp3', '.ogg', '.flac', '.m4a'], kind);
    if (!isAudio(prefix)) throw new Error(`audio evidence does not have a recognized container signature: ${filePath}`);
  } else if (kind !== 'artifact') {
    throw new Error(`unsupported Phase B evidence kind: ${kind}`);
  }

  const { sha256, size_bytes, file_identity } = snapshot;
  return { sha256, size_bytes, file_identity };
}

export function writeJsonAtomically(filePath: string, value: unknown): void {
  const absolute = path.resolve(filePath);
  fs.mkdirSync(path.dirname(absolute), { recursive: true });
  if (fs.existsSync(absolute)) throw new Error(`refusing to overwrite existing evidence: ${filePath}`);
  const temporary = `${absolute}.${process.pid}.${randomBytes(8).toString('hex')}.tmp`;
  try {
    fs.writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, {
      encoding: 'utf8',
      mode: 0o600,
      flag: 'wx',
    });
    try {
      fs.linkSync(temporary, absolute);
    } catch (error) {
      if (error instanceof Error && 'code' in error && error.code === 'EEXIST') {
        throw new Error(`refusing to overwrite existing evidence: ${filePath}`);
      }
      throw error;
    }
  } finally {
    fs.rmSync(temporary, { force: true });
  }
}

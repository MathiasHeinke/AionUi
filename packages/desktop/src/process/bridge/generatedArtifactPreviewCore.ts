/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import { constants } from 'fs';
import fs from 'fs/promises';
import path from 'path';
import type {
  IGeneratedArtifactPreviewKind,
  IGeneratedArtifactPreviewRequest,
  IGeneratedArtifactPreviewResult,
} from '@/common/adapter/ipcBridge';

const HTML_PREVIEW_MAX_BYTES = 2 * 1024 * 1024;
const BINARY_PREVIEW_MAX_BYTES = 47 * 1024 * 1024;

const MIME_BY_EXTENSION: Record<string, { kind: IGeneratedArtifactPreviewKind; mimeType: string }> = {
  pdf: { kind: 'pdf', mimeType: 'application/pdf' },
  html: { kind: 'html', mimeType: 'text/html' },
  htm: { kind: 'html', mimeType: 'text/html' },
  png: { kind: 'image', mimeType: 'image/png' },
  jpg: { kind: 'image', mimeType: 'image/jpeg' },
  jpeg: { kind: 'image', mimeType: 'image/jpeg' },
  gif: { kind: 'image', mimeType: 'image/gif' },
  webp: { kind: 'image', mimeType: 'image/webp' },
  avif: { kind: 'image', mimeType: 'image/avif' },
  bmp: { kind: 'image', mimeType: 'image/bmp' },
  mp4: { kind: 'video', mimeType: 'video/mp4' },
  mov: { kind: 'video', mimeType: 'video/quicktime' },
  webm: { kind: 'video', mimeType: 'video/webm' },
  m4v: { kind: 'video', mimeType: 'video/x-m4v' },
  mp3: { kind: 'audio', mimeType: 'audio/mpeg' },
  wav: { kind: 'audio', mimeType: 'audio/wav' },
  m4a: { kind: 'audio', mimeType: 'audio/mp4' },
  ogg: { kind: 'audio', mimeType: 'audio/ogg' },
  aac: { kind: 'audio', mimeType: 'audio/aac' },
};

function isContainedPath(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return (
    relative.length > 0 && relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative)
  );
}

function hasExpectedSignature(buffer: Buffer, extension: string): boolean {
  const ascii = buffer.subarray(0, 16).toString('ascii');
  switch (extension) {
    case 'pdf':
      return ascii.startsWith('%PDF-');
    case 'png':
      return buffer.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
    case 'jpg':
    case 'jpeg':
      return buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff;
    case 'gif':
      return ascii.startsWith('GIF87a') || ascii.startsWith('GIF89a');
    case 'webp':
      return ascii.startsWith('RIFF') && ascii.slice(8, 12) === 'WEBP';
    case 'avif':
      return ascii.slice(4, 8) === 'ftyp' && (ascii.includes('avif') || ascii.includes('avis'));
    case 'bmp':
      return ascii.startsWith('BM');
    case 'mp4':
    case 'mov':
    case 'm4v':
    case 'm4a':
      return ascii.slice(4, 8) === 'ftyp';
    case 'webm':
      return buffer.subarray(0, 4).equals(Buffer.from([0x1a, 0x45, 0xdf, 0xa3]));
    case 'mp3':
      return ascii.startsWith('ID3') || (buffer[0] === 0xff && (buffer[1] & 0xe0) === 0xe0);
    case 'wav':
      return ascii.startsWith('RIFF') && ascii.slice(8, 12) === 'WAVE';
    case 'ogg':
      return ascii.startsWith('OggS');
    case 'aac':
      return buffer[0] === 0xff && (buffer[1] === 0xf1 || buffer[1] === 0xf9);
    case 'html':
    case 'htm':
      return true;
    default:
      return false;
  }
}

export async function readApprovedGeneratedArtifactPreview(
  request: IGeneratedArtifactPreviewRequest,
  downloadsRoot: string
): Promise<IGeneratedArtifactPreviewResult | null> {
  if (!request.path || !path.isAbsolute(request.path) || request.path.includes('\0')) return null;

  const extension = path.extname(request.path).slice(1).toLowerCase();
  const spec = MIME_BY_EXTENSION[extension];
  if (!spec || spec.kind !== request.kind) return null;

  try {
    const [canonicalRoot, candidateLstat] = await Promise.all([fs.realpath(downloadsRoot), fs.lstat(request.path)]);
    if (!candidateLstat.isFile() || candidateLstat.isSymbolicLink()) return null;

    const canonicalCandidate = await fs.realpath(request.path);
    if (!isContainedPath(canonicalRoot, canonicalCandidate)) return null;

    const handle = await fs.open(canonicalCandidate, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const handleStat = await handle.stat();
      const maxBytes = request.kind === 'html' ? HTML_PREVIEW_MAX_BYTES : BINARY_PREVIEW_MAX_BYTES;
      if (
        !handleStat.isFile() ||
        handleStat.size <= 0 ||
        handleStat.size > maxBytes ||
        handleStat.dev !== candidateLstat.dev ||
        handleStat.ino !== candidateLstat.ino
      ) {
        return null;
      }

      const signature = Buffer.alloc(Math.min(32, handleStat.size));
      await handle.read(signature, 0, signature.length, 0);
      if (!hasExpectedSignature(signature, extension)) return null;

      const buffer = await handle.readFile();
      if (buffer.length !== handleStat.size || buffer.length > maxBytes) return null;

      return {
        data: request.kind === 'html' ? buffer.toString('utf8') : buffer.toString('base64'),
        encoding: request.kind === 'html' ? 'utf8' : 'base64',
        mimeType: spec.mimeType,
        size: buffer.length,
      };
    } finally {
      await handle.close();
    }
  } catch {
    return null;
  }
}

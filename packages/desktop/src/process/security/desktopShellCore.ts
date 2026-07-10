import path from 'node:path';

const MAX_EXTERNAL_URL_LENGTH = 4096;
const MAX_FILE_PATH_BYTES = 32 * 1024;
const ALLOWED_EXTERNAL_PROTOCOLS = new Set(['https:', 'http:', 'mailto:']);

export function parseDesktopExternalUrl(value: unknown): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > MAX_EXTERNAL_URL_LENGTH) {
    throw new Error('Invalid external URL.');
  }

  let target: URL;
  try {
    target = new URL(value);
  } catch {
    throw new Error('Invalid external URL.');
  }

  if (!ALLOWED_EXTERNAL_PROTOCOLS.has(target.protocol)) {
    throw new Error('External URL protocol is not allowed.');
  }
  return value;
}

export function parseDesktopAbsolutePath(value: unknown): string {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.includes('\0') ||
    Buffer.byteLength(value, 'utf8') > MAX_FILE_PATH_BYTES ||
    (!path.posix.isAbsolute(value) && !path.win32.isAbsolute(value))
  ) {
    throw new Error('Invalid absolute file path.');
  }
  return value;
}

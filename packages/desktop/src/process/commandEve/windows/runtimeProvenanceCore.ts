import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

export const COMMAND_EVE_BUNDLED_PYTHON_MANIFEST_FILE = 'command-eve-python-manifest.json';

export type BundledPythonProvenance = {
  schema_version: 'command-eve-bundled-python/v1';
  platform: string;
  arch: string;
  triple: string;
  python_version: string;
  release_tag: string;
  archive_name: string;
  archive_sha256: string;
  source_url: string;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hasString(record: Record<string, unknown>, key: string): boolean {
  return typeof record[key] === 'string' && record[key].trim().length > 0;
}

export function readBundledPythonProvenance(resourcesPath?: string): BundledPythonProvenance | undefined {
  if (!resourcesPath) return undefined;
  const manifestPath = path.join(resourcesPath, 'python', COMMAND_EVE_BUNDLED_PYTHON_MANIFEST_FILE);
  try {
    const parsed: unknown = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    if (!isRecord(parsed) || parsed.schema_version !== 'command-eve-bundled-python/v1') return undefined;
    const required = [
      'platform',
      'arch',
      'triple',
      'python_version',
      'release_tag',
      'archive_name',
      'archive_sha256',
      'source_url',
    ];
    if (!required.every((key) => hasString(parsed, key))) return undefined;
    if (!/^[0-9a-f]{64}$/.test(String(parsed.archive_sha256))) return undefined;
    return parsed as BundledPythonProvenance;
  } catch {
    return undefined;
  }
}

export function sha256FileIfPresent(filePath: string): string | undefined {
  if (!filePath || !fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) return undefined;
  const hash = crypto.createHash('sha256');
  const descriptor = fs.openSync(filePath, 'r');
  const buffer = Buffer.allocUnsafe(1024 * 1024);
  try {
    let bytesRead = 0;
    do {
      bytesRead = fs.readSync(descriptor, buffer, 0, buffer.length, null);
      if (bytesRead > 0) hash.update(buffer.subarray(0, bytesRead));
    } while (bytesRead > 0);
  } finally {
    fs.closeSync(descriptor);
  }
  return hash.digest('hex');
}

export function parseResolvedPythonPackages(stdout: string): string[] {
  return stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => /^[A-Za-z0-9_.-]+(?:===|==| @ ).+/.test(line))
    .toSorted((left, right) => left.localeCompare(right));
}

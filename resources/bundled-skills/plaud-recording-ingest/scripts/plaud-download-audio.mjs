#!/usr/bin/env node

import { spawnSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { lookup } from 'node:dns/promises';
import { createReadStream, createWriteStream } from 'node:fs';
import { chmod, link, lstat, mkdir, open, realpath, stat, unlink } from 'node:fs/promises';
import { request as httpsRequest } from 'node:https';
import { isIP } from 'node:net';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';

const args = process.argv.slice(2);

function valueFor(name) {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
}

function fail(message, exitCode = 1) {
  process.stderr.write(`${message}\n`);
  process.exit(exitCode);
}

function sanitizedCliEnvironment() {
  const allowedKeys = [
    'PATH',
    'HOME',
    'USER',
    'LOGNAME',
    'TMPDIR',
    'LANG',
    'LC_ALL',
    'LC_CTYPE',
    'SSL_CERT_FILE',
    'NODE_EXTRA_CA_CERTS',
  ];
  const environment = {};
  for (const key of allowedKeys) {
    if (process.env[key]) environment[key] = process.env[key];
  }
  environment.PLAUD_TELEMETRY_DISABLED = '1';
  environment.DO_NOT_TRACK = '1';
  environment.NO_COLOR = '1';
  environment.FORCE_COLOR = '0';
  return environment;
}

function stripAnsi(value) {
  return String(value).replace(/\x1B\[[0-?]*[ -/]*[@-~]/gu, '');
}

function isPrivateIpv4(address) {
  const parts = address.split('.').map(Number);
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) {
    return true;
  }
  const [a, b] = parts;
  return (
    a === 0 ||
    a === 10 ||
    a === 127 ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 198 && (b === 18 || b === 19)) ||
    a >= 224
  );
}

function isPrivateIp(address) {
  const normalized = address.toLowerCase();
  if (normalized.includes('.')) {
    const mapped = normalized.match(/::ffff:(\d+\.\d+\.\d+\.\d+)$/u);
    return isPrivateIpv4(mapped?.[1] ?? normalized);
  }
  if (normalized === '::' || normalized === '::1') return true;
  if (normalized.startsWith('fc') || normalized.startsWith('fd')) return true;
  if (/^fe[89ab]/u.test(normalized)) return true;
  return normalized.startsWith('2001:db8:');
}

async function resolvePinnedPublicTarget(url) {
  if (!(url instanceof URL) || url.protocol !== 'https:') {
    fail('PLAUD returned a non-HTTPS audio destination.');
  }

  const hostname = url.hostname.toLowerCase();
  if (
    !hostname ||
    isIP(hostname) !== 0 ||
    hostname === 'localhost' ||
    hostname.endsWith('.localhost') ||
    hostname.endsWith('.local')
  ) {
    fail('PLAUD returned an invalid or local audio destination.');
  }

  let addresses;
  try {
    addresses = await lookup(hostname, { all: true, verbatim: true });
  } catch {
    fail('The audio destination could not be resolved safely.');
  }
  if (!addresses.length || addresses.some(({ address }) => isPrivateIp(address))) {
    fail('The audio destination resolved to a non-public network address.');
  }

  return addresses.find(({ family }) => family === 4) ?? addresses[0];
}

function requestPinned(url, pinnedTarget, signal) {
  return new Promise((resolvePromise, rejectPromise) => {
    const pinnedLookup = (_hostname, options, callback) => {
      let lookupOptions = options;
      let done = callback;
      if (typeof options === 'function') {
        done = options;
        lookupOptions = {};
      }
      if (lookupOptions?.all) {
        done(null, [pinnedTarget]);
        return;
      }
      done(null, pinnedTarget.address, pinnedTarget.family);
    };

    const request = httpsRequest(
      url,
      {
        method: 'GET',
        lookup: pinnedLookup,
        servername: url.hostname,
        signal,
        headers: {
          Accept: 'audio/*, application/octet-stream;q=0.9',
          'User-Agent': 'Command-EVE-PLAUD-Ingest/1',
        },
      },
      resolvePromise
    );
    request.once('error', rejectPromise);
    request.end();
  });
}

function headerValue(headers, name) {
  const value = headers[name];
  return Array.isArray(value) ? value[0] : value;
}

async function requestWithSafeRedirects(initialUrl, signal) {
  let currentUrl = initialUrl;
  for (let redirectCount = 0; redirectCount <= 5; redirectCount += 1) {
    const pinnedTarget = await resolvePinnedPublicTarget(currentUrl);
    let response;
    try {
      response = await requestPinned(currentUrl, pinnedTarget, signal);
    } catch {
      fail('The audio download request failed without writing the signed URL to logs.');
    }

    const statusCode = response.statusCode ?? 0;
    if (![301, 302, 303, 307, 308].includes(statusCode)) {
      return response;
    }

    const location = headerValue(response.headers, 'location');
    response.resume();
    if (!location) fail('The audio download returned an invalid redirect.');
    try {
      currentUrl = new URL(location, currentUrl);
    } catch {
      fail('The audio download returned an invalid redirect destination.');
    }
  }
  fail('The audio download exceeded the redirect limit.');
}

async function detectAudioFormat(path) {
  const handle = await open(path, 'r');
  try {
    const buffer = Buffer.alloc(16);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    const head = buffer.subarray(0, bytesRead);
    if (head.subarray(0, 3).toString('ascii') === 'ID3') return 'mp3';
    if (head.length >= 2 && head[0] === 0xff && (head[1] & 0xe0) === 0xe0) return 'mp3';
    if (head.subarray(0, 4).toString('ascii') === 'RIFF' && head.subarray(8, 12).toString('ascii') === 'WAVE') {
      return 'wav';
    }
    if (head.subarray(0, 4).toString('ascii') === 'OggS') return 'ogg';
    if (head.subarray(0, 4).toString('ascii') === 'fLaC') return 'flac';
    if (head.subarray(4, 8).toString('ascii') === 'ftyp') return 'mp4-audio-container';
    return null;
  } finally {
    await handle.close();
  }
}

async function hashFile(path) {
  const hash = createHash('sha256');
  let bytes = 0;
  for await (const chunk of createReadStream(path)) {
    bytes += chunk.length;
    hash.update(chunk);
  }
  return { bytes, sha256: hash.digest('hex') };
}

function isWithinRoot(root, candidate) {
  const pathFromRoot = relative(root, candidate);
  return pathFromRoot !== '..' && !pathFromRoot.startsWith(`..${sep}`) && !isAbsolute(pathFromRoot);
}

async function ensurePrivateDirectory(path, root) {
  await mkdir(path, { mode: 0o700 }).catch((error) => {
    if (error?.code !== 'EEXIST') throw error;
  });
  const pathStat = await lstat(path);
  if (pathStat.isSymbolicLink() || !pathStat.isDirectory()) {
    fail('A recording data directory is not a real directory.', 2);
  }
  if ((pathStat.mode & 0o077) !== 0) {
    fail('Every recording data directory must be private (mode 0700).', 2);
  }
  const canonicalPath = await realpath(path);
  if (!isWithinRoot(root, canonicalPath)) {
    fail('A recording data directory escaped the trusted data root.', 2);
  }
  return canonicalPath;
}

function printReport(report) {
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
}

if (args.includes('--help') || args.includes('-h')) {
  process.stdout.write(
    'Usage: node plaud-download-audio.mjs --file-id <id> --data-root <absolute-existing-private-directory> [--expected-sha256 <hex>] [--plaud-cli <path>] [--max-bytes <bytes>]\n'
  );
  process.exit(0);
}

const fileId = valueFor('--file-id');
const dataRootArg = valueFor('--data-root');
const expectedSha256 = valueFor('--expected-sha256')?.toLowerCase();
const plaudCli = valueFor('--plaud-cli') ?? process.env.PLAUD_CLI ?? 'plaud';
const maxBytesRaw = valueFor('--max-bytes') ?? '2147483648';
const maxBytes = Number(maxBytesRaw);

if (!fileId || !/^[A-Za-z0-9_-]{8,128}$/.test(fileId)) {
  fail('A valid --file-id is required.', 2);
}
if (!dataRootArg || !isAbsolute(dataRootArg)) {
  fail('--data-root must be an absolute existing private directory.', 2);
}
if (expectedSha256 && !/^[a-f0-9]{64}$/u.test(expectedSha256)) {
  fail('--expected-sha256 must be a 64-character hexadecimal digest.', 2);
}
if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0) {
  fail('--max-bytes must be a positive safe integer.', 2);
}

let trustedDataRoot;
try {
  const requestedRoot = resolve(dataRootArg);
  const rootStat = await lstat(requestedRoot);
  if (rootStat.isSymbolicLink() || !rootStat.isDirectory()) {
    fail('The trusted data root must be a real directory.', 2);
  }
  if ((rootStat.mode & 0o077) !== 0) {
    fail('The trusted data root must be private (mode 0700).', 2);
  }
  trustedDataRoot = await realpath(requestedRoot);
} catch {
  fail('Unable to validate the trusted private data root.');
}

let recordingDirectory;
try {
  const plaudDirectory = await ensurePrivateDirectory(resolve(trustedDataRoot, 'plaud-recordings'), trustedDataRoot);
  recordingDirectory = await ensurePrivateDirectory(resolve(plaudDirectory, fileId), trustedDataRoot);
} catch {
  fail('Unable to prepare the private recording directory.');
}

const outputPath = resolve(recordingDirectory, `${fileId}.audio`);
const temporaryPath = resolve(recordingDirectory, `.${fileId}.${randomUUID()}.part`);

try {
  const existingStat = await lstat(outputPath);
  if (existingStat.isSymbolicLink() || !existingStat.isFile()) {
    fail('The existing recording artifact is not a regular file.', 2);
  }
  await chmod(outputPath, 0o600);
  const detectedAudioFormat = await detectAudioFormat(outputPath);
  if (!detectedAudioFormat) fail('The existing recording artifact is not supported audio.', 2);
  const existing = await hashFile(outputPath);
  if (expectedSha256 && existing.sha256 !== expectedSha256) {
    fail('The existing recording artifact does not match the expected SHA-256.', 2);
  }
  printReport({
    schema_version: 1,
    source: 'plaud',
    source_file_id: fileId,
    output_path: outputPath,
    bytes: existing.bytes,
    sha256: existing.sha256,
    detected_audio_format: detectedAudioFormat,
    reused_existing: true,
    source_revalidated: false,
    cli_telemetry_disabled: true,
    signed_url_logged: false,
  });
  process.exit(0);
} catch (error) {
  if (error?.code !== 'ENOENT') fail('Unable to validate or reuse the existing recording artifact.');
}

const cliResult = spawnSync(plaudCli, ['audio', fileId], {
  encoding: 'utf8',
  timeout: 30_000,
  maxBuffer: 1024 * 1024,
  shell: false,
  env: sanitizedCliEnvironment(),
});
if (cliResult.error || cliResult.status !== 0) {
  fail('PLAUD could not provide an audio download URL. Check authentication and audio readiness.');
}

const outputLines = stripAnsi(cliResult.stdout)
  .split(/\r?\n/u)
  .map((line) => line.trim());
const markerIndex = outputLines.indexOf('Audio Download URL:');
const urlLine = markerIndex >= 0 ? outputLines.slice(markerIndex + 1).find(Boolean) : undefined;

let audioUrl;
try {
  audioUrl = new URL(urlLine);
  if (audioUrl.protocol !== 'https:') fail('PLAUD returned a non-HTTPS audio URL.');
} catch {
  fail('PLAUD returned no valid audio URL. The recording may still be synchronizing.');
}

const response = await requestWithSafeRedirects(audioUrl, AbortSignal.timeout(120_000));
const statusCode = response.statusCode ?? 0;
if (statusCode < 200 || statusCode >= 300) {
  response.resume();
  fail(`The audio download failed with HTTP ${statusCode}.`);
}

const contentLength = Number(headerValue(response.headers, 'content-length') ?? '0');
if (Number.isFinite(contentLength) && contentLength > maxBytes) {
  response.destroy();
  fail('The audio download exceeds the configured size limit.');
}

const hash = createHash('sha256');
let bytes = 0;
const meter = new Transform({
  transform(chunk, _encoding, callback) {
    bytes += chunk.length;
    if (bytes > maxBytes) {
      callback(new Error('MAX_BYTES_EXCEEDED'));
      return;
    }
    hash.update(chunk);
    callback(null, chunk);
  },
});

try {
  await pipeline(response, meter, createWriteStream(temporaryPath, { flags: 'wx', mode: 0o600 }));
  await chmod(temporaryPath, 0o600);
} catch {
  await unlink(temporaryPath).catch(() => {});
  fail('The audio download could not be completed safely.');
}

if (bytes === 0) {
  await unlink(temporaryPath).catch(() => {});
  fail('PLAUD returned an empty audio file.');
}

let detectedAudioFormat;
try {
  detectedAudioFormat = await detectAudioFormat(temporaryPath);
} catch {
  await unlink(temporaryPath).catch(() => {});
  fail('The downloaded file could not be inspected safely.');
}
if (!detectedAudioFormat) {
  await unlink(temporaryPath).catch(() => {});
  fail('The downloaded file does not have a supported audio signature.');
}

const sha256 = hash.digest('hex');
if (expectedSha256 && sha256 !== expectedSha256) {
  await unlink(temporaryPath).catch(() => {});
  fail('The downloaded recording does not match the expected SHA-256.', 2);
}

try {
  await link(temporaryPath, outputPath);
  await unlink(temporaryPath);
} catch {
  await unlink(temporaryPath).catch(() => {});
  fail('The verified audio file could not be published atomically.');
}

printReport({
  schema_version: 1,
  source: 'plaud',
  source_file_id: fileId,
  output_path: outputPath,
  bytes,
  sha256,
  detected_audio_format: detectedAudioFormat,
  content_type: headerValue(response.headers, 'content-type') ?? 'unknown',
  reused_existing: false,
  source_revalidated: true,
  cli_telemetry_disabled: true,
  signed_url_logged: false,
});

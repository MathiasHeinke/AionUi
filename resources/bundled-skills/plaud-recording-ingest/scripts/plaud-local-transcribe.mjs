#!/usr/bin/env node

import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import {
  chmod,
  link,
  lstat,
  mkdir,
  open,
  readFile,
  realpath,
  unlink,
} from 'node:fs/promises';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';

export const DEFAULT_MLX_MODEL = 'mlx-community/whisper-large-v3-turbo';
export const MLX_PACKAGE = 'mlx-whisper';

const OUTPUT_FILES = Object.freeze({
  json: 'transcript.raw.json',
  txt: 'transcript.txt',
  srt: 'transcript.srt',
  tsv: 'transcript.tsv',
  vtt: 'transcript.vtt',
});

const ENV_ALLOWLIST = Object.freeze([
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
  'XDG_CACHE_HOME',
  'UV_CACHE_DIR',
  'HF_HOME',
  'HF_HUB_CACHE',
  'TRANSFORMERS_CACHE',
]);

export function isWithinRoot(root, candidate) {
  const pathFromRoot = relative(root, candidate);
  return pathFromRoot !== '..' && !pathFromRoot.startsWith(`..${sep}`) && !isAbsolute(pathFromRoot);
}

export function assertPlaudFileId(value) {
  const fileId = String(value || '');
  if (!/^[A-Za-z0-9_-]{8,128}$/u.test(fileId)) throw new Error('A valid PLAUD file ID is required.');
  return fileId;
}

export function assertLanguage(value) {
  const language = String(value || 'de').trim().toLowerCase();
  if (!/^[a-z]{2,8}(?:-[a-z0-9]{2,8})?$/u.test(language)) {
    throw new Error('Language must be a short language code such as de or en.');
  }
  return language;
}

export function assertModel(value) {
  const model = String(value || DEFAULT_MLX_MODEL).trim();
  if (
    !/^[A-Za-z0-9][A-Za-z0-9._/-]{0,199}$/u.test(model) ||
    model.includes('..') ||
    model.startsWith('/')
  ) {
    throw new Error('Invalid MLX model identity.');
  }
  return model;
}

export function assertAppleSilicon(platform = process.platform, architecture = process.arch) {
  if (platform !== 'darwin' || architecture !== 'arm64') {
    throw new Error('MLX Whisper requires macOS on Apple Silicon; no CPU Whisper fallback was started.');
  }
}

export function sanitizedTranscriptionEnvironment(source = process.env, allowModelDownload = false) {
  const environment = {};
  for (const key of ENV_ALLOWLIST) {
    if (source[key]) environment[key] = source[key];
  }
  environment.HF_HUB_DISABLE_TELEMETRY = '1';
  environment.DO_NOT_TRACK = '1';
  environment.NO_COLOR = '1';
  environment.FORCE_COLOR = '0';
  environment.UV_NO_PROGRESS = '1';
  if (!allowModelDownload) {
    environment.UV_OFFLINE = '1';
    environment.HF_HUB_OFFLINE = '1';
  }
  return environment;
}

export function buildMlxWhisperInvocation({
  uvx = 'uvx',
  audioPath,
  outputDirectory,
  outputName,
  model = DEFAULT_MLX_MODEL,
  language = 'de',
  allowModelDownload = false,
} = {}) {
  if (!audioPath || !isAbsolute(audioPath)) throw new Error('Audio path must be absolute.');
  if (!outputDirectory || !isAbsolute(outputDirectory)) throw new Error('Output directory must be absolute.');
  const fileId = assertPlaudFileId(outputName);
  const checkedModel = assertModel(model);
  const checkedLanguage = assertLanguage(language);
  const args = [];
  if (!allowModelDownload) args.push('--offline');
  args.push(
    '--from',
    MLX_PACKAGE,
    'mlx_whisper',
    audioPath,
    '--model',
    checkedModel,
    '--language',
    checkedLanguage,
    '--task',
    'transcribe',
    '--output-name',
    fileId,
    '--output-dir',
    outputDirectory,
    '--output-format',
    'all',
    '--verbose',
    'True'
  );
  return { command: uvx, args };
}

export function normalizeNonFiniteJsonNumbers(value) {
  const input = String(value);
  let output = '';
  let replacements = 0;
  let inString = false;
  let escaped = false;
  for (let index = 0; index < input.length; index += 1) {
    const character = input[index];
    if (inString) {
      output += character;
      if (escaped) escaped = false;
      else if (character === '\\') escaped = true;
      else if (character === '"') inString = false;
      continue;
    }
    if (character === '"') {
      inString = true;
      output += character;
      continue;
    }
    const remainder = input.slice(index);
    const match = remainder.match(/^(?:-Infinity|Infinity|NaN)(?=\s*[,}\]])/u);
    if (match) {
      output += 'null';
      index += match[0].length - 1;
      replacements += 1;
      continue;
    }
    output += character;
  }
  return { json: output, replacements };
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

async function assertPrivateRoot(path) {
  if (!path || !isAbsolute(path)) throw new Error('--data-root must be an absolute path.');
  const requestedRoot = resolve(path);
  const rootStat = await lstat(requestedRoot);
  if (rootStat.isSymbolicLink() || !rootStat.isDirectory()) {
    throw new Error('The trusted data root must be a real directory.');
  }
  if ((rootStat.mode & 0o077) !== 0) {
    throw new Error('The trusted data root must be private with mode 0700.');
  }
  return realpath(requestedRoot);
}

async function ensurePrivateDirectory(path, trustedRoot) {
  await mkdir(path, { mode: 0o700 }).catch((error) => {
    if (error?.code !== 'EEXIST') throw error;
  });
  const pathStat = await lstat(path);
  if (pathStat.isSymbolicLink() || !pathStat.isDirectory()) {
    throw new Error('A transcription path is not a real directory.');
  }
  if ((pathStat.mode & 0o077) !== 0) {
    throw new Error('Every transcription directory must be private with mode 0700.');
  }
  const canonicalPath = await realpath(path);
  if (!isWithinRoot(trustedRoot, canonicalPath)) {
    throw new Error('A transcription directory escaped the trusted data root.');
  }
  return canonicalPath;
}

async function assertPrivateFile(path, trustedRoot) {
  const fileStat = await lstat(path);
  if (fileStat.isSymbolicLink() || !fileStat.isFile()) throw new Error('Expected a regular private file.');
  const canonicalPath = await realpath(path);
  if (!isWithinRoot(trustedRoot, canonicalPath)) throw new Error('A private file escaped the trusted data root.');
  await chmod(path, 0o600);
  return fileStat;
}

async function publishHardLink(sourcePath, destinationPath, trustedRoot) {
  await assertPrivateFile(sourcePath, trustedRoot);
  try {
    await link(sourcePath, destinationPath);
    await chmod(destinationPath, 0o600);
  } catch (error) {
    if (error?.code !== 'EEXIST') throw error;
    await assertPrivateFile(destinationPath, trustedRoot);
    const [sourceHash, destinationHash] = await Promise.all([hashFile(sourcePath), hashFile(destinationPath)]);
    if (sourceHash.sha256 !== destinationHash.sha256) {
      throw new Error('A canonical transcript artifact already exists with different content.');
    }
  }
}

async function atomicWriteJson(path, value) {
  const temporaryPath = `${path}.${randomUUID()}.part`;
  const handle = await open(temporaryPath, 'wx', 0o600);
  try {
    await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`, 'utf8');
    await handle.sync();
  } finally {
    await handle.close();
  }
  try {
    await link(temporaryPath, path);
  } finally {
    await unlink(temporaryPath).catch(() => {});
  }
  await chmod(path, 0o600);
}

async function canonicalizeOutputs({ transcriptionDirectory, fileId, trustedRoot }) {
  const artifacts = {};
  for (const [extension, canonicalName] of Object.entries(OUTPUT_FILES)) {
    const generatedPath = resolve(transcriptionDirectory, `${fileId}.${extension}`);
    const canonicalPath = resolve(transcriptionDirectory, canonicalName);
    try {
      await assertPrivateFile(generatedPath, trustedRoot);
      await publishHardLink(generatedPath, canonicalPath, trustedRoot);
      artifacts[canonicalName] = await hashFile(canonicalPath);
    } catch (error) {
      if (error?.code === 'ENOENT' && !['json', 'txt'].includes(extension)) continue;
      throw error;
    }
  }
  if (!artifacts['transcript.raw.json'] || !artifacts['transcript.txt']) {
    throw new Error('MLX Whisper did not produce the required JSON and TXT artifacts.');
  }
  return artifacts;
}

async function transcriptCounts(transcriptionDirectory) {
  const [rawJson, text] = await Promise.all([
    readFile(resolve(transcriptionDirectory, OUTPUT_FILES.json), 'utf8'),
    readFile(resolve(transcriptionDirectory, OUTPUT_FILES.txt), 'utf8'),
  ]);
  let parsed;
  let nonFiniteValuesNormalized = 0;
  try {
    parsed = JSON.parse(rawJson);
  } catch {
    const normalized = normalizeNonFiniteJsonNumbers(rawJson);
    nonFiniteValuesNormalized = normalized.replacements;
    if (nonFiniteValuesNormalized === 0) throw new Error('The MLX Whisper JSON artifact is invalid.');
    try {
      parsed = JSON.parse(normalized.json);
    } catch {
      throw new Error('The MLX Whisper JSON artifact is invalid after safe non-finite normalization.');
    }
  }
  const segments = Array.isArray(parsed) ? parsed.length : Array.isArray(parsed?.segments) ? parsed.segments.length : 0;
  return {
    segments,
    characters: text.length,
    rawJsonStandard: nonFiniteValuesNormalized === 0,
    nonFiniteValuesNormalized,
  };
}

async function runMlxWhisper({ invocation, environment, logPath }) {
  const logHandle = await open(logPath, 'wx', 0o600);
  try {
    const status = await new Promise((resolvePromise, rejectPromise) => {
      const child = spawn(invocation.command, invocation.args, {
        cwd: resolve(logPath, '..'),
        shell: false,
        env: environment,
        stdio: ['ignore', logHandle.fd, logHandle.fd],
      });
      child.once('error', rejectPromise);
      child.once('exit', (code, signal) => resolvePromise({ code, signal }));
    });
    if (status.code !== 0) {
      throw new Error(`MLX Whisper exited unsuccessfully${status.signal ? ` after ${status.signal}` : ''}.`);
    }
  } finally {
    await logHandle.close();
  }
  await chmod(logPath, 0o600);
}

async function verifyExistingReceipt({ receiptPath, fileId, audio, model, language, trustedRoot }) {
  let receipt;
  try {
    await assertPrivateFile(receiptPath, trustedRoot);
    receipt = JSON.parse(await readFile(receiptPath, 'utf8'));
  } catch (error) {
    if (error?.code === 'ENOENT') return null;
    throw new Error('The existing transcription receipt is invalid.');
  }
  if (
    receipt?.source_file_id !== fileId ||
    receipt?.audio_sha256 !== audio.sha256 ||
    receipt?.model !== model ||
    receipt?.language !== language
  ) {
    throw new Error('The existing transcription receipt does not match this audio or model configuration.');
  }
  for (const [name, expected] of Object.entries(receipt.artifacts || {})) {
    if (!Object.values(OUTPUT_FILES).includes(name)) throw new Error('The receipt names an unsupported artifact.');
    const artifactPath = resolve(receiptPath, '..', name);
    await assertPrivateFile(artifactPath, trustedRoot);
    const observed = await hashFile(artifactPath);
    if (observed.sha256 !== expected.sha256 || observed.bytes !== expected.bytes) {
      throw new Error('An existing transcript artifact failed receipt verification.');
    }
  }
  return receipt;
}

export async function transcribePlaudRecording({
  fileId,
  dataRoot,
  language = 'de',
  model = DEFAULT_MLX_MODEL,
  uvx = 'uvx',
  allowModelDownload = false,
  adoptExisting = false,
} = {}) {
  assertAppleSilicon();
  const checkedFileId = assertPlaudFileId(fileId);
  const checkedLanguage = assertLanguage(language);
  const checkedModel = assertModel(model);
  const trustedRoot = await assertPrivateRoot(dataRoot);
  const plaudRoot = await ensurePrivateDirectory(resolve(trustedRoot, 'plaud-recordings'), trustedRoot);
  const recordingDirectory = await ensurePrivateDirectory(resolve(plaudRoot, checkedFileId), trustedRoot);
  const audioPath = resolve(recordingDirectory, `${checkedFileId}.audio`);
  const audioStat = await assertPrivateFile(audioPath, trustedRoot);
  if (audioStat.size <= 0) throw new Error('The verified audio file is empty.');
  const audio = await hashFile(audioPath);
  const transcriptionDirectory = await ensurePrivateDirectory(
    resolve(recordingDirectory, 'transcription'),
    trustedRoot
  );
  const receiptPath = resolve(transcriptionDirectory, 'transcription.receipt.json');
  const existingReceipt = await verifyExistingReceipt({
    receiptPath,
    fileId: checkedFileId,
    audio,
    model: checkedModel,
    language: checkedLanguage,
    trustedRoot,
  });
  if (existingReceipt) {
    return {
      ...existingReceipt,
      receipt_path: receiptPath,
      output_directory: transcriptionDirectory,
      reused_existing: true,
      content_included: false,
    };
  }

  const generatedJsonPath = resolve(transcriptionDirectory, `${checkedFileId}.json`);
  let generatedArtifactsExist = false;
  try {
    await assertPrivateFile(generatedJsonPath, trustedRoot);
    generatedArtifactsExist = true;
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }
  if (generatedArtifactsExist && !adoptExisting) {
    throw new Error('Existing unreceipted transcript artifacts require --adopt-existing after provenance review.');
  }

  let execution = 'adopted_existing';
  let logPath = null;
  if (!generatedArtifactsExist) {
    execution = 'mlx_whisper';
    logPath = resolve(transcriptionDirectory, `mlx-whisper.${randomUUID()}.log`);
    const invocation = buildMlxWhisperInvocation({
      uvx,
      audioPath,
      outputDirectory: transcriptionDirectory,
      outputName: checkedFileId,
      model: checkedModel,
      language: checkedLanguage,
      allowModelDownload,
    });
    await runMlxWhisper({
      invocation,
      environment: sanitizedTranscriptionEnvironment(process.env, allowModelDownload),
      logPath,
    });
  }

  const artifacts = await canonicalizeOutputs({
    transcriptionDirectory,
    fileId: checkedFileId,
    trustedRoot,
  });
  const counts = await transcriptCounts(transcriptionDirectory);
  const createdAt = new Date().toISOString();
  const receipt = {
    schema_version: 1,
    source: 'plaud',
    source_file_id: checkedFileId,
    processing_state: 'transcribed',
    provider: 'mlx-whisper',
    model: checkedModel,
    language: checkedLanguage,
    audio_sha256: audio.sha256,
    audio_bytes: audio.bytes,
    transcript_segments: counts.segments,
    transcript_characters: counts.characters,
    raw_json_standard: counts.rawJsonStandard,
    non_finite_values_normalized_for_counts: counts.nonFiniteValuesNormalized,
    artifacts,
    execution,
    offline_requested: !allowModelDownload,
    model_download_allowed: allowModelDownload,
    created_at: createdAt,
    plaud_ai_minutes_consumed: 0,
    content_included: false,
  };
  await atomicWriteJson(receiptPath, receipt);
  return {
    ...receipt,
    receipt_path: receiptPath,
    output_directory: transcriptionDirectory,
    log_path: logPath,
    reused_existing: false,
  };
}

function valueFor(args, name) {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
}

function help() {
  process.stdout.write(
    'Usage: node plaud-local-transcribe.mjs --file-id <id> --data-root <absolute-private-root> [--language de] [--model <mlx-model>] [--uvx <path>] [--allow-model-download] [--adopt-existing]\n'
  );
}

async function main() {
  const args = process.argv.slice(2);
  if (args.includes('--help') || args.includes('-h')) {
    help();
    return;
  }
  try {
    const report = await transcribePlaudRecording({
      fileId: valueFor(args, '--file-id'),
      dataRoot: valueFor(args, '--data-root'),
      language: valueFor(args, '--language') || 'de',
      model: valueFor(args, '--model') || DEFAULT_MLX_MODEL,
      uvx: valueFor(args, '--uvx') || process.env.UVX_CLI || 'uvx',
      allowModelDownload: args.includes('--allow-model-download'),
      adoptExisting: args.includes('--adopt-existing'),
    });
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : 'Local transcription failed.'}\n`);
    process.exitCode = 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}

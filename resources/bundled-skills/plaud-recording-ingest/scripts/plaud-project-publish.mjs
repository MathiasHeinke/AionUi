#!/usr/bin/env node

import { createHash, randomUUID } from 'node:crypto';
import { constants as fsConstants, createReadStream } from 'node:fs';
import {
  chmod,
  copyFile,
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

const PROJECT_ARTIFACTS = Object.freeze([
  'summary.md',
  'decisions.md',
  'open-questions.md',
  'actions.json',
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

export function dateFromCapturedAt(value) {
  const capturedAt = String(value || '');
  const parsed = new Date(capturedAt);
  if (!capturedAt || Number.isNaN(parsed.valueOf())) throw new Error('--captured-at must be an ISO 8601 timestamp.');
  const date = parsed.toISOString().slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/u.test(date)) throw new Error('Unable to derive a capture date.');
  return { capturedAt: parsed.toISOString(), date };
}

export function assertRelativeBase(value = 'docs/conversations') {
  const relativeBase = String(value || 'docs/conversations').trim();
  if (!relativeBase || isAbsolute(relativeBase) || relativeBase.includes('\\')) {
    throw new Error('--relative-dir must be a relative project directory.');
  }
  const segments = relativeBase.split('/');
  if (segments.some((segment) => !segment || segment === '.' || segment === '..')) {
    throw new Error('--relative-dir cannot contain empty or traversal segments.');
  }
  if (segments.some((segment) => !/^[A-Za-z0-9._ -]{1,128}$/u.test(segment))) {
    throw new Error('--relative-dir contains an unsupported path segment.');
  }
  return segments;
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

async function assertRealRoot(path, { privateRoot = false } = {}) {
  if (!path || !isAbsolute(path)) throw new Error('A required root path is not absolute.');
  const requestedRoot = resolve(path);
  const rootStat = await lstat(requestedRoot);
  if (rootStat.isSymbolicLink() || !rootStat.isDirectory()) throw new Error('A root must be a real directory.');
  if (privateRoot && (rootStat.mode & 0o077) !== 0) {
    throw new Error('The recording data root must be private with mode 0700.');
  }
  return realpath(requestedRoot);
}

async function assertRegularContainedFile(path, trustedRoot) {
  const fileStat = await lstat(path);
  if (fileStat.isSymbolicLink() || !fileStat.isFile()) throw new Error('An artifact is not a regular file.');
  const canonical = await realpath(path);
  if (!isWithinRoot(trustedRoot, canonical)) throw new Error('An artifact escaped its trusted root.');
  await chmod(path, 0o600);
  return canonical;
}

async function ensurePrivatePath(root, segments, { privateFromIndex = 0 } = {}) {
  let current = root;
  for (let index = 0; index < segments.length; index += 1) {
    const segment = segments[index];
    const candidate = resolve(current, segment);
    if (!isWithinRoot(root, candidate)) throw new Error('The project destination escaped the selected project.');
    await mkdir(candidate, { mode: 0o700 }).catch((error) => {
      if (error?.code !== 'EEXIST') throw error;
    });
    const candidateStat = await lstat(candidate);
    if (candidateStat.isSymbolicLink() || !candidateStat.isDirectory()) {
      throw new Error('A project conversation path is not a real directory.');
    }
    if (index >= privateFromIndex && (candidateStat.mode & 0o077) !== 0) {
      throw new Error('Every project conversation directory must be private with mode 0700.');
    }
    const canonical = await realpath(candidate);
    if (!isWithinRoot(root, canonical)) throw new Error('A project conversation directory escaped the project root.');
    current = canonical;
  }
  return current;
}

async function findSourceArtifact(recordingDirectory, trustedRoot, name) {
  const candidates = [resolve(recordingDirectory, name), resolve(recordingDirectory, 'synthesis', name)];
  for (const candidate of candidates) {
    try {
      await assertRegularContainedFile(candidate, trustedRoot);
      return candidate;
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
    }
  }
  return null;
}

async function publishFile(sourcePath, destinationPath, destinationRoot) {
  const sourceHash = await hashFile(sourcePath);
  try {
    await assertRegularContainedFile(destinationPath, destinationRoot);
    const destinationHash = await hashFile(destinationPath);
    if (destinationHash.sha256 !== sourceHash.sha256 || destinationHash.bytes !== sourceHash.bytes) {
      throw new Error('A project artifact already exists with different content.');
    }
    return { ...destinationHash, reused: true };
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }

  const temporaryPath = `${destinationPath}.${randomUUID()}.part`;
  await copyFile(sourcePath, temporaryPath, fsConstants.COPYFILE_EXCL);
  await chmod(temporaryPath, 0o600);
  const handle = await open(temporaryPath, 'r');
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
  try {
    await link(temporaryPath, destinationPath);
  } finally {
    await unlink(temporaryPath).catch(() => {});
  }
  await chmod(destinationPath, 0o600);
  return { ...sourceHash, reused: false };
}

async function atomicWriteJson(path, value, destinationRoot) {
  const serialized = `${JSON.stringify(value, null, 2)}\n`;
  try {
    await assertRegularContainedFile(path, destinationRoot);
    const existing = await readFile(path, 'utf8');
    if (existing !== serialized) throw new Error('The project recording manifest already differs.');
    return { ...(await hashFile(path)), reused: true };
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }
  const temporaryPath = `${path}.${randomUUID()}.part`;
  const handle = await open(temporaryPath, 'wx', 0o600);
  try {
    await handle.writeFile(serialized, 'utf8');
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
  return { ...(await hashFile(path)), reused: false };
}

export async function publishPlaudProjectArtifacts({
  fileId,
  dataRoot,
  projectRoot,
  capturedAt,
  relativeDirectory = 'docs/conversations',
  includeTranscript = false,
} = {}) {
  const checkedFileId = assertPlaudFileId(fileId);
  const capture = dateFromCapturedAt(capturedAt);
  const relativeSegments = assertRelativeBase(relativeDirectory);
  const trustedDataRoot = await assertRealRoot(dataRoot, { privateRoot: true });
  const trustedProjectRoot = await assertRealRoot(projectRoot);
  const recordingDirectory = resolve(trustedDataRoot, 'plaud-recordings', checkedFileId);
  const recordingStat = await lstat(recordingDirectory);
  if (recordingStat.isSymbolicLink() || !recordingStat.isDirectory()) {
    throw new Error('The private recording directory is invalid.');
  }
  const canonicalRecordingDirectory = await realpath(recordingDirectory);
  if (!isWithinRoot(trustedDataRoot, canonicalRecordingDirectory)) {
    throw new Error('The private recording directory escaped the data root.');
  }

  const destination = await ensurePrivatePath(
    trustedProjectRoot,
    [...relativeSegments, capture.date, checkedFileId],
    { privateFromIndex: Math.max(0, relativeSegments.length - 1) }
  );
  const published = {};
  for (const name of PROJECT_ARTIFACTS) {
    const sourcePath = await findSourceArtifact(canonicalRecordingDirectory, trustedDataRoot, name);
    if (!sourcePath) continue;
    published[name] = await publishFile(sourcePath, resolve(destination, name), trustedProjectRoot);
  }

  if (includeTranscript) {
    const transcriptCandidates = [
      resolve(canonicalRecordingDirectory, 'transcription', 'transcript.txt'),
      resolve(canonicalRecordingDirectory, 'transcription', `${checkedFileId}.txt`),
    ];
    let transcriptPath = null;
    for (const candidate of transcriptCandidates) {
      try {
        await assertRegularContainedFile(candidate, trustedDataRoot);
        transcriptPath = candidate;
        break;
      } catch (error) {
        if (error?.code !== 'ENOENT') throw error;
      }
    }
    if (!transcriptPath) throw new Error('Transcript publication was requested but no transcript exists.');
    published['transcript.txt'] = await publishFile(
      transcriptPath,
      resolve(destination, 'transcript.txt'),
      trustedProjectRoot
    );
  }

  if (Object.keys(published).length === 0) {
    throw new Error('No approved summary, decision, question, action, or transcript artifact is available.');
  }

  const manifest = {
    schema_version: 1,
    source: 'plaud',
    source_file_id: checkedFileId,
    captured_at: capture.capturedAt,
    project_date: capture.date,
    artifacts: Object.fromEntries(
      Object.entries(published).map(([name, artifact]) => [name, { sha256: artifact.sha256, bytes: artifact.bytes }])
    ),
    source_audio_copied: false,
    transcript_included: includeTranscript,
    external_actions_executed: false,
    plaud_ai_minutes_consumed: 0,
  };
  const manifestArtifact = await atomicWriteJson(
    resolve(destination, 'recording.json'),
    manifest,
    trustedProjectRoot
  );
  published['recording.json'] = manifestArtifact;

  return {
    schema_version: 1,
    source: 'plaud',
    source_file_id: checkedFileId,
    processing_state: 'projected',
    project_root: trustedProjectRoot,
    destination,
    artifacts: published,
    source_audio_copied: false,
    transcript_included: includeTranscript,
    external_actions_executed: false,
    plaud_ai_minutes_consumed: 0,
    content_included: false,
  };
}

function valueFor(args, name) {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
}

function help() {
  process.stdout.write(
    'Usage: node plaud-project-publish.mjs --file-id <id> --data-root <absolute-private-root> --project-root <absolute-project-root> --captured-at <ISO-8601> [--relative-dir docs/conversations] [--include-transcript]\n'
  );
}

async function main() {
  const args = process.argv.slice(2);
  if (args.includes('--help') || args.includes('-h')) {
    help();
    return;
  }
  try {
    const report = await publishPlaudProjectArtifacts({
      fileId: valueFor(args, '--file-id'),
      dataRoot: valueFor(args, '--data-root'),
      projectRoot: valueFor(args, '--project-root'),
      capturedAt: valueFor(args, '--captured-at'),
      relativeDirectory: valueFor(args, '--relative-dir') || 'docs/conversations',
      includeTranscript: args.includes('--include-transcript'),
    });
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : 'Project publication failed.'}\n`);
    process.exitCode = 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}

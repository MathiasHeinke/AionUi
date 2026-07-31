import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, realpath, stat, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  assertRelativeBase,
  dateFromCapturedAt,
  publishPlaudProjectArtifacts,
} from './plaud-project-publish.mjs';

async function privateDirectory(parent, name) {
  const directory = path.join(parent, name);
  await mkdir(directory, { mode: 0o700 });
  return directory;
}

async function privateFile(file, contents) {
  await writeFile(file, contents, { mode: 0o600 });
}

test('normalizes the capture date and rejects project path traversal', () => {
  assert.deepEqual(dateFromCapturedAt('2026-07-31T20:15:00+02:00'), {
    capturedAt: '2026-07-31T18:15:00.000Z',
    date: '2026-07-31',
  });
  assert.deepEqual(assertRelativeBase('docs/conversations'), ['docs', 'conversations']);
  assert.throws(() => assertRelativeBase('../outside'));
  assert.throws(() => assertRelativeBase('/absolute/path'));
});

test('publishes approved artifacts idempotently and never copies source audio', async () => {
  const fixture = await mkdtemp(path.join(os.tmpdir(), 'plaud-project-publish-'));
  const dataRoot = await privateDirectory(fixture, 'data');
  const plaudRoot = await privateDirectory(dataRoot, 'plaud-recordings');
  const fileId = 'plaud_file_test_1234';
  const recordingRoot = await privateDirectory(plaudRoot, fileId);
  const transcriptionRoot = await privateDirectory(recordingRoot, 'transcription');
  const projectRoot = await privateDirectory(fixture, 'project');
  await privateFile(path.join(recordingRoot, 'summary.md'), '# Summary\n\nVerified.\n');
  await privateFile(path.join(recordingRoot, 'actions.json'), '{"schema_version":1,"proposals":[]}\n');
  await privateFile(path.join(recordingRoot, `${fileId}.audio`), Buffer.from('ID3private-audio'));
  await privateFile(path.join(transcriptionRoot, 'transcript.txt'), 'Private transcript\n');

  const first = await publishPlaudProjectArtifacts({
    fileId,
    dataRoot,
    projectRoot,
    capturedAt: '2026-07-31T18:15:00.000Z',
  });
  const destination = path.join(await realpath(projectRoot), 'docs', 'conversations', '2026-07-31', fileId);
  assert.equal(first.destination, destination);
  assert.equal(first.source_audio_copied, false);
  assert.equal(first.transcript_included, false);
  assert.equal(await readFile(path.join(destination, 'summary.md'), 'utf8'), '# Summary\n\nVerified.\n');
  await assert.rejects(() => stat(path.join(destination, `${fileId}.audio`)), { code: 'ENOENT' });
  await assert.rejects(() => stat(path.join(destination, 'transcript.txt')), { code: 'ENOENT' });
  assert.equal((await stat(destination)).mode & 0o777, 0o700);
  assert.equal((await stat(path.join(destination, 'summary.md'))).mode & 0o777, 0o600);

  const second = await publishPlaudProjectArtifacts({
    fileId,
    dataRoot,
    projectRoot,
    capturedAt: '2026-07-31T18:15:00.000Z',
  });
  assert.equal(second.artifacts['summary.md'].reused, true);
  assert.equal(second.artifacts['actions.json'].reused, true);
  assert.equal(second.artifacts['recording.json'].reused, true);
});

test('copies a transcript only after explicit inclusion', async () => {
  const fixture = await mkdtemp(path.join(os.tmpdir(), 'plaud-project-transcript-'));
  const dataRoot = await privateDirectory(fixture, 'data');
  const plaudRoot = await privateDirectory(dataRoot, 'plaud-recordings');
  const fileId = 'recording12345678';
  const recordingRoot = await privateDirectory(plaudRoot, fileId);
  const transcriptionRoot = await privateDirectory(recordingRoot, 'transcription');
  const projectRoot = await privateDirectory(fixture, 'project');
  await privateFile(path.join(transcriptionRoot, 'transcript.txt'), 'Approved transcript\n');
  const report = await publishPlaudProjectArtifacts({
    fileId,
    dataRoot,
    projectRoot,
    capturedAt: '2026-07-31T18:15:00.000Z',
    includeTranscript: true,
  });
  assert.equal(report.transcript_included, true);
  assert.equal(
    await readFile(path.join(report.destination, 'transcript.txt'), 'utf8'),
    'Approved transcript\n'
  );
});

test('rejects a symlinked source artifact', async () => {
  const fixture = await mkdtemp(path.join(os.tmpdir(), 'plaud-project-symlink-'));
  const dataRoot = await privateDirectory(fixture, 'data');
  const plaudRoot = await privateDirectory(dataRoot, 'plaud-recordings');
  const fileId = 'recording12345678';
  const recordingRoot = await privateDirectory(plaudRoot, fileId);
  const projectRoot = await privateDirectory(fixture, 'project');
  const outside = path.join(fixture, 'outside.md');
  await privateFile(outside, 'outside\n');
  await symlink(outside, path.join(recordingRoot, 'summary.md'));
  await assert.rejects(
    () =>
      publishPlaudProjectArtifacts({
        fileId,
        dataRoot,
        projectRoot,
        capturedAt: '2026-07-31T18:15:00.000Z',
      }),
    /not a regular file/u
  );
});

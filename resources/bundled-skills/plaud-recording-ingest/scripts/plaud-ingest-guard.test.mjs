import assert from 'node:assert/strict';
import test from 'node:test';

import {
  PLAUD_PINNED_CLI_VERSION,
  PLAUD_PINNED_MCP_VERSION,
  buildPlaudRedactedReceipt,
  classifyPlaudAudioState,
  probePlaudCapability,
} from './plaud-ingest-guard.mjs';

test('pins the verified official PLAUD packages', () => {
  assert.equal(PLAUD_PINNED_CLI_VERSION, '0.3.6');
  assert.equal(PLAUD_PINNED_MCP_VERSION, '0.3.7');
});

test('uses verified download and playback signals over false negative metadata', () => {
  assert.equal(
    classifyPlaudAudioState({ recordingFound: true, metadataAudioReady: false, downloaderSucceeded: true }),
    'downloaded'
  );
  assert.equal(
    classifyPlaudAudioState({ recordingFound: true, metadataAudioReady: false, webPlaybackSucceeded: true }),
    'discovered'
  );
  assert.equal(
    classifyPlaudAudioState({ recordingFound: true, metadataAudioReady: false }),
    'audio_pending'
  );
  assert.equal(classifyPlaudAudioState({ recordingFound: false }), 'failed');
});

test('capability probe returns redacted package and authentication state', () => {
  const calls = [];
  const fakeSpawn = (_command, args) => {
    calls.push(args);
    return args[0] === 'version'
      ? { status: 0, stdout: 'plaud 0.3.6\n' }
      : { status: 0, stdout: 'private user data that must not be returned\n' };
  };
  const report = probePlaudCapability({ spawn: fakeSpawn, env: { PATH: '/bin', PLAUD_TOKEN: 'secret' } });
  assert.equal(report.state, 'ready');
  assert.equal(report.authenticated, true);
  assert.equal(report.required_mcp_version, '0.3.7');
  assert.equal(JSON.stringify(report).includes('private user data'), false);
  assert.deepEqual(calls, [['version'], ['me']]);
});

test('redacted receipt accepts project and connector states without content', () => {
  const receipt = buildPlaudRedactedReceipt({
    processingState: 'actions_proposed',
    sourceFileId: 'plaud_file_test_1234',
    sha256: 'a'.repeat(64),
    bytes: 42,
    artifactIds: ['summary.md', 'actions.json'],
  });
  assert.equal(receipt.processing_state, 'actions_proposed');
  assert.equal(receipt.content_included, false);
  assert.equal(receipt.plaud_ai_minutes_consumed, 0);
});

import assert from 'node:assert/strict';
import test from 'node:test';

import {
  DEFAULT_MLX_MODEL,
  assertAppleSilicon,
  assertLanguage,
  assertModel,
  assertPlaudFileId,
  buildMlxWhisperInvocation,
  normalizeNonFiniteJsonNumbers,
  sanitizedTranscriptionEnvironment,
} from './plaud-local-transcribe.mjs';

test('builds the offline MLX Whisper command with timestamped output formats', () => {
  const invocation = buildMlxWhisperInvocation({
    uvx: '/opt/uvx',
    audioPath: '/private/recording.audio',
    outputDirectory: '/private/transcription',
    outputName: 'plaud_file_test_1234',
  });
  assert.equal(invocation.command, '/opt/uvx');
  assert.deepEqual(invocation.args.slice(0, 4), ['--offline', '--from', 'mlx-whisper', 'mlx_whisper']);
  assert.equal(invocation.args[invocation.args.indexOf('--model') + 1], DEFAULT_MLX_MODEL);
  assert.equal(invocation.args[invocation.args.indexOf('--output-format') + 1], 'all');
  assert.equal(invocation.args[invocation.args.indexOf('--language') + 1], 'de');
});

test('model download opt in removes offline runtime flags', () => {
  const invocation = buildMlxWhisperInvocation({
    audioPath: '/private/recording.audio',
    outputDirectory: '/private/transcription',
    outputName: 'plaud_file_test_1234',
    allowModelDownload: true,
  });
  assert.equal(invocation.args.includes('--offline'), false);
  const environment = sanitizedTranscriptionEnvironment(
    { PATH: '/bin', PLAUD_TOKEN: 'secret', OPENAI_API_KEY: 'secret' },
    true
  );
  assert.equal(environment.PATH, '/bin');
  assert.equal(environment.PLAUD_TOKEN, undefined);
  assert.equal(environment.OPENAI_API_KEY, undefined);
  assert.equal(environment.HF_HUB_OFFLINE, undefined);
  assert.equal(environment.HF_HUB_DISABLE_TELEMETRY, '1');
});

test('offline environment disables package and model network access', () => {
  const environment = sanitizedTranscriptionEnvironment({ PATH: '/bin' }, false);
  assert.equal(environment.UV_OFFLINE, '1');
  assert.equal(environment.HF_HUB_OFFLINE, '1');
  assert.equal(environment.DO_NOT_TRACK, '1');
});

test('rejects path traversal in identities, language, and model names', () => {
  assert.throws(() => assertPlaudFileId('../recording'));
  assert.throws(() => assertLanguage('../../de'));
  assert.throws(() => assertModel('../model'));
  assert.equal(assertPlaudFileId('plaud_file_test_1234'), 'plaud_file_test_1234');
});

test('fails closed outside Apple Silicon instead of starting CPU Whisper', () => {
  assert.doesNotThrow(() => assertAppleSilicon('darwin', 'arm64'));
  assert.throws(() => assertAppleSilicon('darwin', 'x64'), /no CPU Whisper fallback/u);
  assert.throws(() => assertAppleSilicon('linux', 'arm64'), /no CPU Whisper fallback/u);
});

test('normalizes Python non-finite numbers without changing quoted transcript text', () => {
  const result = normalizeNonFiniteJsonNumbers(
    '{"segments":[{"text":"NaN and Infinity stay text","logprob":NaN,"score":-Infinity}]}'
  );
  assert.equal(result.replacements, 2);
  assert.deepEqual(JSON.parse(result.json), {
    segments: [{ text: 'NaN and Infinity stay text', logprob: null, score: null }],
  });
});

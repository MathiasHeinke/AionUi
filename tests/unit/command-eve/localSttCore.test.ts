/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it, vi } from 'vitest';
import path from 'path';
import {
  transcribeLocalSpeech,
  type CommandEveSttRunResult,
  type TranscribeLocalSpeechOptions,
} from '@/process/commandEve/localSttCore';
import type { CommandEveLocalSttRequest } from '@/common/types/provider/speech';

function makeRequest(overrides: Partial<CommandEveLocalSttRequest> = {}): CommandEveLocalSttRequest {
  return {
    audioBuffer: [1, 2, 3, 4],
    file_name: 'speech-input.webm',
    mimeType: 'audio/webm;codecs=opus',
    ...overrides,
  };
}

function harness(run: CommandEveSttRunResult, model?: string) {
  const runner = vi.fn(async (_command: string, args: string[]) =>
    args[1] === 'import tools.transcription_tools' ? { ok: true, stdout: '', stderr: '' } : run
  );
  const writeFile = vi.fn();
  const removeFile = vi.fn();
  const options: TranscribeLocalSpeechOptions = {
    userDataPath: '/tmp/command-eve-test',
    runner,
    writeFile,
    removeFile,
    pythonPath: '/venv/bin/python',
    tmpDir: '/tmp',
    uuid: () => 'fixed-uuid',
  };
  return { runner, writeFile, removeFile, options, model };
}

describe('transcribeLocalSpeech (on-device STT core)', () => {
  it('returns the transcript and pins provider=local on success', async () => {
    const { runner, writeFile, removeFile, options } = harness({
      ok: true,
      stdout: JSON.stringify({ success: true, transcript: '  hallo welt  ', language: 'de' }) + '\n',
      stderr: '',
    });

    const result = await transcribeLocalSpeech(makeRequest({ localModel: 'small' }), options);

    expect(result.text).toBe('hallo welt');
    expect(result.provider).toBe('local');
    expect(result.model).toBe('small');
    expect(result.language).toBe('de');
    // audio written to a temp file, then cleaned up regardless.
    expect(writeFile).toHaveBeenCalledTimes(1);
    expect(removeFile).toHaveBeenCalledTimes(1);
    // the python -c driver is invoked with the audio path + provider + model.
    const [cmd, args] = runner.mock.calls.find(([, runArgs]) => runArgs[1] !== 'import tools.transcription_tools')!;
    expect(cmd).toBe('/venv/bin/python');
    expect(args[0]).toBe('-c');
    expect(args[2]).toBe(path.join('/tmp', 'command-eve-stt-fixed-uuid.webm'));
    expect(args[3]).toBe('local');
    expect(args[4]).toBe('small');
  });

  it('uses the shared product-default local model when none is given', async () => {
    const { runner, options } = harness({
      ok: true,
      stdout: JSON.stringify({ success: true, transcript: 'x' }),
      stderr: '',
    });
    const result = await transcribeLocalSpeech(makeRequest(), options);
    expect(result.model).toBe('small');
    const [, args] = runner.mock.calls.find(([, runArgs]) => runArgs[1] !== 'import tools.transcription_tools')!;
    expect(args[3]).toBe('local');
    expect(args[4]).toBe('small');
  });

  it('routes provider=groq with the key injected into the child env (never logged)', async () => {
    const { runner, options } = harness({
      ok: true,
      stdout: JSON.stringify({ success: true, transcript: 'hallo', provider: 'groq', language: 'de' }),
      stderr: '',
    });
    const result = await transcribeLocalSpeech(makeRequest({ provider: 'groq', groqModel: 'whisper-large-v3-turbo' }), {
      ...options,
      readGroqApiKey: () => 'gsk_test_key',
    });
    expect(result.provider).toBe('groq');
    expect(result.text).toBe('hallo');
    const [, args, runOptions] = runner.mock.calls.find(
      ([, runArgs]) => runArgs[1] !== 'import tools.transcription_tools'
    )!;
    expect(args[3]).toBe('groq');
    expect(args[4]).toBe('whisper-large-v3-turbo');
    // The secret rides ONLY in the per-call child env, not in argv.
    expect(runOptions.extraEnv).toEqual({ GROQ_API_KEY: 'gsk_test_key' });
    expect(args).not.toContain('gsk_test_key');
  });

  it('defaults the groq model to whisper-large-v3-turbo when none is given', async () => {
    const { runner, options } = harness({
      ok: true,
      stdout: JSON.stringify({ success: true, transcript: 'x', provider: 'groq' }),
      stderr: '',
    });
    await transcribeLocalSpeech(makeRequest({ provider: 'groq' }), {
      ...options,
      readGroqApiKey: () => 'gsk_test_key',
    });
    const [, args] = runner.mock.calls.find(([, runArgs]) => runArgs[1] !== 'import tools.transcription_tools')!;
    expect(args[4]).toBe('whisper-large-v3-turbo');
  });

  it('throws STT_GROQ_KEY_MISSING when no key is found (and never runs the subprocess)', async () => {
    const { runner, options } = harness({
      ok: true,
      stdout: JSON.stringify({ success: true, transcript: 'x' }),
      stderr: '',
    });
    await expect(
      transcribeLocalSpeech(makeRequest({ provider: 'groq' }), { ...options, readGroqApiKey: () => null })
    ).rejects.toThrow(/STT_GROQ_KEY_MISSING/);
    expect(runner).not.toHaveBeenCalled();
  });

  it('throws (and still cleans up) when the python reports failure', async () => {
    const { options, removeFile } = harness({
      ok: true,
      stdout: JSON.stringify({ success: false, transcript: '', error: 'model load failed' }),
      stderr: '',
    });
    await expect(transcribeLocalSpeech(makeRequest(), options)).rejects.toThrow(/STT_LOCAL_TRANSCRIPTION_FAILED/);
    expect(removeFile).toHaveBeenCalledTimes(1);
  });

  it('throws STT_LOCAL_PROCESS_FAILED when the subprocess itself errors', async () => {
    const { options } = harness({ ok: false, stdout: '', stderr: 'python not found', error: 'ENOENT' });
    await expect(transcribeLocalSpeech(makeRequest(), options)).rejects.toThrow(/STT_LOCAL_PROCESS_FAILED/);
  });

  it('throws STT_LOCAL_BAD_OUTPUT on non-JSON stdout', async () => {
    const { options } = harness({ ok: true, stdout: 'not json at all', stderr: '' });
    await expect(transcribeLocalSpeech(makeRequest(), options)).rejects.toThrow(/STT_LOCAL_BAD_OUTPUT/);
  });

  it('tolerates extra log lines before the JSON result', async () => {
    const { options } = harness({
      ok: true,
      stdout: 'INFO loading model\nWARNING something\n' + JSON.stringify({ success: true, transcript: 'ok' }),
      stderr: '',
    });
    const result = await transcribeLocalSpeech(makeRequest(), options);
    expect(result.text).toBe('ok');
  });

  it('waits for a cold Hermes install to expose the transcription module before running STT', async () => {
    let probeCalls = 0;
    const runner = vi.fn(async (_command: string, args: string[]) => {
      if (args[1] === 'import tools.transcription_tools') {
        probeCalls += 1;
        return probeCalls < 3
          ? { ok: false, stdout: '', stderr: "ModuleNotFoundError: No module named 'tools'" }
          : { ok: true, stdout: '', stderr: '' };
      }
      return {
        ok: true,
        stdout: JSON.stringify({ success: true, transcript: 'bereit' }),
        stderr: '',
      };
    });

    const result = await transcribeLocalSpeech(makeRequest(), {
      ...harness({ ok: true, stdout: '', stderr: '' }).options,
      runner,
      runtimeReadyPollMs: 0,
      sleep: async () => undefined,
    });

    expect(result.text).toBe('bereit');
    expect(probeCalls).toBe(3);
    expect(runner).toHaveBeenCalledTimes(4);
  });

  it('fails with a bounded readiness error instead of racing a partial venv', async () => {
    const runner = vi.fn(async () => ({
      ok: false,
      stdout: '',
      stderr: "ModuleNotFoundError: No module named 'tools'",
    }));

    await expect(
      transcribeLocalSpeech(makeRequest(), {
        ...harness({ ok: true, stdout: '', stderr: '' }).options,
        runner,
        runtimeReadyTimeoutMs: 0,
        runtimeReadyPollMs: 0,
        sleep: async () => undefined,
      })
    ).rejects.toThrow(/STT_LOCAL_RUNTIME_NOT_READY:.*No module named 'tools'/);
    expect(runner).toHaveBeenCalledTimes(1);
  });
});

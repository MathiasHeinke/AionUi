/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import type {
  CommandEveLocalSttRequest,
  SpeechToTextAudioBuffer,
  SpeechToTextResult,
} from '@/common/types/provider/speech';
import { resolveCommandEveRuntimeBootstrapPaths } from './runtimeBootstrapCore';

// On-device transcription. The audio NEVER leaves the Mac: we hand the bundled
// Hermes venv (which already ships a local faster-whisper STT module,
// tools/transcription_tools.py, DEFAULT_PROVIDER='local') a temp file and read
// back the transcript. No API key, no cloud egress — the DSGVO-clean lane.
//
// The Python entrypoint `transcribe_audio(path, model)` lazy-installs faster-whisper
// on first use and decodes webm/opus via PyAV (no system ffmpeg). config.yaml pins
// `stt.provider: local` so it can never silently fall back to a cloud STT.

const DEFAULT_LOCAL_MODEL = 'base';
const DEFAULT_TIMEOUT_MS = 180_000; // first call may lazy-install + download a model

// Driver: print the transcribe_audio result as a single JSON line. Kept tiny so it
// rides in `python -c` (no bundled script file). argv[1]=audio path, argv[2]=model.
const STT_DRIVER = [
  'import json, sys',
  'try:',
  '    from tools.transcription_tools import transcribe_audio',
  '    p = sys.argv[1]',
  '    m = sys.argv[2] if len(sys.argv) > 2 and sys.argv[2] else None',
  '    res = transcribe_audio(p, m)',
  'except Exception as e:',
  '    res = {"success": False, "transcript": "", "error": repr(e)}',
  'print(json.dumps(res))',
].join('\n');

export type CommandEveSttRunResult = {
  ok: boolean;
  stdout: string;
  stderr: string;
  error?: string;
};

export type CommandEveSttRunner = (
  command: string,
  args: string[],
  options: { timeoutMs: number }
) => Promise<CommandEveSttRunResult>;

export type TranscribeLocalSpeechOptions = {
  userDataPath: string;
  // Injectable seams for tests; default to the real fs/child_process/uuid.
  runner?: CommandEveSttRunner;
  pythonPath?: string;
  tmpDir?: string;
  timeoutMs?: number;
  writeFile?: (filePath: string, data: Buffer) => void;
  removeFile?: (filePath: string) => void;
  uuid?: () => string;
};

function pythonBinary(hermesVenv: string): string {
  return process.platform === 'win32'
    ? path.join(hermesVenv, 'Scripts', 'python.exe')
    : path.join(hermesVenv, 'bin', 'python');
}

function normalizeAudioBuffer(audio: SpeechToTextAudioBuffer): Buffer {
  if (audio instanceof Uint8Array) return Buffer.from(audio);
  if (Array.isArray(audio)) return Buffer.from(audio);
  // Record<string, number> — JSON-serialized byte map; restore in numeric order.
  const ordered = Object.keys(audio)
    .map((k) => Number(k))
    .filter((k) => Number.isFinite(k))
    .sort((a, b) => a - b)
    .map((k) => Number((audio as Record<string, number>)[String(k)]) & 0xff);
  return Buffer.from(ordered);
}

function audioExtension(fileName: string): string {
  const ext = path.extname(fileName).replace('.', '').toLowerCase();
  return ext || 'webm';
}

const defaultRunner: CommandEveSttRunner = (command, args, options) =>
  new Promise((resolve) => {
    execFile(command, args, { timeout: options.timeoutMs, maxBuffer: 8 * 1024 * 1024 }, (error, stdout, stderr) => {
      resolve({
        ok: !error,
        stdout: stdout?.toString() ?? '',
        stderr: stderr?.toString() ?? '',
        error: error ? error.message : undefined,
      });
    });
  });

type PythonSttResult = {
  success?: boolean;
  transcript?: string;
  text?: string;
  error?: string;
  provider?: string;
  language?: string;
  model?: string;
};

/**
 * Transcribe an audio buffer on-device via the bundled venv faster-whisper.
 * Returns a SpeechToTextResult, or throws an Error with a coded message
 * (STT_LOCAL_*) the renderer maps to a friendly status.
 */
export async function transcribeLocalSpeech(
  request: CommandEveLocalSttRequest,
  options: TranscribeLocalSpeechOptions
): Promise<SpeechToTextResult> {
  const paths = resolveCommandEveRuntimeBootstrapPaths(options.userDataPath);
  const python = options.pythonPath ?? pythonBinary(paths.hermesVenv);
  const runner = options.runner ?? defaultRunner;
  const writeFile = options.writeFile ?? ((p, d) => fs.writeFileSync(p, d, { mode: 0o600 }));
  const removeFile =
    options.removeFile ??
    ((p) => {
      try {
        fs.rmSync(p, { force: true });
      } catch {
        /* best-effort cleanup */
      }
    });
  const uuid = options.uuid ?? randomUUID;
  const tmpDir = options.tmpDir ?? os.tmpdir();
  const model = request.localModel || DEFAULT_LOCAL_MODEL;

  const audioPath = path.join(tmpDir, `command-eve-stt-${uuid()}.${audioExtension(request.file_name)}`);

  try {
    writeFile(audioPath, normalizeAudioBuffer(request.audioBuffer));

    const run = await runner(python, ['-c', STT_DRIVER, audioPath, model], {
      timeoutMs: options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    });

    if (!run.ok) {
      throw new Error(`STT_LOCAL_PROCESS_FAILED:${(run.error || run.stderr || 'unknown').slice(0, 200)}`);
    }

    const line = run.stdout.trim().split('\n').filter(Boolean).pop() ?? '';
    let parsed: PythonSttResult;
    try {
      parsed = JSON.parse(line) as PythonSttResult;
    } catch {
      throw new Error(`STT_LOCAL_BAD_OUTPUT:${line.slice(0, 200)}`);
    }

    const text = (parsed.transcript ?? parsed.text ?? '').trim();
    if (parsed.success === false || (!text && parsed.error)) {
      throw new Error(`STT_LOCAL_TRANSCRIPTION_FAILED:${(parsed.error || 'no transcript').slice(0, 200)}`);
    }

    return {
      text,
      provider: 'local',
      model: parsed.model || model,
      language: parsed.language || request.languageHint,
    };
  } finally {
    removeFile(audioPath);
  }
}

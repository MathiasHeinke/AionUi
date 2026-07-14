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

// Venv-routed transcription via the bundled Hermes venv, which ships
// tools/transcription_tools.py with native handlers for both lanes:
//   - 'local' (DEFAULT): faster-whisper ON-DEVICE. The audio NEVER leaves the
//     Mac. No API key, no cloud egress — the DSGVO-clean lane.
//   - 'groq': the Groq Whisper API (whisper-large-v3-turbo, sub-second, strong
//     German). The audio DOES leave the Mac for Groq, and GROQ_API_KEY is read
//     at runtime from ~/.hermes/.env and injected into THIS subprocess's env so
//     the venv's get_env_value() finds it. The key is never bundled, hardcoded,
//     persisted to config.yaml, or logged.
//
// We dispatch the provider PER REQUEST (driver arg), not via config.yaml — that
// stays pinned to `stt.provider: local` as the floor, and the desktop's STT
// setting picks the lane each call.

const DEFAULT_LOCAL_MODEL = 'base';
const DEFAULT_GROQ_MODEL = 'whisper-large-v3-turbo';
const DEFAULT_TIMEOUT_MS = 180_000; // first call may lazy-install + download a model
// Groq is a network round-trip; cap it well under the local model-download ceiling.
const DEFAULT_GROQ_TIMEOUT_MS = 45_000;

// The hermes home that owns ~/.hermes/.env, where the founder stored GROQ_API_KEY.
// This is the user's PRIMARY hermes home (HERMES default), distinct from the
// command-eve seat HERMES_HOME — so we read it explicitly rather than relying on
// the subprocess's HERMES_HOME (which points at the command-eve seat that has no
// .env). Returns null when there is no HOME or no key.
export function readGroqApiKeyFromHermesEnv(): string | null {
  const home = process.env.HOME;
  if (!home) return null;
  const envPath = path.join(home, '.hermes', '.env');
  let raw: string;
  try {
    raw = fs.readFileSync(envPath, 'utf8');
  } catch {
    return null;
  }
  for (const line of raw.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq <= 0) continue;
    const key = trimmed.slice(0, eq).trim();
    if (key !== 'GROQ_API_KEY') continue;
    let value = trimmed.slice(eq + 1).trim();
    // Strip a single pair of surrounding quotes if present.
    if (
      value.length >= 2 &&
      ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'")))
    ) {
      value = value.slice(1, -1);
    }
    return value || null;
  }
  return null;
}

// Driver: print a transcription result as a single JSON line. Kept tiny so it
// rides in `python -c` (no bundled script file).
//   argv[1] = audio path
//   argv[2] = provider ('local' | 'groq')
//   argv[3] = model (faster-whisper size for local; Groq model for groq)
// We dispatch the per-request provider directly to the module's built-in handler
// so config.yaml stays pinned to `local`. Built-in handler names are a stable
// module contract (BUILTIN_STT_PROVIDERS); we still fall back to transcribe_audio
// if the symbols are absent on an older wheel.
const STT_DRIVER = [
  'import json, sys',
  'try:',
  '    import tools.transcription_tools as tt',
  '    p = sys.argv[1]',
  "    provider = sys.argv[2] if len(sys.argv) > 2 and sys.argv[2] else 'local'",
  '    m = sys.argv[3] if len(sys.argv) > 3 and sys.argv[3] else None',
  "    if provider == 'groq' and hasattr(tt, '_transcribe_groq'):",
  '        res = tt._transcribe_groq(p, m or tt.DEFAULT_GROQ_STT_MODEL)',
  "    elif hasattr(tt, '_transcribe_local'):",
  '        res = tt._transcribe_local(p, tt._normalize_local_model(m))',
  '    else:',
  '        res = tt.transcribe_audio(p, m)',
  '    if isinstance(res, dict) and "provider" not in res:',
  '        res["provider"] = provider',
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
  // `extraEnv` carries the per-request secret (GROQ_API_KEY) so it lives ONLY in
  // the child process env for that one call — never on the parent process.env,
  // never logged. Omitted for the local lane.
  options: { timeoutMs: number; extraEnv?: Record<string, string> }
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
  // Injectable seam for tests: resolve GROQ_API_KEY without touching the real
  // ~/.hermes/.env. Defaults to reading that file at runtime.
  readGroqApiKey?: () => string | null;
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

// A GUI app launched from Finder inherits a STRIPPED PATH (typically /usr/bin:/bin only),
// so a system ffmpeg/whisper the transcription may fall back to is invisible. Augment PATH
// with the venv's own bin + the common install locations so the on-device lane stays robust.
const STT_EXTRA_PATH_DIRS = ['/opt/homebrew/bin', '/usr/local/bin', '/usr/bin', '/bin', '/usr/sbin', '/sbin'];

const defaultRunner: CommandEveSttRunner = (command, args, options) =>
  new Promise((resolve) => {
    const homeBin = process.env.HOME ? path.join(process.env.HOME, '.local', 'bin') : '';
    const augmentedPath = [path.dirname(command), homeBin, ...STT_EXTRA_PATH_DIRS, process.env.PATH || '']
      .filter(Boolean)
      .join(':');
    // extraEnv (e.g. GROQ_API_KEY) is scoped to THIS child process only.
    const env = { ...process.env, PATH: augmentedPath, ...options.extraEnv };
    execFile(
      command,
      args,
      { timeout: options.timeoutMs, maxBuffer: 8 * 1024 * 1024, env },
      (error, stdout, stderr) => {
        resolve({
          ok: !error,
          stdout: stdout?.toString() ?? '',
          stderr: stderr?.toString() ?? '',
          error: error ? error.message : undefined,
        });
      }
    );
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
  const provider = request.provider === 'groq' ? 'groq' : 'local';
  const model =
    provider === 'groq' ? request.groqModel || DEFAULT_GROQ_MODEL : request.localModel || DEFAULT_LOCAL_MODEL;

  // Groq: read the key from ~/.hermes/.env at runtime and pass it ONLY into the
  // child env. If it's missing, fail with an actionable code instead of letting
  // the venv emit a raw "GROQ_API_KEY not set" — the renderer maps this to a
  // clear "configure your Groq key" message. The key value is never logged.
  let extraEnv: Record<string, string> | undefined;
  let timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  if (provider === 'groq') {
    const groqKey = (options.readGroqApiKey ?? readGroqApiKeyFromHermesEnv)();
    if (!groqKey) {
      throw new Error('STT_GROQ_KEY_MISSING:GROQ_API_KEY not found in ~/.hermes/.env');
    }
    extraEnv = { GROQ_API_KEY: groqKey };
    timeoutMs = options.timeoutMs ?? DEFAULT_GROQ_TIMEOUT_MS;
  }

  const audioPath = path.join(tmpDir, `command-eve-stt-${uuid()}.${audioExtension(request.file_name)}`);

  try {
    writeFile(audioPath, normalizeAudioBuffer(request.audioBuffer));

    const run = await runner(python, ['-c', STT_DRIVER, audioPath, provider, model], {
      timeoutMs,
      extraEnv,
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
      const code = provider === 'groq' ? 'STT_GROQ_TRANSCRIPTION_FAILED' : 'STT_LOCAL_TRANSCRIPTION_FAILED';
      throw new Error(`${code}:${(parsed.error || 'no transcript').slice(0, 200)}`);
    }

    return {
      text,
      provider,
      model: parsed.model || model,
      language: parsed.language || request.languageHint,
    };
  } finally {
    removeFile(audioPath);
  }
}

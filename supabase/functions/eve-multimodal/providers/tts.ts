import { bytesToBase64 } from './encoding.ts';
import type { FetchLike } from './types.ts';

const XAI_TTS_ENDPOINT = 'https://api.x.ai/v1/tts';
const MAX_TTS_AUDIO_BYTES = 10 * 1024 * 1024;

export function isTtsProviderEnabled(): boolean {
  return Deno.env.get('EVE_MULTIMODAL_ENABLE_XAI_TTS') === 'true';
}

export function ttsTimeoutMs(): number {
  const raw = Deno.env.get('EVE_MULTIMODAL_TTS_TIMEOUT_MS');
  const parsed = raw ? Number(raw) : 30_000;
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 30_000;
}

export async function callXaiTts(args: {
  apiKey: string;
  text: string;
  voiceId: string;
  language: string;
  timeoutMs: number;
  fetchFn: FetchLike;
}): Promise<
  { ok: true; bytes: Uint8Array; mimeType: string } | { ok: false; status: number; reason: string; message: string }
> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), args.timeoutMs);
  try {
    const response = await args.fetchFn(XAI_TTS_ENDPOINT, {
      method: 'POST',
      signal: controller.signal,
      headers: {
        Authorization: `Bearer ${args.apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        text: args.text,
        voice_id: args.voiceId,
        language: args.language,
      }),
    });
    if (!response.ok) {
      return {
        ok: false,
        status: 502,
        reason: 'provider-error',
        message: `xAI TTS returned HTTP ${response.status}.`,
      };
    }

    const mimeType = response.headers.get('content-type');
    if (!mimeType || !mimeType.toLowerCase().startsWith('audio/')) {
      return {
        ok: false,
        status: 502,
        reason: 'provider-error',
        message: 'xAI TTS returned a non-audio content type.',
      };
    }

    const bytes = new Uint8Array(await response.arrayBuffer());
    if (bytes.byteLength === 0) {
      return {
        ok: false,
        status: 502,
        reason: 'provider-empty-audio',
        message: 'xAI TTS returned an empty audio body.',
      };
    }
    if (bytes.byteLength > MAX_TTS_AUDIO_BYTES) {
      return {
        ok: false,
        status: 502,
        reason: 'provider-audio-too-large',
        message: 'xAI TTS returned audio larger than the gateway limit.',
      };
    }

    return {
      ok: true,
      bytes,
      mimeType,
    };
  } catch (err) {
    const aborted = err instanceof DOMException && err.name === 'AbortError';
    return {
      ok: false,
      status: aborted ? 504 : 502,
      reason: aborted ? 'provider-timeout' : 'provider-error',
      message: aborted ? 'xAI TTS timed out.' : 'xAI TTS request failed.',
    };
  } finally {
    clearTimeout(timeout);
  }
}

export { bytesToBase64 };

/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

export async function readCommandEveLimitedResponseText(
  response: Response,
  maxBytes: number
): Promise<{ ok: true; text: string } | { ok: false; reason_code: 'EVE_MULTIMODAL_RESPONSE_TOO_LARGE' }> {
  const contentLength = Number(response.headers.get('content-length') || 0);
  if (Number.isFinite(contentLength) && contentLength > maxBytes) {
    return { ok: false, reason_code: 'EVE_MULTIMODAL_RESPONSE_TOO_LARGE' };
  }

  if (!response.body) {
    const text = await response.text();
    const bytes = new TextEncoder().encode(text).byteLength;
    return bytes > maxBytes ? { ok: false, reason_code: 'EVE_MULTIMODAL_RESPONSE_TOO_LARGE' } : { ok: true, text };
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let text = '';
  let bytesRead = 0;
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      bytesRead += chunk.value.byteLength;
      if (bytesRead > maxBytes) {
        await reader.cancel().catch((): undefined => undefined);
        return { ok: false, reason_code: 'EVE_MULTIMODAL_RESPONSE_TOO_LARGE' };
      }
      text += decoder.decode(chunk.value, { stream: true });
    }
    text += decoder.decode();
    return { ok: true, text };
  } finally {
    reader.releaseLock();
  }
}

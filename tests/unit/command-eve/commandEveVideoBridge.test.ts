/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Bridge-level tests: the desktop actually calls the gateway, sends the bearer,
 * and turns each distinct refusal into a distinct outcome.
 *
 * The assertions that matter most are the negative ones. A lane that reports
 * "failed" for out-of-credits, over-cap, replayed and impossible-resolution alike
 * is a lane that has thrown away everything the server worked to tell it.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

const readLicenseWireMock = vi.fn();
vi.mock('@/common/config/licenseWireAtRest', () => ({
  readLicenseWire: (...args: unknown[]) => readLicenseWireMock(...args),
}));
vi.mock('@process/utils/utils', () => ({ getDataPath: () => '/tmp/eve-data' }));

import { handleCommandEveVideoGenerate } from '@/process/bridge/commandEveVideoBridge';

const deps = (fetchImpl: typeof fetch) => ({
  getDataPath: () => '/tmp/eve-data',
  fetch: fetchImpl,
  newRequestId: () => 'req-fixed',
});

const jsonResponse = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

const okBody = {
  ok: true,
  artifact: { mime_type: 'video/mp4', data_base64: 'AAAA', bytes: 3, sha256: 'c'.repeat(64) },
  video_generation: {
    model: 'grok-imagine-video',
    resolution: '720p',
    tier: 'fast',
    duration_seconds: 5,
    estimated_credits: 700,
  },
};

beforeEach(() => {
  vi.clearAllMocks();
  readLicenseWireMock.mockReturnValue({ ok: true, wire: 'ceve-wire-token' });
});

describe('handleCommandEveVideoGenerate', () => {
  it('sends the bearer and the tier, and returns the resolved artifact', async () => {
    let sentAuth = '';
    let sentBody: Record<string, unknown> = {};
    const fetchMock = vi.fn(async (_url: unknown, init: unknown) => {
      const request = init as { headers: Record<string, string>; body: string };
      sentAuth = request.headers.Authorization;
      sentBody = JSON.parse(request.body);
      return jsonResponse(200, okBody);
    });

    const result = await handleCommandEveVideoGenerate(
      { prompt: 'ein Produktclip', tierId: 'fast', durationSeconds: 5 },
      deps(fetchMock as unknown as typeof fetch)
    );

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(sentAuth).toBe('Bearer ceve-wire-token');
    expect((sentBody.video_generation as Record<string, unknown>).tier).toBe('fast');
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.artifact.resolution).toBe('720p');
    expect(result.artifact.estimatedCredits).toBe(700);
    expect(result.artifact.mimeType).toBe('video/mp4');
  });

  it('never calls the gateway without a licence wire', async () => {
    readLicenseWireMock.mockReturnValue({ ok: false, wire: null });
    const fetchMock = vi.fn(async () => jsonResponse(200, okBody));

    const result = await handleCommandEveVideoGenerate(
      { prompt: 'p', tierId: 'fast', durationSeconds: 5 },
      deps(fetchMock as unknown as typeof fetch)
    );

    expect(fetchMock).not.toHaveBeenCalled();
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reasonCode).toBe('entitlement-not-drawable');
  });

  it.each([
    ['insufficient_credits', 402, false],
    ['spend_cap_exceeded', 402, false],
    ['video-tier-unavailable', 422, false],
    ['request-replayed', 409, false],
    ['video-daily-cap', 429, false],
    ['credit-gate-unavailable', 503, true],
  ])('keeps %s distinguishable end to end', async (reason, status, retryable) => {
    const fetchMock = vi.fn(async () => jsonResponse(status, { ok: false, reason, message: 'server said so' }));

    const result = await handleCommandEveVideoGenerate(
      { prompt: 'p', tierId: 'fast', durationSeconds: 5 },
      deps(fetchMock as unknown as typeof fetch)
    );

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reasonCode).toBe(reason);
    expect(result.retryable).toBe(retryable);
    expect(result.message.length).toBeGreaterThan(0);
  });

  it('does not report success for a 200 with no playable video', async () => {
    const fetchMock = vi.fn(async () =>
      jsonResponse(200, { ...okBody, artifact: { mime_type: 'application/json', data_base64: 'AAAA' } })
    );

    const result = await handleCommandEveVideoGenerate(
      { prompt: 'p', tierId: 'fast', durationSeconds: 5 },
      deps(fetchMock as unknown as typeof fetch)
    );

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reasonCode).toBe('video-artifact-malformed');
  });

  it('turns an aborted request into a timeout, not a silent failure', async () => {
    const fetchMock = vi.fn(async () => {
      const error = new Error('aborted');
      error.name = 'AbortError';
      throw error;
    });

    const result = await handleCommandEveVideoGenerate(
      { prompt: 'p', tierId: 'fast', durationSeconds: 5 },
      deps(fetchMock as unknown as typeof fetch)
    );

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reasonCode).toBe('provider-timeout');
    expect(result.retryable).toBe(true);
  });

  it('survives a non-JSON body without claiming success', async () => {
    const fetchMock = vi.fn(async () => new Response('<html>gateway down</html>', { status: 502 }));

    const result = await handleCommandEveVideoGenerate(
      { prompt: 'p', tierId: 'fast', durationSeconds: 5 },
      deps(fetchMock as unknown as typeof fetch)
    );

    expect(result.ok).toBe(false);
  });

  it('rejects an empty prompt before touching the network', async () => {
    const fetchMock = vi.fn(async () => jsonResponse(200, okBody));

    const result = await handleCommandEveVideoGenerate(
      { prompt: '   ', tierId: 'fast', durationSeconds: 5 },
      deps(fetchMock as unknown as typeof fetch)
    );

    expect(fetchMock).not.toHaveBeenCalled();
    expect(result.ok).toBe(false);
  });
});

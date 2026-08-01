/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * MAT-1747 round 6 — `initCommandEveBridge` really registers the three new
 * providers, and the paid one is closed by default WHERE THE APP REGISTERS IT.
 *
 * WHY THIS FILE EXISTS. `gitnexus detect_changes` (scope compare, base
 * `f2e98d97`) reports risk HIGH and names two affected execution flows rooted at
 * `initCommandEveBridge`:
 *
 *   proc_190 InitCommandEveBridge -> FirstNonEmpty
 *   proc_191 InitCommandEveBridge -> FirstNonEmpty
 *
 * The changed step in both is `initCommandEveBridge` itself, which now registers
 *
 *   command-eve.artifact-context-envelope   (mints the single-use spend permit)
 *   command-eve.artifact-turn-steer         (retires it on a correction)
 *   command-eve.video-edit                  (the only spending route)
 *
 * `commandEveVideoEditBridge.test.ts` is thorough about those handlers, but it
 * imports them directly from `commandEveVideoBridge`. Nothing asserted that the
 * app WIRES them — and this is precisely the seam where MAT-1747 already shipped
 * a real hole once: the renderer IPC lane was registered next to the loopback
 * with no flag gate at all. A handler that is perfect and unregistered, or
 * registered and ungated, both look green from the handler's own test file.
 *
 * So this file drives `initCommandEveBridge()` and then calls what it registered.
 *
 * WHAT THIS DOES NOT PROVE: that Electron ever calls `initCommandEveBridge`.
 * That is `runtimeBridgeRegistration.test.ts`'s territory for the entrypoint and
 * is unchanged by this slice.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const registered = new Map<string, (request?: unknown) => Promise<unknown>>();

vi.mock('@office-ai/platform', () => ({
  bridge: {
    buildProvider: (channel: string) => ({
      provider: (handler: (request?: unknown) => Promise<unknown>) => {
        registered.set(channel, handler);
        return { channel };
      },
    }),
  },
}));

vi.mock('@process/utils/initStorage', () => ({
  ProcessConfig: { get: vi.fn(() => undefined), getSync: vi.fn(() => undefined), set: vi.fn() },
  getSkillsDir: () => '/tmp/command-eve-video-edit-registration/skills',
  getCronSkillsDir: () => '/tmp/command-eve-video-edit-registration/cron-skills',
}));

vi.mock('@process/utils/utils', () => ({ getDataPath: () => '/tmp/command-eve-video-edit-registration' }));

vi.mock('@/common/config/licenseWireAtRest', () => ({
  clearLicenseWire: vi.fn(),
  hasLicenseWire: vi.fn(() => true),
  readLicenseWire: vi.fn(() => ({ ok: true, wire: 'CEVE.v2.synthetic.test' })),
  storeLicenseWire: vi.fn(),
}));

import { initCommandEveBridge } from '@process/bridge/commandEveBridge';
import { COMMAND_EVE_AGENT_VIDEO_EDIT_FLAG } from '@process/commandEve/agentVideoEditFlag';

/** The three channels this slice adds, named once so a rename cannot drift. */
const MAT_1747_CHANNELS = [
  'command-eve.artifact-context-envelope',
  'command-eve.artifact-turn-steer',
  'command-eve.video-edit',
] as const;

type EditEnvelope = { success?: boolean; data?: { ok?: boolean; reasonCode?: string } };

beforeEach(() => {
  registered.clear();
  initCommandEveBridge();
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

describe('MAT-1747 round 6 — the app registers every provider the renderer calls', () => {
  it.each(MAT_1747_CHANNELS)('registers %s', (channel) => {
    expect(registered.has(channel)).toBe(true);
  });

  it('POSITIVE CONTROL: the pre-existing video channels are still registered beside them', () => {
    // If `initCommandEveBridge` had failed to run at all, every assertion above
    // would be vacuously about an empty map. This is what says it ran.
    expect(registered.has('command-eve.video-generate')).toBe(true);
    expect(registered.has('command-eve.video-artifacts-list')).toBe(true);
    expect(registered.size).toBeGreaterThan(10);
  });

  it('NEGATIVE CONTROL: the probe reports false for a channel nobody registers', () => {
    // The mutation check for the three assertions above, done in-suite because
    // the alternative is editing production source to watch it go red. If
    // `registered.has` were satisfied by anything, this would pass too.
    expect(registered.has('command-eve.video-edit-that-does-not-exist')).toBe(false);
  });
});

describe('MAT-1747 round 6 — the REGISTERED paid route is flag-gated, not just the handler', () => {
  it('refuses with video-edit-disabled before any network, on the provider the app actually wired', async () => {
    // THE regression: the renderer IPC lane once reached the identical paid
    // handler with no gate. Driving the registered provider — not the import —
    // is the only way that difference is visible.
    const fetchSpy = vi.fn(async () => new Response('{}', { status: 200 }));
    vi.stubGlobal('fetch', fetchSpy);
    expect(process.env[COMMAND_EVE_AGENT_VIDEO_EDIT_FLAG]).toBeUndefined();

    const provider = registered.get('command-eve.video-edit')!;
    const result = (await provider({
      handle: `evecap_${'a'.repeat(64)}`,
      permit: `evespend_${'b'.repeat(64)}`,
      instruction: 'gib der Aubergine ein Gesicht',
    })) as EditEnvelope;

    expect(result.success).toBe(true);
    expect(result.data?.ok).toBe(false);
    expect(result.data?.reasonCode).toBe('video-edit-disabled');
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('DISCRIMINATING CONTROL: with the flag ON the identical request is refused for a DIFFERENT reason', async () => {
    // Without this, `video-edit-disabled` could be a catch-all this provider
    // returns for any bad request, and the flag would be proving nothing. The
    // request still carries a handle that was never minted, so it is refused
    // again — by the authority checks, before the network, exactly as
    // `commandEveVideoEditBridge.test.ts` pins them. Nothing is spent here.
    const fetchSpy = vi.fn(async () => new Response('{}', { status: 200 }));
    vi.stubGlobal('fetch', fetchSpy);
    const previous = process.env[COMMAND_EVE_AGENT_VIDEO_EDIT_FLAG];
    process.env[COMMAND_EVE_AGENT_VIDEO_EDIT_FLAG] = '1';
    try {
      const provider = registered.get('command-eve.video-edit')!;
      const result = (await provider({
        handle: `evecap_${'a'.repeat(64)}`,
        permit: `evespend_${'b'.repeat(64)}`,
        instruction: 'gib der Aubergine ein Gesicht',
      })) as EditEnvelope;

      expect(result.data?.ok).toBe(false);
      expect(result.data?.reasonCode).not.toBe('video-edit-disabled');
      expect(fetchSpy).not.toHaveBeenCalled();
    } finally {
      if (previous === undefined) delete process.env[COMMAND_EVE_AGENT_VIDEO_EDIT_FLAG];
      else process.env[COMMAND_EVE_AGENT_VIDEO_EDIT_FLAG] = previous;
    }
    // The flag is put back, so the file leaves the process closed for every
    // suite that runs after it.
    expect(process.env[COMMAND_EVE_AGENT_VIDEO_EDIT_FLAG]).toBeUndefined();
  });

  it('refuses the same way on a request with nothing in it, and still never reaches the network', async () => {
    // The default-off refusal must not depend on the caller supplying anything
    // well-formed — otherwise a malformed request is a different, unproven path.
    const fetchSpy = vi.fn(async () => new Response('{}', { status: 200 }));
    vi.stubGlobal('fetch', fetchSpy);

    const provider = registered.get('command-eve.video-edit')!;
    const result = (await provider(undefined)) as EditEnvelope;

    expect(result.data?.ok).toBe(false);
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

describe('MAT-1747 round 6 — the two unpaid lifecycle providers answer in the renderer envelope', () => {
  it('the context-envelope provider returns { success, data.envelope } and spends nothing', async () => {
    // The renderer reads `envelopeResult?.data?.envelope` and falls back to `''`.
    // A provider that answered in a different shape would degrade silently to
    // "this conversation has no artifacts" forever.
    const fetchSpy = vi.fn(async () => new Response('{}', { status: 200 }));
    vi.stubGlobal('fetch', fetchSpy);

    const provider = registered.get('command-eve.artifact-context-envelope')!;
    const result = (await provider({ conversationId: 'conv-registration', userTurnText: 'Hallo' })) as {
      success?: boolean;
      data?: { envelope?: unknown };
    };

    expect(result.success).toBe(true);
    expect(typeof result.data?.envelope).toBe('string');
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('the turn-steer provider returns { success, data.revoked/denied } and spends nothing', async () => {
    const fetchSpy = vi.fn(async () => new Response('{}', { status: 200 }));
    vi.stubGlobal('fetch', fetchSpy);

    const provider = registered.get('command-eve.artifact-turn-steer')!;
    const result = (await provider({ conversationId: 'conv-registration', steerText: 'nein, doch nicht' })) as {
      success?: boolean;
      data?: { revoked?: unknown; denied?: unknown };
    };

    expect(result.success).toBe(true);
    expect(typeof result.data?.revoked).toBe('number');
    expect(typeof result.data?.denied).toBe('boolean');
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

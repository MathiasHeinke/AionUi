/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * CEVE-18205 (T8) — THE PAID-LANE GATE, IN TEST FORM.
 *
 * The task that produced this file was framed as "make EVE's agent video tool
 * route via OpenRouter instead of xAI/fal". The obvious reading — teach the
 * agent lane to call `openrouter.ai` — is the one thing this repo must never do:
 *
 *   `eveMultimodalGatewayCore.ts` pins the invariant verbatim — "managed
 *   provider keys live server-side, never in the DMG".
 *
 * The gateway already routes video to OpenRouter by default (`videoLaneFor()`
 * in `supabase/functions/eve-multimodal/index.ts`), so the agent lane reaches
 * OpenRouter by reaching the GATEWAY. A provider key on this side would buy
 * nothing and would cost: it bypasses EVE credits, the reserve/debit path, the
 * spend caps and the tenant cap, all of which live server-side.
 *
 * So this file asserts the SHAPE OF THE ABSENCE. The agent-video-generate
 * surface must contain no provider host, no provider key, and no HTTP client of
 * its own — its only downstream is the in-process bridge handler, which is the
 * thing that already knows how to reach the gateway.
 *
 * WHY BYTE-LEVEL SOURCE ASSERTIONS AND NOT BEHAVIOUR. A behavioural test proves
 * the key is unused on the paths the test drives. It cannot prove there is no
 * fourth branch, reached only in production, that reads one. The absence of a
 * literal in the file is the stronger claim, and it is the claim that survives
 * someone adding a branch later.
 *
 * EVERY NEGATIVE IS PAIRED WITH A POSITIVE CONTROL, because a probe that cannot
 * fire is indistinguishable from a probe that found nothing. `probeFindings`
 * is run against a planted sample in the same `it` block that runs it against
 * the real source.
 */

import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const SRC = path.resolve(__dirname, '../../../packages/desktop/src');

/** The files that make up the agent-video-generate surface. */
const SURFACE_FILES = [
  path.join(SRC, 'process/commandEve/agentVideoGenerateFlag.ts'),
  path.join(SRC, 'process/commandEve/artifactCapabilityLoopback.ts'),
  // CEVE-18205-FLAG — the per-seat release now decides whether the tool opens, so
  // the resolver and its production wiring are part of this surface. The gate
  // module in particular talks to a backend; it must talk to OURS.
  path.join(SRC, 'process/commandEve/agentVideoGenerateSeatResolver.ts'),
  path.join(SRC, 'process/commandEve/agentVideoGenerateGateMain.ts'),
];

/**
 * Provider hosts and credential names that must not appear on this surface.
 *
 * `api.x.ai` and `fal` are here alongside OpenRouter deliberately: the point is
 * not "OpenRouter is forbidden" but "no direct provider egress from the agent
 * lane, whichever provider is fashionable this quarter".
 */
const FORBIDDEN_EGRESS = ['openrouter.ai', 'api.x.ai', 'fal.run', 'fal.ai', 'queue.fal.run'];

const FORBIDDEN_CREDENTIALS = ['OPENROUTER_API_KEY', 'XAI_API_KEY', 'FAL_KEY', 'GROK_API_KEY'];

/**
 * Direct-egress machinery. A surface that only hands a request to an in-process
 * handler needs none of it.
 *
 * NOTE the deliberate omissions: `fetch` is NOT probed here. The loopback file
 * legitimately has none today, but banning the identifier outright would make
 * this test fail for an unrelated, safe refactor and teach the next person to
 * delete the probe. Host + credential + client-construction is the set that
 * actually distinguishes "calls a provider" from "calls our own handler".
 */
const FORBIDDEN_CLIENTS = ['https://api.', 'new URL(`https://', "require('https')", 'node:https'];

function probeFindings(source: string, needles: readonly string[]): string[] {
  return needles.filter((needle) => source.includes(needle));
}

function readSurface(file: string): string {
  return fs.readFileSync(file, 'utf8');
}

describe('CEVE-18205 T8 — the agent video generate surface opens no paid lane', () => {
  it('every file of the surface exists (a missing file must fail, never vacuously pass)', () => {
    // Without this, deleting `agentVideoGenerateFlag.ts` would turn every
    // assertion below into a pass over an empty set.
    for (const file of SURFACE_FILES) {
      expect(fs.existsSync(file), `${path.basename(file)} is missing`).toBe(true);
    }
  });

  it('names no provider host — and the probe would have found one', () => {
    for (const file of SURFACE_FILES) {
      expect(
        probeFindings(readSurface(file), FORBIDDEN_EGRESS),
        `${path.basename(file)} names a provider host`
      ).toEqual([]);
    }
    // POSITIVE CONTROL: the same probe, same needles, against a planted sample.
    expect(probeFindings('const base = "https://openrouter.ai/api/v1";', FORBIDDEN_EGRESS)).toEqual(['openrouter.ai']);
  });

  it('reads no provider credential — and the probe would have found one', () => {
    for (const file of SURFACE_FILES) {
      expect(
        probeFindings(readSurface(file), FORBIDDEN_CREDENTIALS),
        `${path.basename(file)} reads a provider credential`
      ).toEqual([]);
    }
    // POSITIVE CONTROL.
    expect(probeFindings('process.env.OPENROUTER_API_KEY', FORBIDDEN_CREDENTIALS)).toEqual(['OPENROUTER_API_KEY']);
  });

  it('constructs no direct provider client — and the probe would have found one', () => {
    for (const file of SURFACE_FILES) {
      expect(
        probeFindings(readSurface(file), FORBIDDEN_CLIENTS),
        `${path.basename(file)} builds a direct provider client`
      ).toEqual([]);
    }
    // POSITIVE CONTROL.
    expect(probeFindings('fetch("https://api.x.ai/v1/videos")', FORBIDDEN_CLIENTS)).toEqual(['https://api.']);
  });

  it('routes generate through the in-process bridge handler, not a socket of its own', () => {
    const loopback = readSurface(path.join(SRC, 'process/commandEve/artifactCapabilityLoopback.ts'));
    // The positive half of the same claim: the branch exists AND its downstream
    // is the bridge. An absence test alone would also pass if the branch were
    // simply never written.
    expect(loopback).toContain("operation === 'video_generate'");
    expect(loopback).toContain('deps.videoGenerate');
    expect(loopback).toContain('handleCommandEveVideoGenerate');
  });
});

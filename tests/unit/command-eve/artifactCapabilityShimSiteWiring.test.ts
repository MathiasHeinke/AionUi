/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * MAT-1747 round 6 — EVERY shim start site provisions the artifact capability.
 *
 * WHY THIS FILE EXISTS. `gitnexus detect_changes` (scope compare, base
 * `f2e98d97`) reports risk HIGH and names five affected execution flows rooted
 * at `handleAppReady`:
 *
 *   proc_122 HandleAppReady -> CleanupLocalCapabilityFile
 *   proc_123 HandleAppReady -> ResolveAgentProcessRegistryPath
 *   proc_124 HandleAppReady -> Delay
 *   proc_246 HandleAppReady -> ResolveBackend
 *   proc_247 HandleAppReady -> KillBackendProcessTree
 *
 * All five carry the same changed step: `handleAppReady`, which now injects
 * `artifactCapabilityBearer` / `artifactCapabilityCall` into the local shim.
 * `index.ts` starts that shim at THREE sites (two seat-switch paths and the
 * boot path), and the bearer is per-boot. A site that forgets the injection
 * therefore 404s `POST /eve/artifact/call` for the WHOLE session — the exact
 * failure the source comment names, and one with no other symptom: no throw, no
 * log, no degraded response. The agent simply never gets the artifact surface.
 *
 * `artifactCapabilityShimRoute.test.ts` covers the route once the deps ARE
 * passed. Nothing covered the passing. That is what this file adds.
 *
 * Two halves, because either alone would be reassurance rather than evidence:
 *
 *   1. THE CONSEQUENCE IS REAL, proven over real HTTP: a shim started with no
 *      artifact-capability deps is 404-inert on the route. So an omission at a
 *      site is silent, and a shape assertion is warranted rather than pedantic.
 *   2. EVERY SITE INJECTS BOTH, asserted over the real `index.ts` source, with a
 *      sabotage control proving the probe actually fails when one site drops the
 *      injection. A probe that cannot fail is not a gate.
 *
 * `index.ts` is an Electron entrypoint that cannot be imported under vitest, so
 * half 2 reads the source — the same technique `runtimeBridgeRegistration.test.ts`
 * already uses for this file. Its residual is stated rather than hidden: it
 * proves the call sites are WRITTEN correctly, not that Electron reached them.
 */

import fs from 'node:fs';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';
import {
  startCommandEveOllamaOpenAiShim,
  stopCommandEveOllamaOpenAiShimForTest,
} from '@/process/commandEve/ollamaOpenAiShim';

const INDEX_PATH = path.resolve(__dirname, '../../../packages/desktop/src/index.ts');
const START_CALL = 'startCommandEveOllamaOpenAiShim(';

afterEach(async () => {
  await stopCommandEveOllamaOpenAiShimForTest();
});

/**
 * Drop whole-line comments before parsing.
 *
 * Only lines whose trimmed form BEGINS a comment, so a string containing `//`
 * (every https URL in this entrypoint) survives untouched. Without this, an
 * injection that had merely been commented out would still satisfy the probe —
 * which is the difference between a gate and a spell-check.
 */
function withoutCommentLines(source: string): string {
  return source
    .split('\n')
    .filter((line) => {
      const trimmed = line.trim();
      return !(trimmed.startsWith('//') || trimmed.startsWith('*') || trimmed.startsWith('/*'));
    })
    .join('\n');
}

/**
 * Slice out the argument object of every `startCommandEveOllamaOpenAiShim(...)`
 * call by balancing braces from the first `{` after the paren. The parser ALONE,
 * with no comment stripping.
 *
 * Deliberately dumb: a regex over a 100-line object literal would match across
 * neighbouring call sites and quietly report a missing injection as present.
 *
 * Split out from `shimStartCallSites` so the stripper's contribution can be
 * measured rather than asserted: the control below runs this and
 * `shimStartCallSites` over the same fixture and requires them to DISAGREE.
 */
function sliceShimStartCallSites(source: string): string[] {
  const sites: string[] = [];
  let cursor = source.indexOf(START_CALL);
  while (cursor !== -1) {
    const open = source.indexOf('{', cursor + START_CALL.length);
    if (open === -1) break;
    let depth = 0;
    let end = open;
    for (let i = open; i < source.length; i += 1) {
      const ch = source[i];
      if (ch === '{') depth += 1;
      else if (ch === '}') {
        depth -= 1;
        if (depth === 0) {
          end = i;
          break;
        }
      }
    }
    sites.push(source.slice(open, end + 1));
    cursor = source.indexOf(START_CALL, end);
  }
  return sites;
}

function shimStartCallSites(rawSource: string): string[] {
  return sliceShimStartCallSites(withoutCommentLines(rawSource));
}

/** The predicate over already-sliced sites, so a probe WITHOUT stripping can reuse it. */
function sitesProvisionCapability(sites: string[]): boolean {
  if (sites.length === 0) return false;
  return sites.every((site) => site.includes('artifactCapabilityBearer:') && site.includes('artifactCapabilityCall:'));
}

/** The assertion under test, as a predicate so the sabotage control can run it. */
function everySiteProvisionsCapability(source: string): boolean {
  return sitesProvisionCapability(shimStartCallSites(source));
}

describe('MAT-1747 round 6 — a shim started without the capability deps is silently 404-inert', () => {
  it('answers the artifact route with 404 when main never passed the deps at all', async () => {
    // THE FAILURE MODE, executed rather than described. Not "unprovisioned
    // bearer" (that is the neighbouring file) — deps ABSENT, which is what a
    // forgotten call site actually produces.
    const url = await startCommandEveOllamaOpenAiShim({ port: 0 });
    const res = await fetch(`${url}/eve/artifact/call`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${'a'.repeat(64)}` },
      body: JSON.stringify({ operation: 'artifact_get', handle: `evecap_${'b'.repeat(64)}` }),
    });

    expect(res.status).toBe(404);
  });

  it('POSITIVE CONTROL: the identical request reaches the handler once the deps are passed', async () => {
    // Without this, the 404 above would also be satisfied by a shim that never
    // serves the route under any circumstances.
    const bearer = 'a'.repeat(64);
    const calls: unknown[] = [];
    const url = await startCommandEveOllamaOpenAiShim({
      port: 0,
      artifactCapabilityBearer: () => bearer,
      artifactCapabilityCall: async (body: unknown) => {
        calls.push(body);
        return { status: 200, payload: { ok: true } };
      },
    });
    const res = await fetch(`${url}/eve/artifact/call`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${bearer}` },
      body: JSON.stringify({ operation: 'artifact_get', handle: `evecap_${'b'.repeat(64)}` }),
    });

    expect(res.status).toBe(200);
    expect(calls).toHaveLength(1);
  });
});

describe('MAT-1747 round 6 — every shim start site in the app entrypoint provisions it', () => {
  it('finds more than one start site, so this is a real multi-site invariant', () => {
    // If someone consolidates the sites down to one, this test should be
    // reconsidered rather than silently keep passing on a vacuous truth.
    const sites = shimStartCallSites(fs.readFileSync(INDEX_PATH, 'utf8'));
    expect(sites.length).toBeGreaterThan(1);
  });

  it('passes BOTH artifactCapabilityBearer and artifactCapabilityCall at every one of them', () => {
    const source = fs.readFileSync(INDEX_PATH, 'utf8');
    const sites = shimStartCallSites(source);

    for (const [index, site] of sites.entries()) {
      expect(site, `shim start site #${index + 1} omits artifactCapabilityBearer`).toContain(
        'artifactCapabilityBearer:'
      );
      expect(site, `shim start site #${index + 1} omits artifactCapabilityCall`).toContain('artifactCapabilityCall:');
    }
  });

  it('the probe FAILS when a single site drops the injection — the regression it exists to catch', () => {
    // The sabotage control. Removing the injection from the LAST site only, so a
    // probe that merely checked "the file mentions it somewhere" still passes
    // the real file and must fail here.
    const source = fs.readFileSync(INDEX_PATH, 'utf8');
    expect(everySiteProvisionsCapability(source)).toBe(true);

    const lastBearer = source.lastIndexOf('artifactCapabilityBearer: resolveArtifactCapabilityBearer,');
    expect(lastBearer).toBeGreaterThan(-1);
    const lastCall = source.indexOf('artifactCapabilityCall: artifactCapabilityCallHandler,', lastBearer);
    expect(lastCall).toBeGreaterThan(lastBearer);
    const sabotaged =
      source.slice(0, lastBearer) + source.slice(lastCall + 'artifactCapabilityCall: artifactCapabilityCallHandler,'.length);

    expect(everySiteProvisionsCapability(sabotaged)).toBe(false);
  });

  it('the probe FAILS when the injection is deleted outright', () => {
    const source = fs.readFileSync(INDEX_PATH, 'utf8');
    const stripped = source
      .split('artifactCapabilityBearer: resolveArtifactCapabilityBearer,')
      .join('')
      .split('artifactCapabilityCall: artifactCapabilityCallHandler,')
      .join('');

    expect(everySiteProvisionsCapability(stripped)).toBe(false);
  });

  it('the probe FAILS when the injection is only COMMENTED OUT', () => {
    // The source carries a comment saying every site must inject this, so a
    // substring probe is one careless keystroke away from being satisfied by
    // prose about the thing instead of the thing.
    const source = fs.readFileSync(INDEX_PATH, 'utf8');
    const commentedOut = source
      .split('artifactCapabilityBearer: resolveArtifactCapabilityBearer,')
      .join('// artifactCapabilityBearer: resolveArtifactCapabilityBearer,')
      .split('artifactCapabilityCall: artifactCapabilityCallHandler,')
      .join('// artifactCapabilityCall: artifactCapabilityCallHandler,');

    expect(everySiteProvisionsCapability(commentedOut)).toBe(false);
  });

  it('the COMMENTED-OUT case fails because of the stripper — a probe without it accepts the same source', () => {
    // THE CONTROL FOR THE STRIPPER, rewritten because the previous one could not
    // fail. It read:
    //
    //   expect(shimStartCallSites(source))
    //     .toHaveLength(shimStartCallSites(withoutCommentLines(source)).length);
    //
    // `shimStartCallSites` strips internally and `withoutCommentLines` is
    // idempotent, so both sides were the same expression. It asserted a length
    // equals itself and stayed green for every possible stripper, including one
    // that did nothing — the exact regression it was labelled as controlling for.
    //
    // This version measures the stripper's CONTRIBUTION. Two probes differing in
    // one thing — stripping — are run over the same fixture and must DISAGREE.
    const fixture = [
      // A `//` inside a string. Every https URL in the real entrypoint looks like
      // this, and a coarser stripper would eat the line it sits on.
      '  const feed = "https://update.example.com/feed";',
      '  startCommandEveOllamaOpenAiShim({',
      '    port: 0,',
      '    // artifactCapabilityBearer: resolveArtifactCapabilityBearer,',
      '    artifactCapabilityCall: artifactCapabilityCallHandler,',
      '  });',
    ].join('\n');

    // THE ASSERTION THAT GOES RED is the next line: the real probe refuses the fixture because the bearer is prose.
    expect(everySiteProvisionsCapability(fixture)).toBe(false);
    // It can only refuse it while the stripper still removes that commented
    // injection. If `withoutCommentLines` ever degrades — to a no-op, or to
    // anything that leaves a commented injection standing —
    // `everySiteProvisionsCapability` returns true and the line ABOVE fails.
    //
    // The line BELOW is the fixed reference point, not a second detector: the
    // same parser and the same predicate MINUS the stripping accept the fixture,
    // and stay green whatever the stripper does. It is what makes the assertion
    // above a measurement of the stripper's CONTRIBUTION rather than of the
    // parser — two probes differing in exactly one thing, required to disagree.
    expect(sitesProvisionCapability(sliceShimStartCallSites(fixture))).toBe(true);

    // And it must not eat too much, or the negative cases above would pass for
    // the wrong reason: the URL line and the real injection both survive.
    const stripped = withoutCommentLines(fixture);
    expect(stripped).toContain('https://update.example.com/feed');
    expect(stripped).toContain('artifactCapabilityCall: artifactCapabilityCallHandler,');
    expect(stripped).not.toContain('artifactCapabilityBearer');
  });
});

/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * THE MAX VISUAL AUTHORITY — one decision, made in main, consumed in the renderer.
 *
 * The asymmetry is the point. Renderer entitlement and the main-process wire
 * decision are DIFFERENT questions, and only the second may paint. These assert
 * that they can disagree in both directions and that the surface always follows
 * main — or refuses to paint at all.
 */

import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { shouldPaintMaxSurface, type EveMaxAuthorityState } from '@/common/config/eveMaxAuthorityCore';

const SEAT = 'seat-acme-gmbh';
const ready = (over: Partial<EveMaxAuthorityState & { receipt: unknown }> = {}): EveMaxAuthorityState =>
  ({
    status: 'ready',
    receipt: { seatId: SEAT, seatContextRevision: 7, maxActive: true, wireTier: 'max' },
    ...over,
  }) as EveMaxAuthorityState;

describe('MAX authority — the renderer receives, it does not decide', () => {
  it('ASYMMETRY 1: renderer entitlement TRUE + main authority FALSE -> NO MAX styling', () => {
    // The renderer may believe the seat is fully entitled (a purchased plan, a
    // fresh credits read). That is NOT the question. If main says the wire is not
    // `max`, nothing paints — this is the disagreement that used to produce a
    // composer glowing over a routine-lane request.
    const mainSaysNo = ready({ receipt: { seatId: SEAT, seatContextRevision: 7, maxActive: false } });
    expect(shouldPaintMaxSurface(mainSaysNo, SEAT, 7)).toBe(false);
  });

  it('ASYMMETRY 2: renderer FALSE + main authority TRUE -> paints, but ONLY when seat-bound', () => {
    // The renderer's own entitlement view is irrelevant in both directions: it
    // does not veto main either. What DOES gate it is the binding.
    expect(shouldPaintMaxSurface(ready(), SEAT, 7)).toBe(true);
    // Same decision, wrong seat -> refused.
    expect(shouldPaintMaxSurface(ready(), 'seat-other', 7)).toBe(false);
    // Same decision, stale revision -> refused.
    expect(shouldPaintMaxSurface(ready(), SEAT, 8)).toBe(false);
  });

  it('ASYMMETRY 3: a SEAT TRANSITION cannot reuse a prior receipt', () => {
    // The exact cross-tenant lie: seat A holds MAX, the operator switches to seat
    // B, and B's composer inherits A's glow. The receipt names its seat, so it
    // cannot be reused — and a re-bind of the SAME id is caught by the revision.
    const receiptForA = ready({ receipt: { seatId: 'seat-A', seatContextRevision: 3, maxActive: true } });
    expect(shouldPaintMaxSurface(receiptForA, 'seat-A', 3)).toBe(true);
    expect(shouldPaintMaxSurface(receiptForA, 'seat-B', 3)).toBe(false);
    // Same seat id, re-bound underneath us.
    expect(shouldPaintMaxSurface(receiptForA, 'seat-A', 4)).toBe(false);
  });

  it('FAILS VISUALLY CLOSED on every untrustworthy state', () => {
    expect(shouldPaintMaxSurface({ status: 'loading' }, SEAT, 7)).toBe(false);
    expect(shouldPaintMaxSurface({ status: 'error' }, SEAT, 7)).toBe(false);
    expect(shouldPaintMaxSurface(null, SEAT, 7)).toBe(false);
    expect(shouldPaintMaxSurface(undefined, SEAT, 7)).toBe(false);
    // Malformed / empty seat identities never satisfy the binding.
    expect(shouldPaintMaxSurface(ready(), '', 7)).toBe(false);
    expect(shouldPaintMaxSurface(ready(), null, 7)).toBe(false);
    expect(
      shouldPaintMaxSurface(ready({ receipt: { seatId: '', seatContextRevision: 7, maxActive: true } }), '', 7)
    ).toBe(false);
    // A receipt missing its revision cannot pass a revision check.
    expect(shouldPaintMaxSurface(ready({ receipt: { seatId: SEAT, maxActive: true } }), SEAT, 7)).toBe(false);
  });

  it('an absent revision may skip that check but can never GRANT paint on its own', () => {
    // Without an observed revision the seat-id binding still applies.
    expect(shouldPaintMaxSurface(ready(), SEAT)).toBe(true);
    expect(shouldPaintMaxSurface(ready(), 'seat-other')).toBe(false);
    expect(
      shouldPaintMaxSurface(ready({ receipt: { seatId: SEAT, seatContextRevision: 7, maxActive: false } }), SEAT)
    ).toBe(false);
  });
});

describe('MAX authority — the production wiring, not an injected copy', () => {
  const read = (rel: string) => fs.readFileSync(path.resolve(__dirname, '../../../', rel), 'utf-8');
  const BRIDGE = read('packages/desktop/src/process/bridge/commandEveBridge.ts');
  const IPC = read('packages/desktop/src/common/adapter/ipcBridge.ts');
  const REGISTRY = read('packages/desktop/src/common/adapter/security/providerRegistry.ts');
  const HOOK = read('packages/desktop/src/renderer/hooks/agent/useEveMaxAuthority.ts');
  const SELECTION = read('packages/desktop/src/renderer/hooks/agent/useEveInferenceSelection.ts');
  const TOGGLE = read('packages/desktop/src/renderer/components/agent/EveMaxToggle.tsx');
  const strip = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

  it('MAIN computes the decision with the SAME resolver that builds the real request', () => {
    const provider = strip(BRIDGE).slice(
      strip(BRIDGE).indexOf("bridge.buildProvider('command-eve.inference-lane-decision')")
    );
    expect(provider.slice(0, 1400)).toMatch(/resolveEveCloudRouteFromBackend\(/);
    // Seat-bound by construction.
    expect(provider.slice(0, 1400)).toMatch(/getActiveSeatId\(\)/);
    expect(provider.slice(0, 1400)).toMatch(/getActiveSeatContextRevision\(\)/);
    // And the decision is the wire tier, not a re-derivation.
    expect(provider.slice(0, 1400)).toMatch(/maxActive:\s*wireTier === 'max'/);
  });

  it('the channel is declared and registered — deleting it breaks the chain', () => {
    expect(strip(IPC)).toMatch(/inferenceLaneDecision:\s*bridge\.buildProvider/);
    expect(strip(IPC)).toMatch(/'command-eve\.inference-lane-decision'/);
    expect(strip(REGISTRY)).toMatch(/'command-eve\.inference-lane-decision'/);
    expect(strip(BRIDGE)).toMatch(/bridge\.buildProvider\('command-eve\.inference-lane-decision'\)\.provider/);
  });

  it('the renderer CONSUMES the channel and never recomputes the wire tier', () => {
    expect(strip(HOOK)).toMatch(/commandEve\.inferenceLaneDecision\.invoke\(\)/);
    expect(strip(HOOK)).toMatch(/shouldPaintMaxSurface\(/);
    // THE DELETION: the selection hook must hold no wire-tier authority at all.
    expect(strip(SELECTION)).not.toMatch(/resolveEffectiveWireTierFromSelection/);
    expect(strip(SELECTION)).not.toMatch(/maxActive/);
    expect(strip(SELECTION)).not.toMatch(/effectiveWireTier/);
  });

  it('the toggle takes maxActive from the AUTHORITY hook, not the selection hook', () => {
    expect(strip(TOGGLE)).toMatch(/useEveMaxAuthority\(\)/);
    const destructure = /const\s*\{[^}]*\}\s*=\s*useEveInferenceSelection\(\)/.exec(strip(TOGGLE))?.[0] ?? '';
    expect(destructure).not.toMatch(/maxActive/);
  });

  it('BOTH composers mount the authority-driven control, and no third surface decides', () => {
    const ACP = read('packages/desktop/src/renderer/pages/conversation/platforms/acp/AcpSendBox.tsx');
    const AIONRS = read('packages/desktop/src/renderer/pages/conversation/platforms/aionrs/AionrsSendBox.tsx');
    const GUID = read('packages/desktop/src/renderer/pages/guid/components/GuidActionRow.tsx');
    for (const [name, src] of [
      ['AcpSendBox', ACP],
      ['AionrsSendBox', AIONRS],
      ['GuidActionRow', GUID],
    ] as const) {
      expect(strip(src), `${name} must mount EveMaxToggle`).toMatch(/<EveMaxToggle/);
      // A half-migrated authority is worse than the duplicate: no composer may
      // compute its own answer.
      expect(strip(src), `${name} must not compute its own wire tier`).not.toMatch(
        /resolveEffectiveWireTierFromSelection/
      );
    }
  });
});

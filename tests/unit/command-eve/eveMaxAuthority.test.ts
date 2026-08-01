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

  it('an ABSENT revision never paints — an optional guard is an absent guard', () => {
    // This is the finding: the parameter used to be optional and production called
    // without it, so the branch never ran. `null` means "we could not establish the
    // current revision", and an unestablished guard must refuse.
    expect(shouldPaintMaxSurface(ready(), SEAT, null)).toBe(false);
    expect(shouldPaintMaxSurface(ready(), SEAT, 7)).toBe(true);
    expect(shouldPaintMaxSurface(ready(), 'seat-other', 7)).toBe(false);
    expect(
      shouldPaintMaxSurface(ready({ receipt: { seatId: SEAT, seatContextRevision: 7, maxActive: false } }), SEAT, 7)
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

  it('the EVE surfaces mount the authority-driven control — and ONLY the EVE surfaces', () => {
    // CORRECTED (CAO round 9): a previous version asserted AionrsSendBox mounts it
    // too. That was over-correction — "both surfaces" meant both EVE surfaces, not
    // every conversation type. Mounting MAX on mere shell-enablement put a
    // cloud-intelligence affordance on aionrs conversations it does not govern.
    const ACP_SRC = read('packages/desktop/src/renderer/pages/conversation/platforms/acp/AcpSendBox.tsx');
    const AIONRS_SRC = read('packages/desktop/src/renderer/pages/conversation/platforms/aionrs/AionrsSendBox.tsx');
    const GUID_SRC = read('packages/desktop/src/renderer/pages/guid/components/GuidActionRow.tsx');

    // EVE conversation + EVE start screen: mounted.
    expect(strip(ACP_SRC)).toMatch(/<EveMaxToggle/);
    expect(strip(GUID_SRC)).toMatch(/<EveMaxToggle/);
    // ...and the ACP mount is gated on the conversation BEING EVE, not on the shell.
    expect(strip(ACP_SRC)).toMatch(/isEveConversation \? <EveMaxToggle/);

    // A non-EVE backend: not mounted, and holding no selection state at all.
    expect(strip(AIONRS_SRC)).not.toMatch(/EveMaxToggle/);

    // No surface computes its own wire tier.
    for (const [name, src] of [
      ['AcpSendBox', ACP_SRC],
      ['AionrsSendBox', AIONRS_SRC],
      ['GuidActionRow', GUID_SRC],
    ] as const) {
      expect(strip(src), `${name} must not compute its own wire tier`).not.toMatch(
        /resolveEffectiveWireTierFromSelection/
      );
    }
  });
});

describe('MAX authority — REAL-SEAM wiring (deleting any of these turns this file RED)', () => {
  const read = (rel: string) => fs.readFileSync(path.resolve(__dirname, '../../../', rel), 'utf-8');
  const strip = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  const HOOK = strip(read('packages/desktop/src/renderer/hooks/agent/useEveMaxAuthority.ts'));
  const BRIDGE = strip(read('packages/desktop/src/process/bridge/commandEveBridge.ts'));
  const IPC = strip(read('packages/desktop/src/common/adapter/ipcBridge.ts'));
  const CORE = strip(read('packages/desktop/src/common/config/eveMaxAuthorityCore.ts'));
  const AIONRS = strip(read('packages/desktop/src/renderer/pages/conversation/platforms/aionrs/AionrsSendBox.tsx'));
  const ACP = strip(read('packages/desktop/src/renderer/pages/conversation/platforms/acp/AcpSendBox.tsx'));

  it('SEAM 1 — the PRODUCTION REFRESH fires only AFTER the write is DURABLE', () => {
    const CONFIG = strip(read('packages/desktop/src/common/config/configService.ts'));

    // Not a call wired into one component: a subscription on the persisted key, so
    // every surface that writes the selection triggers a re-ask.
    expect(HOOK).toMatch(/configService\.subscribePersisted\(\s*'commandEve\.inferenceSelection'/);
    // ...and the subscriber must actually refresh.
    const sub = HOOK.slice(HOOK.indexOf("configService.subscribePersisted('commandEve.inferenceSelection'"));
    expect(sub.slice(0, 200)).toMatch(/refresh\(\)/);
    // ...on the POST-DURABILITY channel, never the optimistic one. `subscribe`
    // fires before the PUT is awaited, so a refresh from there re-asks main about
    // the value the user just replaced.
    expect(HOOK).not.toMatch(/configService\.subscribe\(\s*'commandEve\.inferenceSelection'/);

    // And the channel it subscribes to is emitted ONLY from the durable-write
    // funnel: `persist()` is the sole caller of notifyPersisted, and the sole
    // issuer of the PUT — so no persisting path can skip the signal, and no
    // non-persisting path can fire it.
    expect(CONFIG).toMatch(/private async persist\(/);
    const persistBody = CONFIG.slice(CONFIG.indexOf('private async persist('));
    const awaitAt = persistBody.indexOf("await fetchJson<void>('PUT'");
    const emitAt = persistBody.indexOf('this.notifyPersisted(');
    expect(awaitAt).toBeGreaterThanOrEqual(0);
    expect(emitAt).toBeGreaterThan(awaitAt);
    // Exactly one PUT issuer in the whole service.
    expect(CONFIG.match(/fetchJson<void>\('PUT'/g) ?? []).toHaveLength(1);
    // notifyPersisted is reachable from persist() alone.
    expect(CONFIG.match(/this\.notifyPersisted\(/g) ?? []).toHaveLength(1);
  });

  it('SEAM 2 — the INDEPENDENT revision source, and it is REQUIRED', () => {
    // A separate channel, separately invoked — not a field of the receipt.
    expect(IPC).toMatch(/seatContext:\s*bridge\.buildProvider/);
    expect(BRIDGE).toMatch(/bridge\.buildProvider\('command-eve\.seat-context'\)\.provider/);
    expect(HOOK).toMatch(/commandEve\.seatContext\.invoke\(\)/);
    // The parameter is required (no `?`), so production cannot silently skip it.
    expect(CORE).toMatch(/currentRevision:\s*number\s*\|\s*null/);
    expect(CORE).not.toMatch(/currentRevision\?:/);
    // And it is actually passed at the call site.
    expect(HOOK).toMatch(/shouldPaintMaxSurface\(state,\s*activeSeatId,\s*currentRevision\)/);
  });

  it('SEAM 3 — the lane-decision IPC provider and its resolver', () => {
    expect(BRIDGE).toMatch(/bridge\.buildProvider\('command-eve\.inference-lane-decision'\)\.provider/);
    expect(BRIDGE).toMatch(/resolveEveCloudRouteFromBackend\(/);
    expect(HOOK).toMatch(/commandEve\.inferenceLaneDecision\.invoke\(\)/);
  });

  it('SEAM 4 — MAX is SCOPED to EVE conversations, never mounted shell-wide', () => {
    // AcpSendBox mounts it gated on the conversation actually being EVE.
    expect(ACP).toMatch(/isEveConversation \? <EveMaxToggle/);
    // Aionrs is a different backend: no MAX control, and no composer lane
    // affordance either.
    expect(AIONRS).not.toMatch(/EveMaxToggle/);
    expect(AIONRS).not.toMatch(/useEveInferenceSelection/);
    expect(AIONRS).not.toMatch(/eveInference\./);
  });
});

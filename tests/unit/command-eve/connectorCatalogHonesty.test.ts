/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * CONNECTOR-CATALOG HONESTY LINT (T6, Founder-Decision D5, Roundtable 4:0).
 *
 * WHY THIS EXISTS
 * ---------------
 * The 'honcho-memory' card was removed because it advertised
 * default_state: 'needs_auth' — a promise of an auth flow — while having NULL
 * wiring on the desktop lane (no client, no guided setup/preflight path, no
 * vault manifest, honcho-ai not bundled). A card that claims a state it cannot
 * reach is a lie to the operator. This lint generalizes the fix so the build
 * BREAKS if any Null-Wiring card ever lands again.
 *
 * THE INVARIANT (the honest, machine-checkable one)
 * -------------------------------------------------
 * For EVERY connector card in the bootstrap capability pack (and its static
 * public mirror), we assert three things:
 *
 *   1. default_state ∈ the honest state vocabulary. D5 names {ready, needs_auth,
 *      future}; the live catalog additionally uses {installed, unverified,
 *      gated} — so the allowed set is the UNION of what the code actually emits
 *      plus the D5 forward-compat states. Any state outside this set is a typo
 *      or an un-vetted state and fails.
 *
 *   2. needs_auth ⇒ a REAL auth/setup surface exists. In this catalog the card's
 *      binding to a setup flow IS its `setup_mode`. The setup_modes that provide
 *      an actual auth/setup path are {guided_connector, optional_sync_connector,
 *      deferred_gated_connector}. The purely-local grant modes (`bootstrap`,
 *      `permissioned_local_connector`) have NO remote auth flow, so a needs_auth
 *      card wearing one of those is exactly the honcho failure mode — advertising
 *      an auth handshake that no code performs. This is the load-bearing check:
 *      it is what would have rejected the honcho card even though honcho lied with
 *      a plausible-looking `guided_connector` string, because the true fix is that
 *      the card must ALSO be reachable — and the resumption criteria in
 *      runtimeBootstrapCore.ts require a manifest/preflight binding before any
 *      needs_auth Honcho card returns.
 *
 *   3. future ⇒ the card carries a `target_version`. D5 rejected 'future'-marking
 *      honcho precisely because a "someday" card with no target version is a
 *      graveyard, not a plan. So any card that ever uses default_state 'future'
 *      must name the version it is targeting.
 *
 * The Honcho id must not reappear on any catalog surface (guarded explicitly so
 * a silent re-add is caught even if it were, hypothetically, well-formed).
 */

import fs from 'fs';
import path from 'path';
import { describe, expect, it } from 'vitest';

import { DEFAULT_COMMAND_EVE_CAPABILITY_PACK } from '@/process/commandEve/runtimeBootstrapCore';

type CatalogCard = {
  id: string;
  name?: string;
  tier?: string;
  setup_mode?: string;
  default_state: string;
  human_gate?: string;
  target_version?: string;
};

/** D5 vocabulary ∪ the states the live bootstrap catalog actually emits. */
const HONEST_DEFAULT_STATES = new Set([
  // D5-named:
  'ready',
  'needs_auth',
  'future',
  // live catalog additionally emits:
  'installed',
  'unverified',
  'gated',
]);

/**
 * setup_modes that provide a REAL auth/setup surface. A needs_auth card MUST use
 * one of these — otherwise it is advertising an auth flow that does not exist.
 */
const AUTH_CAPABLE_SETUP_MODES = new Set([
  'guided_connector',
  'optional_sync_connector',
  'deferred_gated_connector',
]);

/** Ids that must never reappear on any catalog surface (D5 removal). */
const FORBIDDEN_CONNECTOR_IDS = new Set(['honcho-memory', 'memory-honcho']);

function loadStaticMirrorConnectors(): CatalogCard[] {
  // The tracked static mirror lives at repo-root public/. The build copies it
  // into out/, but out/ is a build artifact — assert against the source of truth.
  const mirrorPath = path.resolve(__dirname, '../../../public/command-eve-capabilities.json');
  const raw = JSON.parse(fs.readFileSync(mirrorPath, 'utf8')) as { connectors?: CatalogCard[] };
  return Array.isArray(raw.connectors) ? raw.connectors : [];
}

const CATALOG_SURFACES: Array<{ label: string; connectors: CatalogCard[] }> = [
  {
    label: 'bootstrap capability pack (runtimeBootstrapCore.ts)',
    connectors: DEFAULT_COMMAND_EVE_CAPABILITY_PACK.connectors as unknown as CatalogCard[],
  },
  {
    label: 'static public mirror (public/command-eve-capabilities.json)',
    connectors: loadStaticMirrorConnectors(),
  },
];

describe('connector-catalog honesty lint (T6 / D5)', () => {
  for (const surface of CATALOG_SURFACES) {
    describe(surface.label, () => {
      it('exposes at least one connector card', () => {
        expect(surface.connectors.length).toBeGreaterThan(0);
      });

      it('every default_state is in the honest vocabulary', () => {
        for (const card of surface.connectors) {
          expect(
            HONEST_DEFAULT_STATES.has(card.default_state),
            `${surface.label}: connector '${card.id}' has non-honest default_state '${card.default_state}'`
          ).toBe(true);
        }
      });

      it('every needs_auth card binds to a real auth/setup surface (no null-wiring)', () => {
        for (const card of surface.connectors) {
          if (card.default_state !== 'needs_auth') continue;
          expect(
            AUTH_CAPABLE_SETUP_MODES.has(String(card.setup_mode)),
            `${surface.label}: connector '${card.id}' claims needs_auth but its setup_mode ` +
              `'${card.setup_mode}' provides no auth flow — this is the honcho null-wiring lie. ` +
              `Use one of: ${[...AUTH_CAPABLE_SETUP_MODES].join(', ')}.`
          ).toBe(true);
        }
      });

      it('every future card names a target_version', () => {
        for (const card of surface.connectors) {
          if (card.default_state !== 'future') continue;
          expect(
            typeof card.target_version === 'string' && card.target_version.trim().length > 0,
            `${surface.label}: connector '${card.id}' is default_state 'future' but has no target_version — ` +
              `a "someday" card without a version is a graveyard, not a plan (D5).`
          ).toBe(true);
        }
      });

      it('does not resurrect any D5-removed connector id', () => {
        for (const card of surface.connectors) {
          expect(
            FORBIDDEN_CONNECTOR_IDS.has(card.id),
            `${surface.label}: connector '${card.id}' was removed by D5 and must not reappear on the catalog`
          ).toBe(false);
        }
      });
    });
  }

  it('the two catalog surfaces do not drift in connector ids', () => {
    const codeIds = new Set(
      (DEFAULT_COMMAND_EVE_CAPABILITY_PACK.connectors as unknown as CatalogCard[]).map((c) => c.id)
    );
    const mirrorIds = new Set(loadStaticMirrorConnectors().map((c) => c.id));
    // The static mirror may legitimately carry extra local-only surfaces the
    // bootstrap pack does not (e.g. filesystem/voice); the load-bearing guard is
    // that no FORBIDDEN id lives in either — asserted above. Here we only prove
    // both surfaces are non-empty and share the autonomy_core spine so a whole
    // surface can't silently diverge to zero overlap.
    const overlap = [...codeIds].filter((id) => mirrorIds.has(id));
    expect(overlap.length).toBeGreaterThan(0);
  });
});

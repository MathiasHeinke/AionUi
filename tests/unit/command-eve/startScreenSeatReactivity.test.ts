/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * The start screen must state the ACTIVE seat's mode.
 *
 * `commandEve.authority` is seat-scoped, so `rebindSeat` re-homes the config
 * cache and re-notifies the key when its value differs under the new seat. The
 * start screen resolves the mode through `getModePreference`, which is a plain
 * read — it hears nothing on its own. Without a subscription in the effect's
 * dependencies the screen kept showing the PREVIOUS seat's mode after a switch,
 * which is the same one-shot-read staleness the Freigaben page had. Both
 * surfaces were required to agree; stale, they can disagree with each other AND
 * with the seat.
 *
 * This is a SOURCE CONTRACT, and it is worth being clear about its limits: it
 * proves the subscription is wired into that effect's dependencies, not that
 * React re-renders. The behavioural proof for the same mechanism lives in
 * AuthorityModalContent.dom.test.tsx, which drives a real notify through a real
 * render. What this guards is the cheap regression — someone removing a
 * dependency that looks unused because nothing in the body names it.
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const source = readFileSync(
  resolve(process.cwd(), 'packages/desktop/src/renderer/pages/guid/hooks/useGuidAgentSelection.ts'),
  'utf8'
);
const lines = source.split('\n');

/** The dependency array closing the effect that resolves the preferred mode. */
function modeEffectDependencyLine(): string {
  const anchor = lines.findIndex((line) => line.includes('const loadPreferredMode'));
  expect(anchor).toBeGreaterThan(-1);
  const closing = lines.slice(anchor).find((line) => line.trimStart().startsWith('}, ['));
  expect(closing).toBeTruthy();
  return closing as string;
}

describe('the start screen follows the active seat', () => {
  it('subscribes to the seat-scoped grant rather than reading it once', () => {
    expect(source).toContain("useConfig('commandEve.authority')");
  });

  it('carries that subscription into the mode effect dependencies', () => {
    expect(modeEffectDependencyLine()).toContain('eveAuthorityGrant');
  });

  it('still resolves through the shared resolver, not a raw legacy read', () => {
    // The seat fix has two halves. This one keeps the second half honest: the
    // screen must answer from `getModePreference` (grant first, legacy only as
    // a fallback), never from `acp.config` directly, or the two surfaces can
    // disagree inside a single seat again.
    expect(source).toContain('getModePreference(configKey as string)');
  });
});

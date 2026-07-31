/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * The send path may not fail silently.
 *
 * On 2026-07-31 a 1.820.1 video send died on its way out: the button flickered
 * disabled, the composer snapped back unchanged inside a second, no request was
 * ever made, and NOTHING said why. Founder and Codex each reproduced it — with
 * real keyboard events, and with a changed prompt — and neither could name the
 * cause. They could not, because `onSend(...).catch(() => {})` had already
 * discarded the reason before anyone could read it.
 *
 * That is the defect this file guards, and it is deliberately a source contract
 * rather than a DOM test: every existing suite mocks `components/chat/SendBox`
 * away (AcpSendBox.dom, AionrsSendBox.dom), so a rendered test would assert
 * against a stand-in and prove nothing about the real component. Standing up
 * the real one needs its own fixture; until that exists, this reads the file
 * that actually ships and fails if the swallow comes back.
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const SEND_BOX = resolve(process.cwd(), 'packages/desktop/src/renderer/components/chat/SendBox/index.tsx');

/**
 * The `onSend(...)` chain: from the call to the `.finally` that clears loading,
 * with line comments stripped.
 *
 * The stripping is not tidiness. The first version of this guard failed against
 * the FIXED code, because the comment explaining the defect quotes
 * `.catch(() => {})` verbatim and the regex happily matched the prose. A guard
 * that cannot tell an explanation of a bug from the bug is worse than none.
 */
function readOnSendChain(): string {
  const source = readFileSync(SEND_BOX, 'utf8');
  const start = source.indexOf('onSend(finalMessage)');
  expect(start, 'the onSend dispatch moved — this guard must follow it').toBeGreaterThan(-1);
  const end = source.indexOf('.finally(', start);
  expect(end, 'the onSend chain no longer has a .finally — re-read this seam').toBeGreaterThan(start);
  return source
    .slice(start, end)
    .split('\n')
    .map((line) => line.replace(/\/\/.*$/, ''))
    .join('\n');
}

/** The shapes that mean "the rejection was thrown away". */
const SWALLOW_PATTERNS = [
  /\.catch\(\s*\(\s*\)\s*=>\s*\{\s*\}\s*\)/,
  /\.catch\(\s*\(\s*[\w$]*\s*\)\s*=>\s*\{\s*\}\s*\)/,
];

describe('SendBox send-failure visibility', () => {
  it('recognises the swallow it is meant to catch', () => {
    // Negative control, in memory: a guard that never fires proves nothing, and
    // the real source must not be mutated to find that out. These are the exact
    // shapes that shipped in 1.820.1 and the parameterised variant of the same
    // mistake.
    const shipped = 'onSend(finalMessage)\n      .catch(() => {})\n      ';
    const variant = 'onSend(finalMessage)\n      .catch((error) => {})\n      ';
    expect(SWALLOW_PATTERNS.some((pattern) => pattern.test(shipped))).toBe(true);
    expect(SWALLOW_PATTERNS.some((pattern) => pattern.test(variant))).toBe(true);
  });

  it('does not discard the rejection', () => {
    const chain = readOnSendChain();
    for (const pattern of SWALLOW_PATTERNS) expect(chain).not.toMatch(pattern);
  });

  it('surfaces the failure to the user and to the log', () => {
    const chain = readOnSendChain();
    expect(chain, 'the user must be told the send failed').toMatch(/message\.error\(/);
    expect(chain, 'the reason must reach the console for diagnosis').toMatch(/send-failed/);
  });

  it('keeps the notice on screen until it is dismissed', () => {
    // A send failure that auto-dismisses is a send failure the user repeats.
    const chain = readOnSendChain();
    expect(chain).toMatch(/duration:\s*0/);
    expect(chain).toMatch(/closable:\s*true/);
  });

  it('does not turn the failure into a modal', () => {
    // Standing founder rule: image and video never raise an extra dialog. A
    // failure notice must not become one through the back door.
    const chain = readOnSendChain();
    expect(chain).not.toMatch(/Modal\./);
  });
});

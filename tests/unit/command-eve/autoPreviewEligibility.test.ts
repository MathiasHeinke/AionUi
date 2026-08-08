/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * THE GATE THE COMMENT PROMISED AND THE HANDLER DID NOT APPLY.
 *
 * `useAutoPreviewOfficeFiles` documents at :44-52 that arbitrary agent/user HTML
 * must NOT be auto-surfaced — only generated onboarding step-screens, everything
 * else goes through the explicit preview-click chain. The predicate for that
 * (`isAutoOpenEligible`) existed and was used when the baseline set was built,
 * and was then NOT consulted for incoming `fileAdded` events. So the live path
 * opened whatever the backend reported and the marker gate never applied to a
 * single real file.
 *
 * THE ORDER IS NOT PART OF THE FIX, and this comment used to say it was. It
 * claimed that running eligibility AFTER the dedupe would stop the wrong file
 * from opening but still record it as "known", swallowing a later legitimate
 * event for that path as a repeat. That cannot happen:
 *
 *   - `decideWatchedFileOpen` is pure and both guards answer `null`, so
 *     swapping two independent null-guards changes no return value;
 *   - `getFileTypeInfo` is total (fileType.ts:59-62 — a map lookup with a
 *     fallback), so not even a throw can order them;
 *   - the `fileAdded` handler records ONLY a non-null return, so an ineligible
 *     path never enters the known set under either order.
 *
 * Measured, not argued: swap the two lines and every suite covering this path
 * stays green. The same sentence was disproved and removed twice already
 * (c591f2d3, ae0ec327); it survived here because this file was outside the
 * paths those sweeps touched. Third time, same answer.
 *
 * What IS the fix is the paragraph above: the predicate being consulted on the
 * live path at all. The order states what the function means, nothing more —
 * which is why the describe block below is named after the property that does
 * hold, not after the ordering.
 */

import { describe, expect, it } from 'vitest';
import { decideWatchedFileOpen, isAutoOpenEligible } from '@/renderer/hooks/file/useAutoPreviewOfficeFiles';

const WS = '/Users/mathias/projects/demo';
const none: ReadonlySet<string> = new Set<string>();

const ev = (file_path: string, workspace = WS) => ({ file_path, workspace });

describe('an ineligible file never opens — the marker gate finally applies live', () => {
  it('arbitrary HTML is refused', () => {
    // The exact case the comment names: agent-authored HTML that is not a
    // generated step-screen. It used to open.
    expect(decideWatchedFileOpen(ev(`${WS}/beliebig.html`), WS, none)).toBeNull();
    expect(decideWatchedFileOpen(ev(`${WS}/report.html`), WS, none)).toBeNull();
    expect(decideWatchedFileOpen(ev(`${WS}/sub/index.htm`), WS, none)).toBeNull();
  });

  it('non-office extensions are refused', () => {
    for (const name of ['notes.md', 'script.ts', 'photo.png', 'noextension', 'archive.zip']) {
      expect(decideWatchedFileOpen(ev(`${WS}/${name}`), WS, none), name).toBeNull();
    }
  });

  it('.csv IS eligible — it belongs to the excel family in the shipped table', () => {
    // Written down because it surprised me while writing this suite: fileType.ts
    // maps csv onto contentType 'excel', so a dropped .csv auto-opens like an
    // .xlsx. That is the table's decision, not a gap in this gate — the gate only
    // asks the table. Pinned so a later reader does not mistake it for a leak.
    expect(decideWatchedFileOpen(ev(`${WS}/zahlen.csv`), WS, none)).toBe(`${WS}/zahlen.csv`);
    expect(isAutoOpenEligible('/x/zahlen.csv', 'excel')).toBe(true);
  });

  it('a foreign workspace is refused before anything else is even considered', () => {
    expect(decideWatchedFileOpen(ev('/other/ws/deck.pptx', '/other/ws'), WS, none)).toBeNull();
  });
});

describe('an eligible file still comes through', () => {
  it('a generated onboarding step-screen opens', () => {
    expect(decideWatchedFileOpen(ev(`${WS}/onboarding-2.html`), WS, none)).toBe(`${WS}/onboarding-2.html`);
    expect(decideWatchedFileOpen(ev(`${WS}/onboarding.html`), WS, none)).toBe(`${WS}/onboarding.html`);
  });

  it('the office types open', () => {
    for (const name of ['deck.pptx', 'brief.docx', 'zahlen.xlsx']) {
      expect(decideWatchedFileOpen(ev(`${WS}/${name}`), WS, none), name).toBe(`${WS}/${name}`);
    }
  });

  it('the returned path is NORMALIZED, so the caller records what it matched on', () => {
    // /private/tmp and /private/var are the macOS symlink pair normalizeWatchPath
    // folds; the decision must hand back the folded form or the dedupe set would
    // hold a key no later event can match.
    expect(decideWatchedFileOpen(ev('/private/tmp/ws/a.docx', '/private/tmp/ws'), '/tmp/ws', none)).toBe(
      '/tmp/ws/a.docx'
    );
  });
});

describe('nothing ineligible ever enters the known-set — the property the ordering serves', () => {
  /**
   * HONEST NOTE ON WHAT THIS BLOCK CAN AND CANNOT PIN. The brief asked for
   * eligibility BEFORE the dedupe, so an ineligible path cannot be recorded as
   * "known" and mask a later legitimate event for the same path. The source is
   * written that way — and I ran the sabotage: swapping the two lines leaves
   * every test here green.
   *
   * It has to. The handler adds ONLY what `decideWatchedFileOpen` returns, and
   * an ineligible path returns null in either order, so it never reaches the set
   * either way. The internal order is therefore unobservable from outside; it is
   * a statement of intent, not a behavioural guarantee, and naming this block
   * after it would have been a green gate guarding nothing.
   *
   * What IS pinned below is the property that actually protects the set: null in,
   * nothing recorded — plus the structural check that the caller records the
   * decision's result rather than the raw event path.
   */
  it('an already-known eligible file does not re-open', () => {
    const known = new Set([`${WS}/deck.pptx`]);
    expect(decideWatchedFileOpen(ev(`${WS}/deck.pptx`), WS, known)).toBeNull();
  });

  it('an ineligible path must NOT be recorded as known — proven via the caller contract', () => {
    // The handler adds ONLY what this function returns. A null return therefore
    // means "nothing enters the set", which is what keeps a later eligible event
    // for the same path from being swallowed as a repeat.
    const known = new Set<string>();
    const first = decideWatchedFileOpen(ev(`${WS}/beliebig.html`), WS, known);
    expect(first).toBeNull();
    // …the caller adds nothing, so the set is still empty…
    expect(known.size).toBe(0);
    // …and a genuinely eligible file is unaffected afterwards.
    expect(decideWatchedFileOpen(ev(`${WS}/onboarding.html`), WS, known)).toBe(`${WS}/onboarding.html`);
  });

  it('the handler adds exactly the returned value and nothing else', () => {
    // Structural companion: the source must record the decision result, not the
    // raw event path — otherwise the normalization above would be lost again.
    const src = readHookSource();
    expect(src).toContain(
      'const normalizedFilePath = decideWatchedFileOpen(event, normalizedWorkspace, knownOfficeFilesRef.current);'
    );
    expect(src).toContain('if (normalizedFilePath === null) return;');
    expect(src).toContain('knownOfficeFilesRef.current.add(normalizedFilePath);');
  });
});

describe('the predicate itself is unchanged — this commit moved WHERE it runs, not WHAT it says', () => {
  it('isAutoOpenEligible still answers as before', () => {
    expect(isAutoOpenEligible('/x/onboarding-3.html', 'html')).toBe(true);
    expect(isAutoOpenEligible('/x/beliebig.html', 'html')).toBe(false);
    expect(isAutoOpenEligible('/x/deck.pptx', 'ppt')).toBe(true);
    expect(isAutoOpenEligible('/x/notes.md', 'markdown')).toBe(false);
  });
});

function readHookSource(): string {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const fs = require('node:fs') as typeof import('node:fs');
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const path = require('node:path') as typeof import('node:path');
  return fs.readFileSync(
    path.join(__dirname, '../../../packages/desktop/src/renderer/hooks/file/useAutoPreviewOfficeFiles.ts'),
    'utf8'
  );
}

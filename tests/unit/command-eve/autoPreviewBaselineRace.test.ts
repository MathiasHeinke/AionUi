/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * THE BASELINE RACE — a file that arrives while the baseline is still loading.
 *
 * `useAutoPreviewOfficeFiles` starts the watcher and lists the workspace, both
 * awaited, while the `fileAdded` subscription is already live. A file dropped in
 * that window opens correctly and is recorded in the known-set — and the
 * baseline then REPLACED the whole set with `new Set(...)`, throwing that record
 * away. The next event for the same file found an empty memory and opened it a
 * second time.
 *
 * Two halves are pinned here, and each is sabotage-checked separately:
 *   - the merge itself must UNION (behavioural, below), and
 *   - the effect must actually use it (structural, at the end) — a perfect union
 *     helper that nobody calls would leave the defect exactly where it was.
 */

import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { decideWatchedFileOpen, mergeWorkspaceBaseline } from '@/renderer/hooks/file/useAutoPreviewOfficeFiles';

const WS = '/Users/mathias/projects/demo';

const hookSource = (): string =>
  fs.readFileSync(
    path.join(__dirname, '../../../packages/desktop/src/renderer/hooks/file/useAutoPreviewOfficeFiles.ts'),
    'utf8'
  );

describe('the baseline must not forget what arrived while it was loading', () => {
  it('THE RACE: a file recorded during the await survives the baseline', () => {
    // This is the whole defect in one assertion. `raced.docx` came in through the
    // live subscription; `existing.docx` was already on disk. Replacing the set
    // would drop the first and the next event would re-open it.
    const duringAwait = new Set([`${WS}/raced.docx`]);
    const merged = mergeWorkspaceBaseline(duringAwait, [`${WS}/existing.docx`]);

    expect(merged.has(`${WS}/raced.docx`), 'the raced file was forgotten').toBe(true);
    expect(merged.has(`${WS}/existing.docx`)).toBe(true);
    expect(merged.size).toBe(2);
  });

  it('and the raced file therefore does NOT open a second time', () => {
    // The consequence the user would have seen: the same document opening twice.
    const merged = mergeWorkspaceBaseline(new Set([`${WS}/raced.docx`]), [`${WS}/existing.docx`]);
    expect(decideWatchedFileOpen({ file_path: `${WS}/raced.docx`, workspace: WS }, WS, merged)).toBeNull();
  });

  it('an empty prior set behaves exactly as the plain baseline did', () => {
    const merged = mergeWorkspaceBaseline(new Set<string>(), [`${WS}/a.docx`, `${WS}/b.pptx`]);
    expect([...merged].toSorted()).toEqual([`${WS}/a.docx`, `${WS}/b.pptx`]);
  });

  it('the merge does not mutate the set it was handed', () => {
    // The effect assigns the RESULT; a helper that mutated its input would work
    // by accident here and break the moment a caller reuses the old reference.
    const prior = new Set([`${WS}/raced.docx`]);
    mergeWorkspaceBaseline(prior, [`${WS}/existing.docx`]);
    expect(prior.size).toBe(1);
  });
});

describe('the baseline is filtered by the SAME gate as the live path', () => {
  it('ineligible workspace files never enter the set', () => {
    const merged = mergeWorkspaceBaseline(new Set<string>(), [
      `${WS}/beliebig.html`,
      `${WS}/notes.md`,
      `${WS}/photo.png`,
      `${WS}/deck.pptx`,
    ]);
    expect([...merged]).toEqual([`${WS}/deck.pptx`]);
  });

  it('paths are normalized on the way in, so the live path can match them', () => {
    const merged = mergeWorkspaceBaseline(new Set<string>(), ['/private/tmp/ws/a.docx']);
    expect(merged.has('/tmp/ws/a.docx')).toBe(true);
  });
});

describe('the effect actually uses the merge, and still resets between conversations', () => {
  it('primeOfficeWatch merges instead of replacing', () => {
    // Structural: a correct helper nobody calls is not a fix. The old shape was
    // `knownOfficeFilesRef.current = new Set(currentFiles...)`.
    const src = hookSource();
    expect(src).toContain('knownOfficeFilesRef.current = mergeWorkspaceBaseline(');
    expect(src, 'the baseline overwrites the set again').not.toMatch(
      /knownOfficeFilesRef\.current = new Set\(\s*\n?\s*currentFiles/
    );
  });

  it('the cancelled flag still guards the write', () => {
    const src = hookSource();
    const prime = src.slice(src.indexOf('const primeOfficeWatch'), src.indexOf('void primeOfficeWatch()'));
    const guard = prime.indexOf('if (cancelled) return;');
    const write = prime.indexOf('knownOfficeFilesRef.current = mergeWorkspaceBaseline(');
    expect(guard, 'the cancelled guard is gone').toBeGreaterThan(-1);
    expect(write, 'the merge write is gone').toBeGreaterThan(-1);
    expect(guard, 'a torn-down effect could still write the ref').toBeLessThan(write);
  });

  it('a re-run still starts from an EMPTY set — no paths cross between conversations', () => {
    // The union is only safe because the effect head clears the ref first.
    // Without that, switching conversation would inherit the previous one's set.
    const src = hookSource();
    const effect = src.slice(src.indexOf('useEffect(() => {'), src.indexOf('const primeOfficeWatch'));
    expect(effect).toContain('knownOfficeFilesRef.current = new Set();');
  });
});

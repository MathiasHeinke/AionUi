/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * THE COMPOSER OFFERS MAX, AND NOTHING ELSE. LOCAL LIVES IN SETTINGS.
 *
 * THE DEFECT (CAO round 10, F2). The cloud intelligence ladder was removed from
 * the composer, but the ACP MOBILE action sheet still shipped a `Verarbeitung`
 * entry with selectable `EVE Cloud` / local rows. Dropping the tier names did not
 * make it something else: a control in the composer that chooses which
 * intelligence serves the next turn IS the affordance this release removes. The
 * desktop path had been cleaned and the mobile path had not — which is exactly
 * how this class keeps surviving: it is fixed where it was named and left
 * standing one file away.
 *
 * SO THIS TEST DOES NOT CHECK ONE FILE. It sweeps the whole composer area from
 * disk — every send box, the shared send bar, the mobile action sheet, the start
 * screen's action row — so a re-introduction in a file that did not exist when
 * this was written is caught too. And it asserts the positive half as well: the
 * private local lane must still be selectable in SETTINGS, because "removed from
 * the composer" and "removed from the product" are different releases.
 *
 * IT ALSO SWEEPS THE PROSE. A comment describing a control the product no longer
 * has is treated as a defect on this ticket: it is what the next reader builds
 * against, and it is how a deleted row gets re-mounted. Nine audit rounds were
 * spent finding the same claim three files away from the one that was cited.
 */

import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = path.resolve(__dirname, '../../../');
const read = (rel: string): string => fs.readFileSync(path.join(ROOT, rel), 'utf-8');

/**
 * Every directory a composer control can live in. Read from DISK, not listed by
 * hand, so a new file in any of them is covered the day it lands.
 */
const COMPOSER_DIRS = [
  'packages/desktop/src/renderer/pages/conversation/platforms',
  'packages/desktop/src/renderer/components/chat',
  'packages/desktop/src/renderer/pages/guid/components',
];

function walk(rel: string): string[] {
  const abs = path.join(ROOT, rel);
  const out: string[] = [];
  for (const entry of fs.readdirSync(abs, { withFileTypes: true })) {
    const child = path.join(rel, entry.name);
    if (entry.isDirectory()) out.push(...walk(child));
    else if (/\.tsx?$/.test(entry.name)) out.push(child);
  }
  return out;
}

const COMPOSER_FILES = COMPOSER_DIRS.flatMap(walk).toSorted();

/** Strip block + line comments, so CODE assertions never trip on prose. */
const code = (src: string): string => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

/** Split prose into sentences so a removal marker must be LOCAL to the claim. */
const sentences = (text: string): string[] =>
  text
    .split(/(?<=[.;!?])\s+/)
    .map((s) => s.trim())
    .filter(Boolean);

/** The inverse: keep ONLY prose, with the comment markers removed. */
function prose(src: string): string {
  const chunks: string[] = [];
  for (const m of src.matchAll(/\/\*[\s\S]*?\*\//g)) chunks.push(m[0]);
  for (const m of src.matchAll(/^[ \t]*\/\/.*$/gm)) chunks.push(m[0]);
  return chunks
    .join('\n')
    .replace(/^[ \t]*(\/\*+|\*+\/|\*|\/\/)[ \t]?/gm, '')
    .replace(/\s+/g, ' ');
}

describe('the composer has ONE intelligence affordance: MAX', () => {
  it('sanity: the sweep actually reaches the send boxes it is meant to police', () => {
    // A sweep over an empty/misrooted file list would pass every assertion below
    // while proving nothing. Pin the files the finding was actually about.
    expect(COMPOSER_FILES.length).toBeGreaterThan(20);
    for (const required of [
      'packages/desktop/src/renderer/pages/conversation/platforms/acp/AcpSendBox.tsx',
      'packages/desktop/src/renderer/pages/conversation/platforms/aionrs/AionrsSendBox.tsx',
      'packages/desktop/src/renderer/components/chat/UnifiedSendBar.tsx',
      'packages/desktop/src/renderer/components/chat/MobileActionSheet/MobileActionSheet.tsx',
      'packages/desktop/src/renderer/pages/guid/components/GuidActionRow.tsx',
    ]) {
      expect(COMPOSER_FILES, `${required} is outside the sweep`).toContain(required);
    }
  });

  it('NO composer surface offers a lane / tier / local-inference choice', () => {
    // Each pattern is a way to BUILD or COMMIT an inference-lane choice. None of
    // them belongs in the composer any more — with or without tier nomenclature.
    const FORBIDDEN: Array<[RegExp, string]> = [
      [/EVE_DEFAULT_INFERENCE_SELECTION/, 'offers the cloud lane as a selectable row'],
      [/localTierValue\s*\(/, 'builds a local-lane selection value'],
      [/eveInference\.commit\s*\(/, 'commits an inference selection'],
      [/eveInference\.groups/, 'reads the two-group picker model'],
      [/eveInference\.isSelectable/, 'gates rows off the picker model'],
      [/eveInference\.items/, 'enumerates picker rows'],
      [/kind === 'local'/, 'splits out the local lane to offer it'],
      [/EveInferencePicker/, 'mounts the inference picker'],
      [/conversation\.eveInference\.(lane|cloudLane)/, 'labels a lane-selection row'],
    ];
    for (const file of COMPOSER_FILES) {
      const src = code(read(file));
      for (const [pattern, why] of FORBIDDEN) {
        expect(src, `${file} ${why} — the composer must offer MAX only`).not.toMatch(pattern);
      }
    }
  });

  it('the ONLY intelligence control mounted in the composer is EveMaxToggle', () => {
    const mounts = COMPOSER_FILES.filter((f) => /<EveMaxToggle/.test(code(read(f))));
    // Both EVE composers mount it — the running conversation and the start screen.
    expect(mounts).toEqual([
      'packages/desktop/src/renderer/pages/conversation/platforms/acp/AcpSendBox.tsx',
      'packages/desktop/src/renderer/pages/guid/components/GuidActionRow.tsx',
    ]);
    // ...and the ACP mount stays gated on the conversation actually being EVE,
    // so a non-EVE backend never gains a cloud-intelligence control.
    expect(code(read(mounts[0]))).toMatch(/maxSlot=\{<EveMaxToggle disabled=\{isBusy\} \/>\}/);
  });

  it('an EVE conversation gets NO model entry in the mobile sheet either', () => {
    // The deleted lane row sat in an `if (isEveConversation) … else if (model…)`.
    // Deleting only the branch would have dropped EVE straight into the RAW model
    // list below it — swapping one composer lane picker for another. The guard is
    // load-bearing and must survive.
    const acp = code(read('packages/desktop/src/renderer/pages/conversation/platforms/acp/AcpSendBox.tsx'));
    expect(acp).toMatch(/if \(!isEveConversation && modelOptions\.length > 0\)/);
    expect(acp).not.toMatch(/if \(isEveConversation\) \{\s*[\s\S]{0,80}entries\.push/);
  });

  it('the unrelated sheet actions are KEPT — this was a deletion, not a gutting', () => {
    // The finding was scoped to the intelligence affordance. Permission modes,
    // busy-send mode, attachments, skills and MCP are the sheet's real job on
    // mobile and removing them would be a regression dressed up as compliance.
    const acp = code(read('packages/desktop/src/renderer/pages/conversation/platforms/acp/AcpSendBox.tsx'));
    for (const key of ["key: 'permission'", "key: 'busy-send-mode'", "key: 'skills'", "key: 'mcp'"]) {
      expect(acp, `the mobile sheet lost ${key}`).toContain(key);
    }
    expect(acp).toContain('attachEntries.forEach');
  });

  it('the private LOCAL lane is still selectable — in SETTINGS, and only there', () => {
    // The other half of the contract. "Not in the composer" must not quietly
    // become "nowhere", or the local lane ships unreachable.
    const settings = code(
      read('packages/desktop/src/renderer/components/settings/SettingsModal/contents/ModelModalContent.tsx')
    );
    expect(settings).toMatch(/localTierValue\s*\(/);
    expect(settings).toMatch(/configService\.set\('commandEve\.inferenceSelection'/);
    expect(settings).toMatch(/selectCommandEveLocalModelTier/);

    // And Settings is the ONLY writer of a LOCAL selection anywhere in the app.
    const rendererFiles = walk('packages/desktop/src/renderer');
    const localWriters = rendererFiles.filter((f) => /localTierValue\s*\(/.test(code(read(f))));
    expect(localWriters).toEqual([
      'packages/desktop/src/renderer/components/settings/SettingsModal/contents/ModelModalContent.tsx',
    ]);
  });
});

describe('no prose describes a composer control that no longer exists', () => {
  /**
   * Present-tense CLAIMS about a lane/tier/inference picker in the composer or in
   * a mobile sheet. Each one of these was live in the tree and false. If a future
   * comment needs to narrate the removal it must say so in the past tense ("it
   * offered…", "the lane entry is gone") rather than restate the claim verbatim.
   */
  const FALSE_CLAIMS = [
    'surfaces the EVE Inference tier',
    'EVE Inference tier picker',
    'EVE tier entry in the mobile action sheet',
    "mobile action sheet's LANE entry",
    'both mobile sheets',
    'two-group EVE Inference picker',
    'EVE Inference + Private tier picker',
    'the mobile sheet, Settings',
    'raw provider/model list is replaced',
    'aionrs conversations are filtered out',
  ];

  const PRODUCTION_ROOTS = [
    'packages/desktop/src/renderer',
    'packages/desktop/src/common',
    'packages/desktop/src/process',
  ];

  it('the claim does not appear in ANY production comment, in any file', () => {
    const files = PRODUCTION_ROOTS.flatMap(walk);
    expect(files.length).toBeGreaterThan(200);
    for (const file of files) {
      const text = prose(read(file));
      if (!text) continue;
      for (const claim of FALSE_CLAIMS) {
        expect(text.toLowerCase(), `${file}: stale claim "${claim}"`).not.toContain(claim.toLowerCase());
      }
    }
  });

  it('the files the auditor cited now state what the code actually does', () => {
    const aionrs = prose(read('packages/desktop/src/renderer/pages/conversation/platforms/aionrs/AionrsSendBox.tsx'));
    // The two false claims: that the sheet shows an EVE picker, and that aionrs
    // conversations are filtered out of the EVE shell. Neither was true — the
    // entry is aionrs' OWN unconditional model list.
    expect(aionrs).toMatch(/no EVE intelligence affordance/i);
    expect(aionrs).toMatch(/unconditional and unfiltered|nothing here is conditioned on the EVE shell/i);

    const shell = prose(read('packages/desktop/src/common/config/commandEveShell.ts'));
    expect(shell).toMatch(/suppresses the raw ACP model selector/i);
    expect(shell).toMatch(/MAX toggle/);

    // CAO 11 FINDING 2: the start screen's hero claimed an "EVE Inference +
    // permission-mode" pair in the action row. `modelSelectorNode` is null for
    // EVE and the row mounts MAX; there is no inference selector there.
    // Asserted as booleans — a `toMatch` here dumps the file's entire prose into
    // the failure and buries every other finding in the run.
    const guid = prose(read('packages/desktop/src/renderer/pages/guid/GuidPage.tsx'));
    expect(/MAX toggle and\s*permission-mode selector/i.test(guid), 'GuidPage: action row contents not stated').toBe(
      true
    );
    expect(
      /modelSelectorNode` above is null for EVE|NO inference\/model selector/i.test(guid),
      'GuidPage: does not say the model selector is null for EVE'
    ).toBe(true);
  });
});

/**
 * THE VOCABULARY RULE — the widened sweep (CAO 11).
 *
 * WHY THE PREVIOUS SWEEP MISSED FOUR LIVE FALSEHOODS. It matched a list of
 * verbatim SENTENCES that had already been found. That only ever catches the
 * exact wording someone already fixed once; the same claim written with
 * different words — "two-group picker model", "sheet rows", "the picker's active
 * row", "header ↔ sheet ↔ GuidPicker" — sailed straight through a file the sweep
 * was already reading.
 *
 * SO THIS DOES NOT MATCH SENTENCES. It matches the VOCABULARY of the deleted UI,
 * and applies one rule:
 *
 *   If a comment NAMES the deleted picker, the SAME SENTENCE must mark it as
 *   deleted.
 *
 * Past-tense and negated narration therefore stays legal ("the picker that used
 * to render it no longer exists", "there is NO tier picker here any more") —
 * which matters, because removing true history is its own defect. A bare
 * present-tense mention is a defect.
 */
describe('deleted-UI vocabulary may only appear as history', () => {
  /**
   * Terms that name the REMOVED composer picker specifically. Bare "picker" is
   * deliberately NOT here: the video-quality picker and the permission-mode
   * picker are real, and a term that fires on them would be noise the next
   * reader learns to ignore.
   */
  const DELETED_UI_TERMS: Array<[RegExp, string]> = [
    [/two-group/i, 'the two-group picker model was never rendered after MAT-1749'],
    [/picker(?:'s)?\s+(?:active\s+)?rows?\b/i, 'there are no picker rows — the picker is gone'],
    [/sheet\s+rows?\b/i, 'the mobile sheet has no lane/model rows for EVE'],
    [/guid\s*picker/i, 'the start-screen picker was removed'],
    [/inference\s+picker/i, 'no inference picker is mounted anywhere'],
    [/inference\s+selectors?\b/i, 'no inference selector is mounted anywhere'],
    [/EVE Inference\s*\+/i, 'the "EVE Inference + …" pairing describes a removed control'],
    [/header\s+(?:chip|↔|<->)/i, 'the desktop header picker/chip is gone'],
    [/picker\s+model/i, 'the entitlement model is not a picker'],
  ];

  /** A sentence naming a deleted control is legal ONLY if it says it is gone. */
  const REMOVAL_MARKERS =
    /\b(no|not|never|none|gone|deleted|removed|dropped|retired|without|used to|no longer|any more|anymore|was|were|used|former|previously|instead of|rather than|until)\b/i;

  /**
   * WHERE THIS APPLIES, and the limitation stated out loud.
   *
   * These are the renderer surfaces that describe COMPOSER UI — the files where
   * "the picker" can only mean the deleted one. `common/config/eveInferenceCore.ts`
   * and the `process/` readers are deliberately OUT: they carry the wire-tier
   * REGISTRY and the persisted key's value space, which the release keeps, and
   * they are explicitly on the auditor's keep-list. See the reported limitation:
   * eveInferenceCore alone still says "picker" 36 times and auditing that file is
   * its own scope, not something to smuggle in behind a regex.
   */
  const COMPOSER_PROSE_ROOTS = [
    'packages/desktop/src/renderer/hooks/agent',
    'packages/desktop/src/renderer/components/agent',
    'packages/desktop/src/renderer/components/chat',
    'packages/desktop/src/renderer/pages/conversation/platforms',
    'packages/desktop/src/renderer/pages/guid',
  ];

  it('sanity: the vocabulary sweep reaches the two files CAO 11 rejected', () => {
    const files = COMPOSER_PROSE_ROOTS.flatMap(walk);
    for (const required of [
      'packages/desktop/src/renderer/hooks/agent/useEveInferenceSelection.ts',
      'packages/desktop/src/renderer/pages/guid/GuidPage.tsx',
    ]) {
      expect(files, `${required} is outside the vocabulary sweep`).toContain(required);
    }
    expect(files.length).toBeGreaterThan(30);
  });

  it('every mention of the deleted picker is marked as deleted', () => {
    // Collect ALL violations before asserting. Failing on the first one is how a
    // reviewer fixes one line, re-runs, and meets the next — which is the exact
    // loop that produced eleven rejections on this ticket.
    const violations: string[] = [];
    for (const file of COMPOSER_PROSE_ROOTS.flatMap(walk)) {
      const text = prose(read(file));
      if (!text) continue;
      for (const sentence of sentences(text)) {
        for (const [term, why] of DELETED_UI_TERMS) {
          if (!term.test(sentence)) continue;
          if (REMOVAL_MARKERS.test(sentence)) continue;
          violations.push(`${file}\n    ${why}\n    → "${sentence}"`);
        }
      }
    }
    expect(violations, `present-tense claims about the deleted picker:\n\n${violations.join('\n\n')}\n`).toEqual([]);
  });

  it('the rule still ALLOWS honest history — it is not a word ban', () => {
    // Proves the sweep cannot be satisfied by simply deleting the history. These
    // sentences name the deleted UI and are legal because they narrate its
    // removal; if the rule were a blanket ban these files would be red.
    const hook = prose(read('packages/desktop/src/renderer/hooks/agent/useEveInferenceSelection.ts'));
    expect(hook).toMatch(/picker/i);
    const acp = prose(read('packages/desktop/src/renderer/pages/conversation/platforms/acp/AcpSendBox.tsx'));
    expect(acp).toMatch(/no tier picker here any more/i);
  });
});

/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * MAT-1747 C4 / ACCEPTANCE 8 — resolution stays semantic.
 *
 * The founder ruled out a local classifier for this lane, and the reason is
 * concrete: with the cost wall gone, a false positive spends money unattended
 * and there is nothing behind it to catch the mistake. The model reads a handle
 * and a permit out of its own context envelope and names them; nothing in the
 * resolution path is allowed to guess from the user's words or to pick "the
 * latest" clip.
 *
 * This is a STRUCTURAL assertion over the whole path, not a behavioural one, so
 * it fails the day someone quietly reaches for a regex.
 *
 * TWO THINGS WERE WRONG WITH THE FIRST VERSION and both are fixed here:
 *
 *  1. It covered six modules and missed the two that actually face the model —
 *     the loopback handler and the MCP server process. A gate that skips the
 *     front door is a gate about the back door.
 *
 *  2. It banned `toLowerCase`, `toUpperCase` and `.includes(` and three function
 *     names, so `toLocaleLowerCase`, `.indexOf(`, `.match(`, `.test(`, a bare
 *     `RegExp` and `startsWith` all walked straight through. A classifier spelled
 *     with `.test(` is still a classifier.
 *
 * The ban is now FLAT — every string-matching primitive, with no exceptions —
 * because a structural test cannot tell a shape check from a keyword classifier
 * and should not try. The modules were rewritten to do their shape checks with
 * character scans (`eveOpaqueTokenCore`), which is what makes a flat ban
 * possible without the gate arguing with itself.
 *
 * Comments are stripped first — prose ABOUT a forbidden construct must not
 * satisfy a test looking for it, a mistake already made twice in this workstream
 * — and the stripping itself has its own control below, because a broken
 * stripper would make this whole file pass vacuously.
 */

import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const REPO_ROOT = path.resolve(__dirname, '../../..');

/**
 * Every module a follow-up turn traverses on its way to a paid edit — including
 * the two the model actually talks to.
 *
 * `videoGenerationRequestCore` is deliberately NOT here, and the reason is worth
 * writing down rather than leaving as an omission: it hydrates durable artifact
 * metadata this app itself wrote, never sees user text, and recovers a legacy
 * clip's duration from its own stored description. It is on the path but not on
 * the RESOLUTION path — nothing in it decides which clip an instruction means.
 */
const RESOLUTION_PATH_MODULES = [
  'packages/desktop/src/common/config/eveOpaqueTokenCore.ts',
  'packages/desktop/src/common/config/eveArtifactCapabilityHandleCore.ts',
  'packages/desktop/src/common/config/eveArtifactContextEnvelopeCore.ts',
  'packages/desktop/src/common/config/eveVideoEditSpendPermitCore.ts',
  'packages/desktop/src/common/config/videoEditRequestCore.ts',
  'packages/desktop/src/process/commandEve/artifactCapabilityHandleStore.ts',
  'packages/desktop/src/process/commandEve/videoEditSpendPermitStore.ts',
  'packages/desktop/src/process/commandEve/agentVideoEditFlag.ts',
  // The two the first version of this gate missed.
  'packages/desktop/src/process/commandEve/artifactCapabilityLoopback.ts',
  'packages/desktop/src/process/resources/builtinMcp/eveArtifactContextServer.ts',
  // Where the tool DESCRIPTIONS moved when policy F split the advertisement
  // decision out of the entry point. Listed deliberately: leaving it off would
  // have quietly narrowed this gate at the moment the text left the file above.
  'packages/desktop/src/process/resources/builtinMcp/eveArtifactToolSurface.ts',
  'packages/desktop/src/process/bridge/commandEveVideoBridge.ts',
];

/**
 * Each entry says WHAT would be wrong, not merely what string is banned.
 *
 * The case-folding pair and the search primitives are how a keyword classifier
 * is spelled — in any of a dozen different ways, which is exactly why banning
 * two of them was not a ban. The three named functions are the EXISTING NL
 * classifiers in `videoCostCore`; importing one here would route a paid edit off
 * a regex. `latest`/`newest`/`mostRecent` are how a "just pick the last clip"
 * fallback is spelled, and that fallback would spend credits on a video nobody
 * named.
 */
const FORBIDDEN_CONSTRUCTS = [
  'toLowerCase',
  'toUpperCase',
  'toLocaleLowerCase',
  'toLocaleUpperCase',
  '.includes(',
  '.indexOf(',
  '.lastIndexOf(',
  '.match(',
  '.matchAll(',
  '.search(',
  '.test(',
  'startsWith',
  'endsWith',
  'RegExp',
  'isVideoGenerationRequest',
  'requestRoutesToVideoLane',
  'isVideoLaneRequest',
  'VIDEO_GENERATION_PATTERNS',
  'latest',
  'newest',
  'mostRecent',
];

/** Strip block comments and line comments. Real code is left untouched. */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[\t ]*\/\/.*$/gm, '');
}

/**
 * Additionally blank out string and template literals.
 *
 * Only used for the regex-literal probe. Without it an ordinary `'http://…'`
 * reads as a regex literal and the probe fires on every file; with it, the probe
 * sees only code.
 */
function stripStringLiterals(source: string): string {
  return source
    .replace(/'(?:\\.|[^'\\\n])*'/g, "''")
    .replace(/"(?:\\.|[^"\\\n])*"/g, '""')
    .replace(/`(?:\\.|[^`\\])*`/g, '``');
}

/**
 * Find a regular-expression LITERAL in code.
 *
 * Anchored on the characters that can legally precede a literal (an assignment,
 * an open paren, a comma…) so that ordinary division — `a / b` — does not read
 * as one. Both halves of that claim have a control below.
 */
const REGEX_LITERAL = /(?:^|[=(,:[!&|?{};+\s])\/(?![*/])(?:\\.|\[(?:\\.|[^\]\\])*\]|[^/\\\n])+\/[dgimsuvy]*/;

function findRegexLiteral(source: string): boolean {
  return REGEX_LITERAL.test(stripStringLiterals(stripComments(source)));
}

describe('the comment stripper this file depends on', () => {
  it('removes prose that merely MENTIONS a forbidden construct', () => {
    const prose = [
      '/** we deliberately never call toLowerCase here */',
      '// and no .includes( either',
      'const x = 1;',
    ].join('\n');
    const stripped = stripComments(prose);
    expect(stripped).not.toContain('toLowerCase');
    expect(stripped).not.toContain('.includes(');
    expect(stripped).toContain('const x = 1;');
  });

  it('does NOT remove real code — the whole test would be vacuous otherwise', () => {
    // THE control that makes every assertion below meaningful. If the stripper
    // ate code, an actual classifier would sail through.
    const code = ['// a comment', 'if (text.toLowerCase().includes("video")) return true;'].join('\n');
    const stripped = stripComments(code);
    expect(stripped).toContain('toLowerCase');
    expect(stripped).toContain('.includes(');
  });
});

describe('the regex-literal probe this file depends on', () => {
  it('fires on an actual regex literal', () => {
    expect(findRegexLiteral('const SHAPE = /^[0-9a-f]{64}$/;')).toBe(true);
    expect(findRegexLiteral('if (/video/i.test(text)) return true;')).toBe(true);
  });

  it('does NOT fire on division, a URL inside a string, or a comment', () => {
    // Without these three controls the probe could be "always true", which would
    // make the module assertions meaningless in the other direction.
    expect(findRegexLiteral('const ratio = width / height;')).toBe(false);
    expect(findRegexLiteral("const url = 'http://127.0.0.1:1234/eve/artifact/call';")).toBe(false);
    expect(findRegexLiteral('// a comment mentioning /^[a-z]+$/ in prose')).toBe(false);
  });
});

describe('no module on the resolution path classifies keywords or guesses a clip', () => {
  for (const relativePath of RESOLUTION_PATH_MODULES) {
    it(`${relativePath} is free of every classifier construct`, () => {
      const source = fs.readFileSync(path.join(REPO_ROOT, relativePath), 'utf8');
      const code = stripComments(source);
      for (const forbidden of FORBIDDEN_CONSTRUCTS) {
        expect(code, `${relativePath} must not contain ${forbidden}`).not.toContain(forbidden);
      }
    });

    it(`${relativePath} carries no regular expression literal`, () => {
      const source = fs.readFileSync(path.join(REPO_ROOT, relativePath), 'utf8');
      expect(findRegexLiteral(source), `${relativePath} must not contain a regex literal`).toBe(false);
    });
  }

  it('the matcher fires on a real classifier', () => {
    // THE NEGATIVE CONTROL for the loop above. A synthetic module containing the
    // exact thing we forbid must be caught — otherwise "no module contains it"
    // would be a statement about the matcher, not about the modules.
    const synthetic = [
      'export function resolveEditSource(records, message) {',
      '  if (message.toLowerCase().includes("video")) return records.at(-1);',
      '  return undefined;',
      '}',
    ].join('\n');
    const code = stripComments(synthetic);
    const caught = FORBIDDEN_CONSTRUCTS.filter((forbidden) => code.includes(forbidden));
    expect(caught).toContain('toLowerCase');
    expect(caught).toContain('.includes(');
  });

  it('the matcher fires on every construct the FIRST version of this gate let through', () => {
    // The specific regression, named one by one so a future narrowing of the
    // list fails here rather than silently.
    const synthetic = [
      'const a = text.toLocaleLowerCase();',
      'const b = text.indexOf("video");',
      'const c = text.match(/video/);',
      'const d = /video/.test(text);',
      'const e = new RegExp("video");',
      'const f = text.startsWith("video");',
    ].join('\n');
    const code = stripComments(synthetic);
    for (const construct of ['toLocaleLowerCase', '.indexOf(', '.match(', '.test(', 'RegExp', 'startsWith']) {
      expect(FORBIDDEN_CONSTRUCTS.filter((forbidden) => code.includes(forbidden))).toContain(construct);
    }
    // ...and the regex-literal probe catches the two spelled as literals.
    expect(findRegexLiteral('const c = text.match(/video/);')).toBe(true);
  });

  it('the matcher fires on a latest-artifact fallback', () => {
    const synthetic = 'const source = latestEditableArtifact(records) ?? records[0];';
    expect(FORBIDDEN_CONSTRUCTS.filter((f) => stripComments(synthetic).includes(f))).toContain('latest');
  });
});

describe('the edit path takes no free-text source reference at all', () => {
  it('the IPC request type carries two credentials and an instruction, and nothing that names a clip', () => {
    const source = fs.readFileSync(
      path.join(REPO_ROOT, 'packages/desktop/src/common/config/videoEditRequestCore.ts'),
      'utf8'
    );
    const declaration = /export interface CommandEveVideoEditRequest \{([\s\S]*?)\n\}/.exec(source)?.[1] ?? '';
    expect(declaration).toBeTruthy();
    const fields = stripComments(declaration)
      .split('\n')
      .map((line) => line.trim().replace(/[?:].*$/, ''))
      .filter(Boolean);
    // Exactly these four. An `artifactId`, a `path`, a `tier` or a `filename` on
    // this interface would be a source reference the model could invent.
    expect(fields.toSorted()).toEqual(['conversationId', 'handle', 'instruction', 'permit']);
  });
});

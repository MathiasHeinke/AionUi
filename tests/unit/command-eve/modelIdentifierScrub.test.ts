/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * The chat must never render a model id. The picker and composer honour that by
 * construction — ERROR TEXT does not, because it originates upstream and is
 * rendered verbatim (the send-failure toast is even pinned with `duration: 0`).
 * These pin the scrub that closes that path.
 */

import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  SCRUBBED_MODEL_PLACEHOLDER,
  scrubErrorText,
  scrubModelIdentifiers,
} from '@/common/config/modelIdentifierScrub';
import { scrubUpstreamErrorBody } from '@process/commandEve/ollamaOpenAiShim';
import { CLOUD_MODEL_IDENTIFIERS } from '@/renderer/utils/model/modelContextLimits';

/**
 * Synthetic slugs in the SHAPE upstream uses. Deliberately not the real vendor
 * names: the scrub is shape-based precisely so it keeps working when the
 * server-side registry changes, and a test written against today's ids would be
 * testing the wrong property.
 */
const UPSTREAM_SLUG = 'acmelabs/nova-4.2';
const OTHER_SLUG = 'vendorco/atlas-v3';

describe('scrubModelIdentifiers — provider slugs never reach the chat', () => {
  it('removes a vendor/model slug from an upstream error sentence', () => {
    const scrubbed = scrubModelIdentifiers(`Upstream rejected the request for ${UPSTREAM_SLUG}.`);
    expect(scrubbed).not.toContain(UPSTREAM_SLUG);
    expect(scrubbed).not.toContain('acmelabs');
    expect(scrubbed).not.toContain('nova-4.2');
  });

  it('removes EVERY slug in a message, not only the first', () => {
    const scrubbed = scrubModelIdentifiers(`${UPSTREAM_SLUG} failed over to ${OTHER_SLUG} and also failed.`);
    expect(scrubbed).not.toContain('acmelabs');
    expect(scrubbed).not.toContain('vendorco');
  });

  it('leaves ORDINARY prose with a slash intact — this must not mangle real messages', () => {
    for (const sentence of [
      'Rate limit reached: 20 requests/min.',
      'Choose one and/or the other.',
      'Read the terms and conditions.',
    ]) {
      expect(scrubModelIdentifiers(sentence)).toBe(sentence);
    }
  });

  it('also scrubs concrete identifiers a caller supplies (defence in depth)', () => {
    const scrubbed = scrubModelIdentifiers('The model nova-4.2 is unavailable.', ['nova-4.2']);
    expect(scrubbed).not.toContain('nova-4.2');
    expect(scrubbed).toContain('The model');
  });

  it('scrubs the LONGEST supplied identifier first, so nothing is left half-redacted', () => {
    const scrubbed = scrubModelIdentifiers('id: nova-4.2-turbo here', ['nova-4.2', 'nova-4.2-turbo']);
    expect(scrubbed).not.toContain('nova');
    expect(scrubbed).not.toContain('turbo');
  });

  it('is a no-op for empty input and never returns undefined', () => {
    expect(scrubModelIdentifiers('')).toBe('');
    expect(typeof scrubModelIdentifiers('plain text')).toBe('string');
  });

  it('scrubErrorText handles Error, string and non-string throws without bypassing the scrub', () => {
    expect(scrubErrorText(new Error(`boom ${UPSTREAM_SLUG}`))).not.toContain('acmelabs');
    expect(scrubErrorText(`boom ${UPSTREAM_SLUG}`)).not.toContain('acmelabs');
    expect(scrubErrorText(undefined)).toBe('');
  });

  it('leaves a readable sentence behind rather than obvious redaction debris', () => {
    const scrubbed = scrubModelIdentifiers(`Request failed (${UPSTREAM_SLUG}) — try again.`);
    expect(scrubbed).toContain('Request failed');
    expect(scrubbed).toContain('try again');
    // The bracketed remains of the scrub are collapsed away.
    expect(scrubbed).not.toContain('()');
    expect(scrubbed).not.toContain(`(${SCRUBBED_MODEL_PLACEHOLDER})`);
  });
});

describe('scrubUpstreamErrorBody — the shim passthrough', () => {
  it('scrubs error.message in a NON-OK JSON body before it is forwarded to chat', () => {
    const body = JSON.stringify({ error: { message: `No endpoints found for ${UPSTREAM_SLUG}.`, code: 404 } });
    const out = scrubUpstreamErrorBody(body, false);
    expect(out).not.toContain('acmelabs');
    // Still an OpenAI-shaped error, so the chat keeps rendering it normally.
    const parsed = JSON.parse(out) as { error: { message: string; code: number } };
    expect(parsed.error.code).toBe(404);
    expect(parsed.error.message).toContain('No endpoints found');
  });

  it('scrubs a NON-OK body that is not JSON at all (plain-text upstream failure)', () => {
    const out = scrubUpstreamErrorBody(`upstream failure for ${UPSTREAM_SLUG}`, false);
    expect(out).not.toContain('acmelabs');
  });

  it('passes a 200 body through BYTE-IDENTICALLY — scrubbing model OUTPUT would corrupt the answer', () => {
    // A completion legitimately contains whatever the user asked about, which may
    // include a slash. Only the error path is rewritten.
    const completion = JSON.stringify({ choices: [{ message: { content: 'Use foo/bar for that.' } }] });
    expect(scrubUpstreamErrorBody(completion, true)).toBe(completion);
  });

  it('is a no-op on empty text', () => {
    expect(scrubUpstreamErrorBody('', false)).toBe('');
  });
});

/**
 * THE SCRUB IS ONLY WORTH ITS TESTS IF PRODUCTION CALLS IT.
 *
 * The block above proves the function. It does not prove that the renderer sites
 * which render UPSTREAM error text route through it.
 *
 * WHAT THIS REPLACED, and why the replacement had to happen (1.820.1). The old
 * block pinned two sites BY NAME and then asserted
 * `occurrences of scrubModelIdentifiers( === 2`. A COUNT cannot tell the defect
 * from the cure: adding a raw toast (bad) and adding a correctly scrubbed one
 * (good) both change it, so the contract failed identically for both — and
 * fixing two real leaks turned it RED. A test that fails when the wiring is
 * FIXED is worse than no test.
 *
 * SO THIS IS A PROPERTY. It reads the guarded files, masks comments and string
 * literals (a prose mention of the scrub can never satisfy it), and then asks
 * one question of every USER-FACING SINK:
 *
 *     does any RAW upstream error text reach this sink outside a scrub call?
 *
 * Raw text is tracked through local bindings — `const x = parseError(e)` taints
 * `x`, and anything built from `x` — with a fixpoint, so laundering through an
 * intermediate variable does not escape it. Both directions are proved by the
 * suite itself, on the real sources, on every run:
 *
 *   (a) a NEW RAW site appended to any guarded file  -> findings, RED;
 *   (b) a NEW SCRUBBED site appended to the same file -> no findings, GREEN.
 *
 * STATED LIMITATION, not hidden: this is still a source-text analysis. It reads
 * the shapes this codebase actually writes (calls, `const` bindings, template
 * interpolations). It is not a type checker, and a raw render smuggled through a
 * helper in ANOTHER file is outside its reach — which is why the guarded list
 * below is the list of files that own a render site, and why adding one there is
 * part of adding a render site.
 */

type Span = { start: number; end: number };

/**
 * Files that render upstream error text into a user-facing surface.
 *
 * THE SCOPE IS THE PRODUCT, NOT "THE CHAT". The scheduled-task detail page is on
 * this list for exactly that reason: it is not the chat, but a scheduled task
 * dispatches a turn on the SAME cloud lane, so its "run now" toast carries the
 * same upstream sentence. Leaving a known leak standing because it sits one step
 * outside a literal reading of the mandate is the shape this ticket keeps
 * repeating — fixed where it was named, left standing one route away.
 */
const GUARDED_FILES = [
  'packages/desktop/src/renderer/pages/conversation/platforms/acp/AcpSendBox.tsx',
  'packages/desktop/src/renderer/pages/conversation/platforms/aionrs/AionrsSendBox.tsx',
  'packages/desktop/src/renderer/components/chat/SendBox/index.tsx',
  'packages/desktop/src/renderer/pages/conversation/platforms/acp/useCommandEveVisualPreparation.ts',
  'packages/desktop/src/renderer/pages/conversation/platforms/acp/useAcpInitialMessage.ts',
  'packages/desktop/src/renderer/pages/cron/ScheduledTasksPage/TaskDetailPage.tsx',
] as const;

/** The scrub wrappers. Text inside one of these calls is, by definition, safe. */
const SCRUB_CALL = /\bscrub(?:ModelIdentifiers|ErrorText)\s*\(/g;

/** Every way these files obtain RAW upstream error text. */
const RAW_PRODUCERS: readonly RegExp[] = [
  /\bgetConversationRuntimeWorkspaceErrorMessage\s*\(/g,
  /\bparseError\s*\(/g,
  /\.\s*backendMessage\b/g,
  /\.\s*message\b/g,
  // `String(err)` as well as `String(error)` / `String(intentError)`: the cron
  // page names its caught value `err`, and a producer pattern that only knew the
  // longer spelling would have scanned that file and found nothing to guard.
  /\bString\s*\(\s*\w*[eE]rr\w*/g,
];

/** Every call that puts text in front of the user (or into the chat log). */
const RENDER_SINKS: readonly RegExp[] = [
  /\b[Mm]essage\s*\.\s*(?:error|warning|info|success)\s*\(/g,
  /\bmarkSendFailed\s*\(/g,
  /\bbuildSendFailureError\s*\(/g,
  /\baddOrUpdateMessage(?:Ref\s*\.\s*current)?\s*\(/g,
  /\bresponseStream\s*\.\s*emit\s*\(/g,
];

/**
 * Blank out comments and string-literal CONTENT in one pass, preserving offsets
 * and newlines. Template `${...}` interpolations are KEPT as code, because a
 * render site legitimately lives inside one (`Message.error(`${label}: ${detail}`)`).
 */
function codeOnly(src: string): string {
  const out = src.split('');
  const blank = (i: number): void => {
    if (i < out.length && out[i] !== '\n') out[i] = ' ';
  };
  let i = 0;
  while (i < src.length) {
    const ch = src[i];
    const next = src[i + 1];
    if (ch === '/' && next === '/') {
      while (i < src.length && src[i] !== '\n') blank(i++);
      continue;
    }
    if (ch === '/' && next === '*') {
      while (i < src.length && !(src[i] === '*' && src[i + 1] === '/')) blank(i++);
      blank(i);
      blank(i + 1);
      i += 2;
      continue;
    }
    if (ch === "'" || ch === '"') {
      blank(i++);
      while (i < src.length && src[i] !== ch) {
        if (src[i] === '\\') blank(i++);
        blank(i++);
      }
      blank(i++);
      continue;
    }
    if (ch === '`') {
      blank(i++);
      while (i < src.length) {
        if (src[i] === '\\') {
          blank(i++);
          blank(i++);
          continue;
        }
        if (src[i] === '`') {
          blank(i++);
          break;
        }
        if (src[i] === '$' && src[i + 1] === '{') {
          i += 2;
          for (let depth = 1; i < src.length && depth > 0; i++) {
            if (src[i] === '{') depth++;
            else if (src[i] === '}') depth--;
          }
          continue;
        }
        blank(i++);
      }
      continue;
    }
    i++;
  }
  return out.join('');
}

/** The [call, matching `)`] span of every call matching `re`. */
function callSpans(code: string, re: RegExp): Span[] {
  const spans: Span[] = [];
  for (const match of code.matchAll(re)) {
    const start = match.index;
    let i = start + match[0].length - 1;
    for (let depth = 0; i < code.length; i++) {
      if (code[i] === '(') depth++;
      else if (code[i] === ')' && --depth === 0) break;
    }
    spans.push({ start, end: i });
  }
  return spans;
}

const within = (index: number, spans: readonly Span[]): boolean =>
  spans.some((span) => index >= span.start && index <= span.end);

/** `const|let|var NAME = <initializer>`, initializer ending at its own `;`. */
function declarations(code: string): { name: string; init: Span }[] {
  const decls: { name: string; init: Span }[] = [];
  for (const match of code.matchAll(/\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=(?!=)/g)) {
    const start = match.index + match[0].length;
    let i = start;
    for (let depth = 0; i < code.length; i++) {
      const c = code[i];
      if (c === '(' || c === '[' || c === '{') depth++;
      else if (c === ')' || c === ']' || c === '}') {
        if (depth === 0) break;
        depth--;
      } else if (c === ';' && depth === 0) break;
    }
    decls.push({ name: match[1], init: { start, end: i } });
  }
  return decls;
}

function identifierOffsets(code: string, name: string): number[] {
  return [...code.matchAll(new RegExp(`\\b${name}\\b`, 'g'))].map((m) => m.index);
}

type Analysis = {
  /** A render site that shows raw upstream text. Non-empty means the leak is back. */
  findings: string[];
  /** Bindings that hold RAW upstream text (legal only if no sink reads them). */
  rawBindings: string[];
  sinkCount: number;
  producerCount: number;
  /** Scrub calls that do NOT pass the concrete deny-list. */
  scrubsWithoutDenyList: number;
};

function analyseRenderSites(source: string): Analysis {
  const code = codeOnly(source);
  const scrubs = callSpans(code, SCRUB_CALL);
  const producers = RAW_PRODUCERS.flatMap((re) => [...code.matchAll(re)].map((m) => m.index));
  const rawProducers = producers.filter((index) => !within(index, scrubs));

  // Taint fixpoint: a binding is RAW if its initializer reads raw text — directly
  // or through another RAW binding — outside a scrub call.
  const decls = declarations(code);
  const raw = new Set<string>();
  for (let pass = 0; pass <= decls.length; pass++) {
    const before = raw.size;
    for (const decl of decls) {
      if (raw.has(decl.name)) continue;
      const readsProducer = rawProducers.some((i) => i >= decl.init.start && i <= decl.init.end);
      const readsRaw = [...raw].some((name) =>
        identifierOffsets(code, name).some((i) => i >= decl.init.start && i <= decl.init.end && !within(i, scrubs))
      );
      if (readsProducer || readsRaw) raw.add(decl.name);
    }
    if (raw.size === before) break;
  }

  const sinks = RENDER_SINKS.flatMap((re) => callSpans(code, re));
  const findings: string[] = [];
  const snippet = (index: number): string =>
    code
      .slice(index, index + 60)
      .replace(/\s+/g, ' ')
      .trim();
  for (const sink of sinks) {
    for (const index of rawProducers) {
      if (index >= sink.start && index <= sink.end) findings.push(`raw read in a sink: ${snippet(index)}`);
    }
    for (const name of raw) {
      for (const index of identifierOffsets(code, name)) {
        if (index >= sink.start && index <= sink.end && !within(index, scrubs)) {
          findings.push(`raw binding "${name}" reaches a sink: ${snippet(sink.start)}`);
        }
      }
    }
  }

  return {
    findings,
    rawBindings: [...raw],
    sinkCount: sinks.length,
    producerCount: producers.length,
    scrubsWithoutDenyList: scrubs.filter((s) => !code.slice(s.start, s.end).includes('CLOUD_MODEL_IDENTIFIERS')).length,
  };
}

/** A render site written the WRONG way. Appending it must turn the contract red. */
const RAW_SITE = `
function __contractProbeRaw(error: unknown, t: unknown) {
  const leakedReason = parseError(error);
  Message.error(leakedReason);
}
`;
/** The SAME site written correctly. Appending it must leave the contract green. */
const SCRUBBED_SITE = `
function __contractProbeScrubbed(error: unknown, t: unknown) {
  const safeReason = scrubModelIdentifiers(parseError(error), CLOUD_MODEL_IDENTIFIERS);
  Message.error(safeReason);
}
`;
const RAW_INLINE_SITE = 'function __probeInlineRaw(e: unknown) { Message.error(parseError(e)); }\n';
const SCRUBBED_INLINE_SITE =
  'function __probeInlineOk(e: unknown) { Message.error(scrubModelIdentifiers(parseError(e), CLOUD_MODEL_IDENTIFIERS)); }\n';

describe('the scrub is WIRED at every renderer site that renders upstream error text', () => {
  const ROOT = path.resolve(__dirname, '../../../');
  const sources = new Map(GUARDED_FILES.map((rel) => [rel, fs.readFileSync(path.join(ROOT, rel), 'utf-8')]));

  it.each(GUARDED_FILES)('%s renders NO raw upstream error text', (rel) => {
    const analysis = analyseRenderSites(sources.get(rel)!);
    expect(analysis.findings, `unscrubbed render sites in ${rel}`).toEqual([]);
  });

  it.each(GUARDED_FILES)('%s is actually being scanned (the contract is not vacuous)', (rel) => {
    // A green scan of nothing is the failure mode this whole block exists to
    // avoid: if the sinks or the producers stop being recognised — a rename, a
    // moved file, a broken masker — the property above passes while proving
    // nothing at all. So the scan must find real sinks AND real raw producers.
    const analysis = analyseRenderSites(sources.get(rel)!);
    expect(analysis.sinkCount, `no user-facing sink found in ${rel}`).toBeGreaterThan(0);
    expect(analysis.producerCount, `no upstream-error read found in ${rel}`).toBeGreaterThan(0);
  });

  it.each(GUARDED_FILES)('%s: a NEW RAW render site turns the contract RED (proof it can fail)', (rel) => {
    const source = sources.get(rel)!;
    expect(analyseRenderSites(source + RAW_SITE).findings.length, 'bound-then-rendered raw site').toBeGreaterThan(0);
    expect(analyseRenderSites(source + RAW_INLINE_SITE).findings.length, 'inline raw site').toBeGreaterThan(0);
  });

  it.each(GUARDED_FILES)('%s: a NEW SCRUBBED render site stays GREEN (proof it fails for the right reason)', (rel) => {
    // The direction the old count got wrong: adding a CORRECT site must not
    // break the contract, or the contract punishes the fix.
    const source = sources.get(rel)!;
    expect(analyseRenderSites(source + SCRUBBED_SITE).findings, 'bound-then-rendered scrubbed site').toEqual([]);
    expect(analyseRenderSites(source + SCRUBBED_INLINE_SITE).findings, 'inline scrubbed site').toEqual([]);
  });

  it.each(GUARDED_FILES)('%s: every scrub passes the concrete deny-list, not just the shape scrub', (rel) => {
    // The shape scrub alone catches `vendor/model`. The BARE model name only goes
    // through CLOUD_MODEL_IDENTIFIERS, so a scrub call without it is half a scrub.
    expect(analyseRenderSites(sources.get(rel)!).scrubsWithoutDenyList).toBe(0);
  });

  it('the shared send bar keeps the RAW reason for the CONSOLE and the scrubbed one for the toast', () => {
    // The debugging half must survive: `rawReason` is deliberately unscrubbed and
    // deliberately never rendered. This asserts BOTH halves of that split — it is
    // a raw binding, and no sink reads it.
    const analysis = analyseRenderSites(
      sources.get('packages/desktop/src/renderer/components/chat/SendBox/index.tsx')!
    );
    expect(analysis.rawBindings).toContain('rawReason');
    expect(analysis.findings).toEqual([]);
  });
});

/**
 * THE DENY-LIST ITSELF. The shape scrub catches `vendor/model`; the bare model
 * name is only ever caught by this list, so what it contains is load-bearing.
 */
describe('CLOUD_MODEL_IDENTIFIERS — both the slug and the BARE model name', () => {
  it('carries the bare model name for every slug it knows', () => {
    for (const slug of CLOUD_MODEL_IDENTIFIERS.filter((id) => id.includes('/'))) {
      const bare = slug.slice(slug.indexOf('/') + 1);
      expect(CLOUD_MODEL_IDENTIFIERS, `bare form of ${slug} is missing`).toContain(bare);
    }
  });

  it('scrubs an upstream sentence that names the model WITHOUT its vendor prefix', () => {
    // The exact hole: the list used to be slug-only, and a slug is already caught
    // by the shape rule — so the list added nothing while the form it was needed
    // for went through untouched.
    for (const bare of CLOUD_MODEL_IDENTIFIERS.filter((id) => !id.includes('/'))) {
      const scrubbed = scrubModelIdentifiers(`Upstream rejected the request for ${bare}.`, CLOUD_MODEL_IDENTIFIERS);
      expect(scrubbed, `bare id ${bare} survived the scrub`).not.toContain(bare);
      expect(scrubbed).toContain('Upstream rejected');
    }
  });

  it('every entry contains a digit — the guard that keeps it out of ordinary prose', () => {
    // Entries are matched as case-insensitive SUBSTRINGS with no word boundary, so
    // a bare word here ("deepseek", "microsoft") would mangle real sentences. Model
    // names always carry a digit; vendor words do not.
    for (const id of CLOUD_MODEL_IDENTIFIERS) {
      expect(id, `${id} could match ordinary prose`).toMatch(/[0-9]/);
    }
  });

  it('leaves ordinary prose alone even with the full deny-list applied', () => {
    for (const sentence of [
      'Rate limit reached: 20 requests/min.',
      'The connection to the workspace was lost. Please try again.',
      'Die Anfrage konnte nicht zugestellt werden.',
    ]) {
      expect(scrubModelIdentifiers(sentence, CLOUD_MODEL_IDENTIFIERS)).toBe(sentence);
    }
  });
});

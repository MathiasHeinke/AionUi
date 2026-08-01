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
 * The block above proves the function. It does not prove that the four renderer
 * sites which render UPSTREAM error text still route through it — and that gap
 * was found by sabotage: deleting `scrubModelIdentifiers(...)` from the ACP
 * PDF-failure toast left the whole focused suite green, so the toast would have
 * shipped a provider/model id straight into the composer with nothing red.
 *
 * These are source-text pins, deliberately, and the limitation is stated rather
 * than hidden: they catch a DELETION at a named site, not a semantically
 * equivalent rewrite. They exist because a deletion is what actually happens.
 */
describe('the scrub is WIRED at every renderer site that renders upstream error text', () => {
  const ROOT = path.resolve(__dirname, '../../../');
  const read = (rel: string): string => fs.readFileSync(path.join(ROOT, rel), 'utf-8');
  /** Strip comments so a prose mention of the scrub cannot satisfy a code pin. */
  const code = (s: string): string => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

  const ACP = code(read('packages/desktop/src/renderer/pages/conversation/platforms/acp/AcpSendBox.tsx'));
  const AIONRS = code(read('packages/desktop/src/renderer/pages/conversation/platforms/aionrs/AionrsSendBox.tsx'));
  const SENDBOX = code(read('packages/desktop/src/renderer/components/chat/SendBox/index.tsx'));

  it('the ACP PDF-preparation failure toast scrubs the upstream message', () => {
    expect(ACP).toMatch(/scrubModelIdentifiers\(\s*initialFailure\.message,\s*CLOUD_MODEL_IDENTIFIERS\s*\)/);
  });

  it('the ACP CLOUD-OCR RETRY failure toast scrubs too — the site this block used to miss', () => {
    // There are TWO failure toasts on this path, ten lines apart. Pinning only the
    // first is why the second shipped raw: the suite was green while the property
    // it is named for — "every ACP toast that renders upstream text is scrubbed" —
    // was false, and the UNPINNED one was the attempt that had actually reached a
    // provider and so was the likelier of the two to carry a model id.
    expect(ACP).toMatch(/scrubModelIdentifiers\(\s*cloudFailure\.message,\s*CLOUD_MODEL_IDENTIFIERS\s*\)/);
  });

  it('BOTH ACP scrub calls are counted, so a THIRD toast cannot arrive unpinned unnoticed', () => {
    // A count, not a third name check. Adding a new raw toast leaves both pins
    // above green; this is what notices. Still a source pin (stated limitation),
    // but it fails on an ADDITION as well as on a deletion.
    expect((ACP.match(/scrubModelIdentifiers\(/g) ?? []).length).toBe(2);
  });

  it('the shared send bar scrubs the send-failure reason (the toast pinned at duration 0)', () => {
    expect(SENDBOX).toMatch(/scrubModelIdentifiers\(\s*rawReason,\s*CLOUD_MODEL_IDENTIFIERS\s*\)/);
    // The RAW text may still reach the console — that is the debugging half and
    // must not be mistaken for the user-facing one.
    expect(SENDBOX).toMatch(/content:\s*reason/);
  });

  it('BOTH aionrs error paths scrub — the send failure and the correction failure', () => {
    expect((AIONRS.match(/scrubErrorText\(\s*error,\s*CLOUD_MODEL_IDENTIFIERS\s*\)/g) ?? []).length).toBe(2);
  });

  it('every site passes the concrete deny-list, not just the shape scrub', () => {
    for (const [name, src] of [
      ['AcpSendBox', ACP],
      ['AionrsSendBox', AIONRS],
      ['SendBox', SENDBOX],
    ] as const) {
      expect(src, `${name} must import the cloud model deny-list`).toMatch(/CLOUD_MODEL_IDENTIFIERS/);
    }
  });
});

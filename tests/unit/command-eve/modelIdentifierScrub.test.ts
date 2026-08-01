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

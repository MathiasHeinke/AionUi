/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * THE SCRUB, EXTENDED TO THE LOCALE SINK.
 *
 * The founder mandate is that no user-visible surface names the upstream provider
 * or a model id. That rule is enforced at the ERROR path (`scrubUpstreamErrorBody`
 * and friends) — text that arrives from upstream is cleaned before it is shown.
 *
 * A shipped translation string reaches the user without passing that choke point
 * at all, and one did: `conversation.cloudOcrDescription` named the
 * "OpenRouter-Gateway" / "OpenRouter gateway" in the Cloud-OCR consent dialog, in
 * both shipped locales. Scrubbing the dynamic path while the static copy says the
 * name out loud is not a scrub; it is a scrub with a documented exception.
 *
 * SCOPE — deliberately `conversation`, not every namespace. The BYOK settings
 * surface legitimately names providers: the user is configuring their OWN
 * OpenRouter/Anthropic/etc. key there, and hiding the name would make the setting
 * unusable. What must stay clean is the conversation surface, where the provider
 * behind Command EVE's own managed lane is not the user's business and naming it
 * makes a promise about routing we do not want to make.
 *
 * NAMING: `.test.ts` — the vitest `node` project takes `tests/unit/**\/*.test.ts`
 * and excludes `*.dom.test.*`. Reading JSON needs no DOM.
 */

import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const LOCALES = path.resolve(__dirname, '../../../packages/desktop/src/renderer/services/i18n/locales');

/** The shipped, user-facing languages. */
const SHIPPED = fs
  .readdirSync(LOCALES, { withFileTypes: true })
  .filter((e) => e.isDirectory())
  .map((e) => e.name);

/**
 * Upstream provider + model identifiers. Matched case-insensitively as whole
 * words, so ordinary prose ("flashing", "gemma-like") cannot trip it while the
 * real names cannot slip through.
 */
const FORBIDDEN = [
  'openrouter',
  'deepseek',
  'moonshot',
  'kimi',
  'anthropic',
  'claude',
  'openai',
  'gpt-4',
  'gpt-5',
  'z-ai',
  'glm',
];

/** Flatten a nested bundle to `path -> string` so a failure names the exact key. */
function flatten(node: unknown, prefix = ''): Array<[string, string]> {
  if (typeof node === 'string') return [[prefix, node]];
  if (!node || typeof node !== 'object') return [];
  return Object.entries(node as Record<string, unknown>).flatMap(([k, v]) => flatten(v, prefix ? `${prefix}.${k}` : k));
}

describe('the conversation locale bundles name no upstream provider', () => {
  it('has locales to check at all (a silent empty sweep is not a pass)', () => {
    expect(SHIPPED.length).toBeGreaterThan(0);
    expect(SHIPPED).toContain('de-DE');
    expect(SHIPPED).toContain('en-US');
  });

  for (const locale of SHIPPED) {
    it(`${locale}/conversation.json is clean`, () => {
      const file = path.join(LOCALES, locale, 'conversation.json');
      if (!fs.existsSync(file)) return; // not every locale ships every namespace
      const entries = flatten(JSON.parse(fs.readFileSync(file, 'utf-8')));
      expect(entries.length, `${locale}/conversation.json parsed to nothing`).toBeGreaterThan(0);

      const offenders: string[] = [];
      for (const [key, value] of entries) {
        for (const name of FORBIDDEN) {
          if (new RegExp(`\\b${name}\\b`, 'i').test(value)) {
            offenders.push(`${key}: "${name}"`);
          }
        }
      }
      expect(offenders, `provider identifiers in ${locale}/conversation.json`).toEqual([]);
    });
  }

  it('the Cloud-OCR consent copy still explains the cloud hop, just without the vendor', () => {
    // Scrubbing must not have removed the DISCLOSURE. The user is being asked to
    // send a document off-device; that fact has to stay legible.
    for (const [locale, needles] of [
      ['de-DE', ['Cloud-Gateway', 'Zero Data Retention']],
      ['en-US', ['cloud gateway', 'Zero Data Retention']],
    ] as const) {
      const bundle = JSON.parse(fs.readFileSync(path.join(LOCALES, locale, 'conversation.json'), 'utf-8')) as Record<
        string,
        Record<string, string>
      >;
      const copy = Object.fromEntries(flatten(bundle));
      const description = Object.entries(copy).find(([k]) => k.endsWith('cloudOcrDescription'))?.[1];
      expect(description, `${locale} must still define cloudOcrDescription`).toBeTruthy();
      for (const needle of needles) {
        expect(description as string).toContain(needle);
      }
    }
  });
});

/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 *
 * Packaged-i18n release gate (recipe: `just test-packaged-i18n`).
 *
 * Verifies that the packaged renderer (`out/renderer`, produced by
 * `bun run package`) contains complete i18n resources. The renderer loads all
 * locales via static imports (`renderer/services/i18n/index.ts`), so every
 * supported language's strings must end up inside the built JS bundle — a
 * packaged app that cannot switch language because a locale was shaken out or
 * never bundled must fail this gate before release.
 *
 * What is asserted:
 *   1. `out/renderer/index.html` exists and references an entry chunk.
 *   2. Marker strings sampled from the SOURCE locale files of every
 *      `supportedLanguages` entry (i18n-config.json) are present in the
 *      concatenated bundle of `out/renderer/assets/*.js`.
 *   3. Import parity: every locale directory has an `index.ts` and is
 *      statically imported by the i18n service (a locale that exists on disk
 *      but is never imported would silently be missing from the bundle).
 *   4. Governed-shell brand asset is part of the packaged output.
 *
 * Markers are derived from the source locale JSONs at test time (not
 * hardcoded), so copy changes do not break the gate; minification keeps
 * string literals (incl. non-ASCII) intact, which is verified here against
 * the real build output.
 */
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const rendererOut = path.join(repoRoot, 'out', 'renderer');
const assetsDir = path.join(rendererOut, 'assets');
const localesDir = path.join(repoRoot, 'packages/desktop/src/renderer/services/i18n/locales');
const i18nServicePath = path.join(repoRoot, 'packages/desktop/src/renderer/services/i18n/index.ts');
const i18nConfigPath = path.join(repoRoot, 'packages/desktop/src/common/config/i18n-config.json');

type I18nConfig = {
  referenceLanguage: string;
  fallbackLanguage: string;
  supportedLanguages: string[];
  modules: string[];
};

function readJson<T>(file: string): T {
  return JSON.parse(readFileSync(file, 'utf8')) as T;
}

/** Collects flat string values of a nested locale JSON object. */
function collectStrings(value: unknown, acc: string[] = []): string[] {
  if (typeof value === 'string') acc.push(value);
  else if (value && typeof value === 'object') {
    for (const child of Object.values(value as Record<string, unknown>)) collectStrings(child, acc);
  }
  return acc;
}

/**
 * Picks up to `limit` deterministic marker strings from a locale module.
 * Long values are preferred: they cannot collide with unrelated bundle code.
 */
function pickMarkers(moduleJson: unknown, limit: number): string[] {
  return collectStrings(moduleJson)
    .filter((s) => s.length >= 14 && !s.includes('://'))
    .toSorted((a, b) => b.length - a.length)
    .slice(0, limit);
}

const buildAvailable = existsSync(rendererOut) && existsSync(assetsDir);

describe('packaged i18n gate', () => {
  it('has a packaged renderer build (run `bun run package` first)', () => {
    expect(buildAvailable, 'out/renderer is missing — run `bun run package` before `just test-packaged-i18n`').toBe(
      true
    );
  });

  it('index.html references an entry chunk that exists on disk', () => {
    if (!buildAvailable) return;
    const indexHtml = readFileSync(path.join(rendererOut, 'index.html'), 'utf8');
    const match = indexHtml.match(/assets\/(index-[^"]+\.js)/);
    expect(match, 'no entry chunk referenced from index.html').toBeTruthy();
    expect(existsSync(path.join(assetsDir, match![1])), `entry chunk ${match![1]} missing`).toBe(true);
  });

  it('bundle contains every supported language', () => {
    if (!buildAvailable) return;
    const config = readJson<I18nConfig>(i18nConfigPath);
    expect(config.supportedLanguages.length).toBeGreaterThan(0);

    // Load the full bundle once (tens of MB) and search markers in-memory.
    const bundle = readdirSync(assetsDir)
      .filter((f) => f.endsWith('.js'))
      .map((f) => readFileSync(path.join(assetsDir, f), 'utf8'))
      .join('\n');
    expect(bundle.length).toBeGreaterThan(0);

    // Probe three representative modules per language, two markers each.
    const probeModules = ['common', 'settings', 'guid'];
    for (const lang of config.supportedLanguages) {
      let langMarkers = 0;
      for (const mod of probeModules) {
        const modulePath = path.join(localesDir, lang, `${mod}.json`);
        if (!existsSync(modulePath)) continue;
        const markers = pickMarkers(readJson(modulePath), 2);
        for (const marker of markers) {
          langMarkers += 1;
          expect(
            bundle.includes(marker),
            `locale ${lang}/${mod} marker missing from packaged bundle: ${JSON.stringify(marker.slice(0, 80))}`
          ).toBe(true);
        }
      }
      expect(langMarkers, `no probeable markers found for ${lang}`).toBeGreaterThan(0);
    }
  });

  it('every locale directory is statically imported by the i18n service', () => {
    const serviceSource = readFileSync(i18nServicePath, 'utf8');
    const localeDirs = readdirSync(localesDir, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => d.name);
    expect(localeDirs.length).toBeGreaterThan(0);
    for (const lang of localeDirs) {
      expect(existsSync(path.join(localesDir, lang, 'index.ts')), `${lang}/index.ts missing`).toBe(true);
      // e.g. `import deDE from './locales/de-DE/index';`
      expect(
        serviceSource.includes(`./locales/${lang}/index`),
        `locale ${lang} is not statically imported in services/i18n/index.ts — it would be missing from the packaged bundle`
      ).toBe(true);
    }
  });

  it('governed-shell brand asset is part of the packaged output', () => {
    if (!buildAvailable) return;
    expect(existsSync(path.join(rendererOut, 'command-eve-brand.json'))).toBe(true);
  });
});

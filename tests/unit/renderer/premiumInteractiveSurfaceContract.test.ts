/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { extname, join, relative, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const rendererRoot = resolve(process.cwd(), 'packages/desktop/src/renderer');
const sourceExtensions = new Set(['.ts', '.tsx']);
const productionExtensions = new Set(['.css', '.scss', '.less', '.ts', '.tsx']);

const withoutBlockComments = (source: string): string => source.replace(/\/\*[\s\S]*?\*\//g, '');

function sourceFiles(root: string): string[] {
  const result: string[] = [];
  for (const entry of readdirSync(root)) {
    const absolute = join(root, entry);
    if (statSync(absolute).isDirectory()) {
      result.push(...sourceFiles(absolute));
    } else if (sourceExtensions.has(extname(entry))) {
      result.push(absolute);
    }
  }
  return result;
}

const sources = sourceFiles(rendererRoot).map((absolute) => ({
  path: relative(process.cwd(), absolute),
  source: readFileSync(absolute, 'utf8'),
}));

const productionSources = sourceFilesByExtension(rendererRoot, productionExtensions).map((absolute) => ({
  path: relative(process.cwd(), absolute),
  source: withoutBlockComments(readFileSync(absolute, 'utf8')),
}));

function sourceFilesByExtension(root: string, extensions: ReadonlySet<string>): string[] {
  const result: string[] = [];
  for (const entry of readdirSync(root)) {
    const absolute = join(root, entry);
    if (statSync(absolute).isDirectory()) {
      result.push(...sourceFilesByExtension(absolute, extensions));
    } else if (extensions.has(extname(entry))) {
      result.push(absolute);
    }
  }
  return result;
}

function lineFor(source: string, offset: number): number {
  return source.slice(0, offset).split('\n').length;
}

describe('app-wide premium interactive surface contract', () => {
  it('uses Icon Park as the only application icon library outside file-type content rendering', () => {
    const legacyImports = sources.filter(({ source }) => source.includes("from '@arco-design/web-react/icon'"));
    expect(legacyImports.map(({ path }) => path)).toEqual([]);

    const allowedContentIconLibraries = new Set([
      'packages/desktop/src/renderer/pages/conversation/Workspace/components/FileTypeIcon.tsx',
    ]);
    const foreignIconImports = sources.filter(
      ({ path, source }) =>
        /from ['"](?:@iconify|@fortawesome|lucide-react|react-icons)/.test(source) &&
        !allowedContentIconLibraries.has(path)
    );
    expect(foreignIconImports.map(({ path }) => path)).toEqual([]);
  });

  it('keeps SVG imports limited to content, provider and brand identity assets', () => {
    const allowedSvgAssets = new Set([
      'packages/desktop/src/renderer/components/media/FilePreview.tsx',
      'packages/desktop/src/renderer/hooks/agent/usePresetAssistantInfo.ts',
      'packages/desktop/src/renderer/pages/settings/AssistantSettings/index.tsx',
      'packages/desktop/src/renderer/pages/guid/constants.ts',
      'packages/desktop/src/renderer/pages/guid/components/AssistantSelectionArea.tsx',
      'packages/desktop/src/renderer/components/settings/SettingsModal/contents/channels/ChannelHeader.tsx',
    ]);
    const svgImports = sources.filter(
      ({ path, source }) => /from ['"][^'"]+\.svg['"]/.test(source) && !allowedSvgAssets.has(path)
    );
    expect(svgImports.map(({ path }) => path)).toEqual([]);
  });

  it('does not fake interactive icons with text glyphs', () => {
    const fakeGlyph = />\s*[△▴▾✓⌘]\s*</g;
    const offenders = sources.flatMap(({ path, source }) =>
      [...source.matchAll(fakeGlyph)].map((match) => ({
        path,
        line: lineFor(source, match.index ?? 0),
        value: match[0],
      }))
    );
    expect(offenders).toEqual([]);
  });

  it('keeps handcrafted SVG limited to data visualization/rendering seams', () => {
    const allowed = new Set([
      'packages/desktop/src/renderer/components/Markdown/MermaidBlock.tsx',
      'packages/desktop/src/renderer/components/agent/ContextUsageIndicator.tsx',
    ]);
    const inlineSvg = sources.filter(({ source }) => /<svg\b/.test(source));
    expect(inlineSvg.map(({ path }) => path).toSorted()).toEqual([...allowed].toSorted());
  });

  it('mounts the global premium icon provider above Arco controls', () => {
    const main = sources.find(({ path }) => path === 'packages/desktop/src/renderer/main.tsx')?.source ?? '';
    expect(main).toContain('PremiumIconProvider');
    expect(main).toMatch(
      /React\.createElement\([\s\S]*PremiumIconProvider[\s\S]*React\.createElement\([\s\S]*ConfigProvider/
    );
    expect(main).toContain('componentConfig: PREMIUM_ARCO_COMPONENT_CONFIG');
  });

  it('keeps visible app icons free of fixed hex, white or black fills', () => {
    const dataVisualizationAllowlist = new Set([
      'packages/desktop/src/renderer/components/Markdown/MermaidBlock.tsx',
      'packages/desktop/src/renderer/components/agent/ContextUsageIndicator.tsx',
    ]);
    const literalFill = /\bfill\s*(?:=|:)\s*\{?\s*['"`](?:#[0-9a-f]{3,8}|white|black)['"`]\s*\}?/gi;
    const offenders = sources.flatMap(({ path, source }) => {
      if (dataVisualizationAllowlist.has(path)) return [];
      return [...source.matchAll(literalFill)].map((match) => ({
        path,
        line: lineFor(source, match.index ?? 0),
        value: match[0],
      }));
    });

    expect(offenders).toEqual([]);
  });

  it('keeps interactive motion out of the hardcoded 100-250ms speed band', () => {
    const fastDeclaration =
      /(?:transition|animation)(?:-duration)?\s*:\s*['"`]?[^;'"`\n}]*(?:\b(?:1\d{2}|2[0-4]\d|250)ms\b|\b0\.(?:1\d*|2(?:[0-4]\d*|5(?:0*)?))s\b)/gi;
    const fastUtility = /\bduration-(?:100|150|200|250)\b/g;
    const nonInteractiveAllowlist = new Map<string, RegExp[]>([
      ['packages/desktop/src/renderer/components/media/UploadProgressBar.tsx', [/\bduration-200\b/]],
    ]);

    const offenders = productionSources.flatMap(({ path, source }) => {
      const matches = [...source.matchAll(fastDeclaration), ...source.matchAll(fastUtility)];
      const allowed = nonInteractiveAllowlist.get(path) ?? [];
      return matches
        .filter((match) => !allowed.some((pattern) => pattern.test(match[0])))
        .map((match) => ({
          path,
          line: lineFor(source, match.index ?? 0),
          value: match[0],
        }));
    });

    expect(offenders).toEqual([]);
  });
});

import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const rendererRoot = path.resolve(process.cwd(), 'packages/desktop/src/renderer');
const read = (relativePath: string): string => fs.readFileSync(path.join(rendererRoot, relativePath), 'utf8');

const collectSourceFiles = (directory: string): string[] => {
  const entries = fs.readdirSync(directory, { withFileTypes: true });
  return entries.flatMap((entry) => {
    const absolutePath = path.join(directory, entry.name);
    if (entry.isDirectory()) return collectSourceFiles(absolutePath);
    return /\.(?:css|ts|tsx)$/.test(entry.name) ? [absolutePath] : [];
  });
};

describe('Command EVE visual rails', () => {
  it('keeps public renderer consumers off the legacy AOU palette', () => {
    const allowed = new Set([
      path.join(rendererRoot, 'styles/themes/default-color-scheme.css'),
      path.join(rendererRoot, 'styles/themes/README.md'),
      path.join(rendererRoot, 'styles/MIGRATION.md'),
    ]);
    const presetRoot = path.join(rendererRoot, 'pages/settings/AppearanceSettings/presets');
    const offenders = collectSourceFiles(rendererRoot).filter((file) => {
      if (allowed.has(file) || file.startsWith(presetRoot)) return false;
      return fs.readFileSync(file, 'utf8').includes('--aou-');
    });

    expect(offenders).toEqual([]);
  });

  it('uses one blur owner for search and no blur per pill', () => {
    const visualCss = read('styles/themes/command-eve-visual.css');
    const pillBlock = visualCss.match(/\.eve-pill \{([\s\S]*?)\n\}/)?.[1] ?? '';
    const searchCss = read('pages/conversation/GroupedHistory/ConversationSearchPopover.css');
    const innerBlock = searchCss.match(/\.conversation-search-modal__panel \{([\s\S]*?)\n\}/)?.[1] ?? '';

    expect(pillBlock).not.toContain('backdrop-filter');
    expect(searchCss).toContain('backdrop-filter: var(--glass-overlay-filter);');
    expect(innerBlock).toContain('backdrop-filter: none;');
  });

  it('routes legacy and composed modals through explicit EVE dialog owners', () => {
    const aionModal = read('components/base/AionModal.tsx');
    const modalWrapper = read('components/base/ModalWrapper.tsx');
    const overrideCss = read('styles/arco-override.css');

    expect(aionModal).toContain('aionui-modal--composed');
    expect(aionModal).toContain('aionui-modal-wrapper eve-dialog');
    expect(modalWrapper).toContain('aionui-modal--legacy');
    expect(overrideCss).toContain('.arco-modal.aionui-modal--legacy');
    expect(overrideCss).toContain('background: var(--glass-overlay-bg) !important;');
  });

  it('skins toasts with semantic hairlines instead of fixed gradients', () => {
    const overrideCss = read('styles/arco-override.css');
    const messageBlock = overrideCss.slice(overrideCss.indexOf('/* Arco Message custom styles */'));

    expect(messageBlock).toContain('background: var(--glass-overlay-bg) !important;');
    expect(messageBlock).toContain('border-left: 2px solid var(--eve-status-completed) !important;');
    expect(messageBlock).not.toContain('linear-gradient(270deg, #f9fff2');
  });
});

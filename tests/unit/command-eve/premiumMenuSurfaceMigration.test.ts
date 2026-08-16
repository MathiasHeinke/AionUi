import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const root = process.cwd();
const source = (relativePath: string) => fs.readFileSync(path.join(root, relativePath), 'utf8');

const customSurfaceFiles = [
  'packages/desktop/src/renderer/components/media/FileAttachButton.tsx',
  'packages/desktop/src/renderer/pages/guid/components/MentionDropdown.tsx',
  'packages/desktop/src/renderer/components/workspace/WorkspaceFolderSelect.tsx',
  'packages/desktop/src/renderer/components/settings/DirectorySelectionModal.tsx',
];

describe('premium custom menu surface migration', () => {
  it.each(customSurfaceFiles)('%s consumes the shared menu vocabulary', (relativePath) => {
    const content = source(relativePath);
    expect(content).toContain('eve-menu-surface');
    expect(content).toContain('eve-menu-item');
  });

  it('uses semantic colors and Phosphor chevrons throughout the migrated surfaces', () => {
    const content = [
      ...customSurfaceFiles,
      'packages/desktop/src/renderer/components/chat/MobileActionSheet/MobileActionSheet.tsx',
      'packages/desktop/src/renderer/components/chat/MobileActionSheet/MobileActionSheet.module.css',
      'packages/desktop/src/renderer/components/workspace/WorkspaceFolderSelect.module.css',
      'packages/desktop/src/renderer/components/settings/DirectorySelectionModal.module.css',
    ]
      .map(source)
      .join('\n');

    expect(content).not.toMatch(/#[\da-f]{3,8}\b/i);
    expect(content).not.toMatch(/rgba?\s*\(/i);
    expect(content).not.toMatch(/[▾▴△]/);
    expect(content).not.toContain('TRANSITION_MS = 260');
    expect(content).not.toContain('setTimeout(() => setMounted(false), 280)');
  });

  it('keeps deliberate 400ms-class motion and reduced-motion exits', () => {
    const mobileSource = source(
      'packages/desktop/src/renderer/components/chat/MobileActionSheet/MobileActionSheet.tsx'
    );
    const mobileStyles = source(
      'packages/desktop/src/renderer/components/chat/MobileActionSheet/MobileActionSheet.module.css'
    );
    const workspaceSource = source('packages/desktop/src/renderer/components/workspace/WorkspaceFolderSelect.tsx');
    const workspaceStyles = source(
      'packages/desktop/src/renderer/components/workspace/WorkspaceFolderSelect.module.css'
    );

    expect(mobileSource).toContain('const TRANSITION_MS = 400');
    expect(workspaceSource).toContain('const MENU_TRANSITION_MS = 400');
    expect(mobileStyles).toContain('@media (prefers-reduced-motion: reduce)');
    expect(workspaceStyles).toContain('@media (prefers-reduced-motion: reduce)');
  });
});

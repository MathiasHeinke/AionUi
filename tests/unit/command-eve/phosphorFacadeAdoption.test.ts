import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * The Phosphor migration used to travel as a patch artifact because the slice
 * sat on an older base. It now sits on the integration base, so adoption is
 * asserted against the real source instead of against a description of it.
 */
const read = (relativePath: string): string => readFileSync(resolve(process.cwd(), relativePath), 'utf8');

const MIGRATED_SOURCES = [
  'packages/desktop/src/renderer/components/layout/Titlebar/DurableWorkActivity/index.tsx',
  'packages/desktop/src/renderer/pages/conversation/Messages/acp/MessageAcpClarify.tsx',
  'packages/desktop/src/renderer/pages/conversation/Messages/components/ProjectWorkspaceCard/FinalizeProjectAssignmentDialog.tsx',
  'packages/desktop/src/renderer/pages/conversation/Messages/components/ProjectWorkspaceCard/index.tsx',
  'packages/desktop/src/renderer/pages/kanban/NativeKanbanBoard.tsx',
];

const MIGRATED_TEST_MOCKS = [
  'tests/unit/command-eve/typed-ui/messageToolGroup.dom.test.tsx',
  'tests/unit/preview/browser/WebviewHostBrowserControl.dom.test.tsx',
];

describe('Phosphor facade adoption on the integration base', () => {
  it('imports every generic glyph from the facade, including the project assignment dialog', () => {
    for (const path of MIGRATED_SOURCES) {
      const source = read(path);
      expect(source, `${path} must not import Icon Park`).not.toContain('@icon-park/react');
      expect(source, `${path} must import the facade`).toContain("from '@renderer/components/icons'");
    }
  });

  it('points the focused test mocks at the facade module', () => {
    for (const path of MIGRATED_TEST_MOCKS) {
      const source = read(path);
      expect(source, `${path} must not mock Icon Park`).not.toContain("vi.mock('@icon-park/react'");
      expect(source, `${path} must mock the facade`).toContain("vi.mock('@renderer/components/icons'");
    }
  });

  it('drops the Icon Park dependency from the root manifest', () => {
    expect(read('package.json')).not.toContain('@icon-park/react');
  });

  it('states native Kanban permission and verification outcomes as semantic glyphs', () => {
    const source = read('packages/desktop/src/renderer/pages/kanban/NativeKanbanBoard.tsx');

    expect(source).toContain('const BooleanStatusIcon');
    expect(source).toContain('<BooleanStatusIcon value={status.accessibility} />');
    expect(source).toContain('<BooleanStatusIcon value={status.screen_recording} />');
    expect(source).toContain('<BooleanStatusIcon value={status.provenance.checksum_verified} />');
    // Free-form backend check text stays textual; only its missing value is localized.
    expect(source).toContain("{check.status || t('kanban.governance.unknown')}");
    expect(source, 'no generic status punctuation may remain').not.toMatch(/'[✓×–]'/);
  });
});

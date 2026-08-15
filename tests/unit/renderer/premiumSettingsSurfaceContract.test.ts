/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const read = (relativePath: string): string => readFileSync(resolve(process.cwd(), relativePath), 'utf8');

describe('premium settings surface consumption', () => {
  const sider = read('packages/desktop/src/renderer/pages/settings/components/SettingsSider.tsx');
  const wrapper = read('packages/desktop/src/renderer/pages/settings/components/SettingsPageWrapper.tsx');
  const modal = read('packages/desktop/src/renderer/components/settings/SettingsModal/index.tsx');
  const authority = read(
    'packages/desktop/src/renderer/components/settings/SettingsModal/contents/AuthorityModalContent.tsx'
  );
  const skills = read('packages/desktop/src/renderer/pages/settings/SkillsHubSettings.tsx');
  const scheduled = read('packages/desktop/src/renderer/pages/cron/ScheduledTasksPage/index.tsx');

  it('uses one canonical built-in navigation registry in desktop, mobile and compatibility modal', () => {
    for (const source of [sider, wrapper, modal]) {
      expect(source).toContain('getBuiltinSettingsNavigationItems');
    }
    expect(sider).toContain('<EveIconTile');
    expect(wrapper).toContain('<EveIconTile');
    expect(modal).toContain('<EveIconTile');
    expect(modal).not.toContain('iconColors');
  });

  it('renders authority effects through aligned tiles and one coherent browser-desktop glyph', () => {
    expect(authority).toContain('<EveIconTile');
    expect(authority).toContain('<SettingComputer />');
    expect(authority).not.toMatch(/<Browser\b/);
    expect(authority).not.toMatch(/<Computer\b/);
  });

  it('uses the composed modal and native scroll area for the skill reader', () => {
    const reader = skills.slice(skills.indexOf('<AionModal'), skills.lastIndexOf('</AionModal>') + 12);
    expect(reader).toContain("className='eve-settings-dialog eve-settings-reader-modal'");
    expect(reader).toContain('<AionScrollArea');
    expect(reader).toContain('<EveIconTile');
    expect(reader).not.toContain("theme='filled'");
  });

  it('uses the shared page and quiet empty-state primitives for scheduled tasks', () => {
    expect(scheduled).toContain("'eve-page w-full");
    expect(scheduled).toContain("className='eve-page-header'");
    expect(scheduled).toContain("className='eve-empty-state");
    expect(scheduled).toContain('<CalendarThirty');
    expect(scheduled).not.toContain('border-dashed');
  });
});

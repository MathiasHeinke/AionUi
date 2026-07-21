import { describe, expect, it } from 'vitest';
import de from '@/renderer/services/i18n/locales/de-DE/common.json';
import en from '@/renderer/services/i18n/locales/en-US/common.json';
import { PROJECT_WORKSPACE_REASON_CODES } from '@/renderer/pages/projects/types';

describe('project workspace localization', () => {
  it.each(PROJECT_WORKSPACE_REASON_CODES)('maps %s to complete English and German copy', (reason) => {
    expect(en.projects.reasons[reason].title).not.toBe('');
    expect(en.projects.reasons[reason].description).not.toBe('');
    expect(de.projects.reasons[reason].title).not.toBe('');
    expect(de.projects.reasons[reason].description).not.toBe('');
  });

  it('keeps the lifecycle states and primary controls in both locales', () => {
    expect(Object.keys(de.projects.artifact.state)).toEqual(Object.keys(en.projects.artifact.state));
    expect(de.projects.create.action).not.toBe(en.projects.create.action);
    expect(de.projects.adopt.action).not.toBe(en.projects.adopt.action);
  });

  it('ships the chatIntent copy in both locales with interpolation anchors (1.818 CAO-P2)', () => {
    expect(Object.keys(de.projects.chatIntent)).toEqual(Object.keys(en.projects.chatIntent));
    expect(en.projects.chatIntent.boundSummary).toContain('{{title}}');
    expect(de.projects.chatIntent.boundSummary).toContain('{{title}}');
    expect(en.projects.chatIntent.clarifyQuestion).toContain('{{titles}}');
    expect(de.projects.chatIntent.clarifyQuestion).toContain('{{titles}}');
    // German copy stays German; the locales must not collapse into one.
    expect(de.projects.chatIntent.clarifyQuestion).not.toBe(en.projects.chatIntent.clarifyQuestion);
    expect(de.projects.chatIntent.listOr).not.toBe(en.projects.chatIntent.listOr);
  });
});

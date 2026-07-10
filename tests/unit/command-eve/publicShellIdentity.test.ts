import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const root = process.cwd();
const read = (file: string): string => fs.readFileSync(path.join(root, file), 'utf8');

describe('Command EVE public shell identity', () => {
  it('never exposes the raw agent catalog when the EVE seed is unavailable', () => {
    const guidPage = read('packages/desktop/src/renderer/pages/guid/GuidPage.tsx');
    const guidSend = read('packages/desktop/src/renderer/pages/guid/hooks/useGuidSend.ts');

    expect(guidPage).toContain('const isCommandEveAssistant = COMMAND_EVE_SHELL_ENABLED;');
    expect(guidSend).toContain('const isCommandEveAssistant = COMMAND_EVE_SHELL_ENABLED;');
    expect(guidPage).toContain('isCommandEveAssistant ? COMMAND_EVE_DISPLAY_NAME : mention.selectedAgentLabel');
    expect(guidSend).not.toContain('EVE/Hermes');
    expect(guidSend).toContain("Message.error(t('conversation.createFailed'");
  });
});

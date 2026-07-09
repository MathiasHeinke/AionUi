import fs from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

describe('Command EVE runtime bridge registration', () => {
  it('registers every renderer-declared runtime provider in the active app entrypoint', () => {
    const source = fs.readFileSync(path.resolve(__dirname, '../../../packages/desktop/src/index.ts'), 'utf8');
    for (const provider of [
      'runtimeStatus',
      'ensureAssistant',
      'ensureLocalModelTier',
      'warmLocalModel',
      'evaluateGateDecision',
    ]) {
      expect(source).toContain(`ipcBridge.commandEve.${provider}.provider`);
    }
  });
});

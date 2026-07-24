/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import fs from 'node:fs';
import path from 'node:path';
import yauzl from 'yauzl';
import { describe, expect, it } from 'vitest';

function readWheelEntry(wheelPath: string, entryName: string): Promise<string> {
  return new Promise((resolve, reject) => {
    yauzl.open(wheelPath, { lazyEntries: true }, (openError, zipFile) => {
      if (openError || !zipFile) {
        reject(openError ?? new Error(`Could not open wheel: ${wheelPath}`));
        return;
      }

      let found = false;
      const fail = (error: Error): void => {
        zipFile.close();
        reject(error);
      };

      zipFile.on('error', fail);
      zipFile.on('end', () => {
        if (!found) fail(new Error(`Wheel entry not found: ${entryName}`));
      });
      zipFile.on('entry', (entry) => {
        if (entry.fileName !== entryName) {
          zipFile.readEntry();
          return;
        }

        found = true;
        zipFile.openReadStream(entry, (streamError, stream) => {
          if (streamError || !stream) {
            fail(streamError ?? new Error(`Could not read wheel entry: ${entryName}`));
            return;
          }
          const chunks: Buffer[] = [];
          stream.on('data', (chunk: Buffer) => chunks.push(chunk));
          stream.on('error', fail);
          stream.on('end', () => {
            zipFile.close();
            resolve(Buffer.concat(chunks).toString('utf8'));
          });
        });
      });
      zipFile.readEntry();
    });
  });
}

describe('bundled Hermes ACP approval timeout', () => {
  it('keeps a recovered permission actionable beyond one minute', async () => {
    const wheelPath = path.resolve('resources', 'bundled-hermes', 'hermes_agent-0.17.0-py3-none-any.whl');
    expect(fs.existsSync(wheelPath)).toBe(true);

    const source = await readWheelEntry(wheelPath, 'acp_adapter/permissions.py');
    expect(source).toContain('DEFAULT_PERMISSION_TIMEOUT_SECONDS = 300.0');
    expect(source).toContain('timeout: float = DEFAULT_PERMISSION_TIMEOUT_SECONDS');
  });
});

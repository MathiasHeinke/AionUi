/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * The provider-call correlation wire has a reader and no writer (1.823.0).
 *
 * `commandEveProviderCallContext` mints the v3 receipt only from
 * `x-command-eve-turn-id` and `x-command-eve-call-index`. Nothing in this
 * repository sends them, the emitted seat runtime does not add them, and the
 * bundled Hermes wheel contains no `x-command-eve` header at all. A real turn
 * therefore yields a v2 receipt carrying a fresh UUID, and the TTFT formal gate
 * — which selects on `command-eve-upstream-outcome/v3` — can only ever answer
 * INSUFFICIENT_EVIDENCE.
 *
 * The shim's own tests set both headers themselves. That proves the reader
 * parses what it is handed; it cannot prove the wire, and without this guard the
 * green run reads as though it did.
 *
 * This test is meant to go red the day a producer lands, because a producer
 * alone does not make the gate measurable. Hermes mints
 * `api_request_id = f"{turn_id}:api:{api_call_count}"` ONCE before its retry
 * loop (whl:agent/conversation_loop.py), while the shim writes a constant
 * `attempt_count: 1`. One transient retry then emits two receipts under a
 * single identity and the gate's "exactly one provider receipt" rule rejects the
 * turn; its `call_index === 1` rule additionally excludes every tool-loop turn.
 * Whoever adds the writer owns both contract questions in the same change.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const CORRELATION_HEADERS = ['x-command-eve-turn-id', 'x-command-eve-call-index'] as const;
const SEARCH_ROOTS = ['packages', 'scripts'] as const;
const SOURCE_SUFFIXES = ['.ts', '.tsx', '.js', '.mjs', '.cjs', '.py'] as const;
const SHIM_READER = 'packages/desktop/src/process/commandEve/ollamaOpenAiShim.ts';
const HEADER_NAMESPACE = 'x-command-eve';
const WHEEL_PATH = fileURLToPath(
  new URL('../../../resources/bundled-hermes/hermes_agent-0.20.0-py3-none-any.whl', import.meta.url)
);

function sourceFilesUnder(root: string): string[] {
  const absoluteRoot = path.resolve(root);
  if (!fs.existsSync(absoluteRoot)) return [];
  const files: string[] = [];
  const pending = [absoluteRoot];
  while (pending.length > 0) {
    const directory = pending.pop() as string;
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue;
      const entryPath = path.join(directory, entry.name);
      if (entry.isDirectory()) pending.push(entryPath);
      else if (SOURCE_SUFFIXES.some((suffix) => entry.name.endsWith(suffix))) files.push(entryPath);
    }
  }
  return files;
}

/**
 * Wheel members that mention the header namespace, read from the DECOMPRESSED
 * entries. Searching the archive bytes would answer "no" for a wheel that does
 * carry the header, because deflate leaves no plain substring behind.
 */
async function wheelEntriesMentioningHeaderNamespace(): Promise<string[]> {
  const yauzl = await import('yauzl');
  const buffer = fs.readFileSync(WHEEL_PATH);
  return new Promise<string[]>((resolve, reject) => {
    const matches: string[] = [];
    yauzl.fromBuffer(buffer, { lazyEntries: true }, (openError, zip) => {
      if (openError || !zip) return reject(openError ?? new Error('bundled Hermes wheel could not be opened'));
      zip.on('entry', (entry: { fileName: string }) => {
        if (entry.fileName.endsWith('/')) return zip.readEntry();
        zip.openReadStream(entry, (streamError, stream) => {
          if (streamError || !stream) {
            return reject(streamError ?? new Error(`wheel entry unreadable: ${entry.fileName}`));
          }
          const chunks: Buffer[] = [];
          stream.on('error', reject);
          stream.on('data', (chunk: Buffer) => chunks.push(chunk));
          stream.on('end', () => {
            if (Buffer.concat(chunks).toString('utf8').includes(HEADER_NAMESPACE)) matches.push(entry.fileName);
            zip.readEntry();
          });
        });
      });
      zip.on('error', reject);
      zip.on('end', () => resolve(matches));
      zip.readEntry();
    });
  });
}

describe('Command EVE provider-call correlation wire', () => {
  it('has no producer, so the TTFT formal gate cannot observe a real turn', () => {
    const referencing = new Set<string>();
    for (const root of SEARCH_ROOTS) {
      for (const file of sourceFilesUnder(root)) {
        const contents = fs.readFileSync(file, 'utf8');
        if (CORRELATION_HEADERS.some((header) => contents.includes(header))) {
          referencing.add(path.relative(process.cwd(), file));
        }
      }
    }

    expect([...referencing].toSorted()).toEqual([SHIM_READER]);
  });

  it('confirms the bundled Hermes wheel never sends the header the shim reads', async () => {
    await expect(wheelEntriesMentioningHeaderNamespace()).resolves.toEqual([]);
  });
});

/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * B7 (CEVE-1821) — EVE writes an HTML file and the user sees it.
 *
 * Same shape as B1: the display layer was finished and had no producer.
 * PreviewPanel renders the split-screen HTML editor + renderer for
 * content_type 'html' (PreviewPanel.tsx:275, :531-620), fileType.ts:21-22 maps
 * .html/.htm onto it, and launchPreview already reads a file off disk. Nothing
 * ever asked it to.
 *
 * THE MEASUREMENT THAT SHAPED THIS FILE. The brief said "bind on completion" —
 * right, because at start_tool_call the file is not on disk and the approval may
 * still be pending. But the completion update does NOT carry the path:
 * build_tool_complete (acp_adapter/tools.py:1305-1329) calls update_tool_call
 * with tool_call_id / kind / status / content / raw_output and nothing else — no
 * locations, no title — and raw_output is None because write_file is in
 * _POLISHED_TOOLS (tools.py:66). The path is only on the START update, twice:
 * locations[0].path (tools.py:1338-1347) and the `write: <path>` title
 * (tools.py:103-104).
 *
 * So the bind is TWO-PHASE: remember at start, spend at completion. These tests
 * pin both halves and the seam between them.
 */

import { describe, expect, it } from 'vitest';
import {
  collectHtmlWriteFromToolCallStart,
  extractWriteTargetPath,
  isCompletedToolCallUpdate,
  shouldOpenHtmlPreview,
} from '@/common/config/htmlArtifactPreviewCore';
import { getFileTypeInfo } from '@/renderer/utils/file/fileType';

/** The one resolver, taken from the one table (fileType.ts). Never re-declared here. */
const resolve = (fileName: string) => getFileTypeInfo(fileName).contentType;

/** The START shape the wheel really writes for a write_file tool call. */
const writeStart = (path: string, over: Record<string, unknown> = {}) => ({
  sessionUpdate: 'tool_call',
  tool_call_id: 'call-1',
  kind: 'edit',
  status: 'in_progress',
  title: `write: ${path}`,
  locations: [{ path }],
  ...over,
});

describe('phase one — the path comes off the START update', () => {
  it('prefers locations[0].path, the structured carrier', () => {
    expect(extractWriteTargetPath(writeStart('reports/summary.html'))).toBe('reports/summary.html');
  });

  it('falls back to the `write: ` title when locations is empty', () => {
    // A fallback, not a preference: a title is prose and prose changes.
    expect(extractWriteTargetPath(writeStart('a/b.html', { locations: [] }))).toBe('a/b.html');
    expect(extractWriteTargetPath({ title: 'write: c.html', tool_call_id: 'x' })).toBe('c.html');
  });

  it('accepts .html and .htm, and nothing else', () => {
    expect(collectHtmlWriteFromToolCallStart(writeStart('page.html'), resolve)).toEqual({
      toolCallId: 'call-1',
      path: 'page.html',
    });
    expect(collectHtmlWriteFromToolCallStart(writeStart('page.htm'), resolve)).toEqual({
      toolCallId: 'call-1',
      path: 'page.htm',
    });
    // Markdown already has its own lane (useAcpMessage.ts:807); the rest is not
    // this slice's business.
    for (const path of ['notes.md', 'data.csv', 'deck.pptx', 'script.ts', 'noextension']) {
      expect(collectHtmlWriteFromToolCallStart(writeStart(path), resolve), path).toBeUndefined();
    }
  });

  it('THE TABLE IS NOT COPIED: the mapping under test is the shipped one', () => {
    // If fileType.ts ever stops calling .html 'html', this reddens here rather
    // than silently changing what the parser accepts.
    expect(getFileTypeInfo('x.html').contentType).toBe('html');
    expect(getFileTypeInfo('x.htm').contentType).toBe('html');
    expect(getFileTypeInfo('x.html').editable).toBe(true);
  });

  it('is undefined on every malformed shape, and never throws', () => {
    for (const junk of [undefined, null, 'string', 42, [], {}, { title: 'write: a.html' }]) {
      expect(collectHtmlWriteFromToolCallStart(junk, resolve)).toBeUndefined();
    }
    expect(collectHtmlWriteFromToolCallStart(writeStart('a.html', { tool_call_id: '' }), resolve)).toBeUndefined();
    expect(
      collectHtmlWriteFromToolCallStart(writeStart('a.html', { locations: [], title: 'write: ?' }), resolve)
    ).toBeUndefined();
    // A resolver that throws is a miss, not a crash on the message path.
    expect(
      collectHtmlWriteFromToolCallStart(writeStart('a.html'), () => {
        throw new Error('boom');
      })
    ).toBeUndefined();
  });
});

describe('phase two — spend it only when that call COMPLETED', () => {
  it('reports the id of a completed call', () => {
    expect(isCompletedToolCallUpdate({ tool_call_id: 'call-1', status: 'completed' })).toBe('call-1');
    expect(isCompletedToolCallUpdate({ toolCallId: 'call-2', status: 'completed' })).toBe('call-2');
  });

  it('a FAILED write is not an artifact — opening a panel on it would be a lie', () => {
    expect(isCompletedToolCallUpdate({ tool_call_id: 'call-1', status: 'failed' })).toBeUndefined();
  });

  it('an in-flight call is not done: the file is not on disk yet', () => {
    // This is the whole reason the bind is not on arrival like B1's navigation.
    for (const status of ['pending', 'in_progress', 'running', undefined]) {
      expect(isCompletedToolCallUpdate({ tool_call_id: 'call-1', status })).toBeUndefined();
    }
  });

  it('is undefined on malformed shapes', () => {
    for (const junk of [undefined, null, 'x', 42, [], {}, { status: 'completed' }]) {
      expect(isCompletedToolCallUpdate(junk)).toBeUndefined();
    }
  });
});

describe('the seam — start remembers, completion spends', () => {
  it('a full write_file round trip yields exactly one path to open', () => {
    const start = writeStart('reports/q3.html', { tool_call_id: 'call-9' });
    const candidate = collectHtmlWriteFromToolCallStart(start, resolve);
    expect(candidate).toEqual({ toolCallId: 'call-9', path: 'reports/q3.html' });

    // The completion carries ONLY what the wheel puts there — no path.
    const completion = { tool_call_id: 'call-9', kind: 'edit', status: 'completed', content: [] };
    expect(extractWriteTargetPath(completion), 'the completion must not be trusted for a path').toBeUndefined();
    expect(isCompletedToolCallUpdate(completion)).toBe('call-9');
  });

  it('a non-html write is never remembered, so its completion opens nothing', () => {
    expect(collectHtmlWriteFromToolCallStart(writeStart('notes.md'), resolve)).toBeUndefined();
  });
});

describe('dedupe — an agent iterating on one page must not yank the tab', () => {
  it('the same path does not re-open', () => {
    expect(shouldOpenHtmlPreview('a/page.html', undefined)).toBe(true);
    expect(shouldOpenHtmlPreview('a/page.html', 'a/page.html')).toBe(false);
  });

  it('a different file DOES open — it is a different artifact', () => {
    expect(shouldOpenHtmlPreview('a/other.html', 'a/page.html')).toBe(true);
  });

  it('an empty path opens nothing', () => {
    expect(shouldOpenHtmlPreview('', undefined)).toBe(false);
    expect(shouldOpenHtmlPreview('   ', undefined)).toBe(false);
  });
});

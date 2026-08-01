/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * MAT-1747 C3 — the app-owned artifact capability, as Hermes sees it.
 *
 * A standalone stdio MCP process, spawned by Hermes from its private 0600
 * config, exactly like the managed image generator. It holds NO credential of
 * its own: it reads the 0600 loopback bearer file and calls back into Electron
 * main, which owns the CEVE licence, the credit authority and the idempotency
 * key. Nothing it can be told to do can reach a provider directly.
 *
 * Every tool below takes an OPAQUE CAPABILITY HANDLE. There is deliberately no
 * "list the conversation's artifacts" call that takes a conversation id: an id
 * is guessable and a model could invent one, whereas a handle is minted by main
 * and only ever emitted into the context envelope of the conversation it belongs
 * to. That is why this file contains no lookup by anything else.
 *
 * The PAID tool additionally takes a SPEND PERMIT, and the two are not
 * interchangeable. A handle says which clip; a permit says the user just asked,
 * once. Neither is validated here beyond its shape — this process holds no
 * authority and makes no decisions, it only carries the two credentials to main
 * and the answer back.
 *
 * The shape checks are character scans rather than regular expressions, matching
 * the rest of this path, so the semantic no-classifier gate can ban every
 * string-matching primitive outright instead of trying to tell a shape check
 * from a keyword classifier.
 *
 * WHICH TOOLS EXIST IS NOT DECIDED HERE. `eveArtifactToolSurface` decides, from
 * the same flag the paid handler reads, and this file registers what it is
 * given. Round 1 registered the paid tool unconditionally — so a seat with the
 * spending flag down still advertised `eve_video_edit` to the model on every
 * turn — and the reason that could ship unnoticed is that this module cannot be
 * imported by a test: it connects a stdio transport at import time. A decision
 * that cannot be unit-tested does not belong in a file that cannot be imported.
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import fs from 'fs';
import path from 'path';
import { z } from 'zod';
import {
  buildEveArtifactToolSurface,
  describeEveArtifactTool,
  EVE_ARTIFACT_TOOL_ARTIFACT_GET,
  EVE_ARTIFACT_TOOL_ARTIFACT_LIST,
  EVE_ARTIFACT_TOOL_VIDEO_EDIT,
  isToolAdvertised,
} from './eveArtifactToolSurface';

function isOpaqueCredential(value: string, prefix: string): boolean {
  if (typeof value !== 'string' || value.length !== prefix.length + 64) return false;
  for (let i = 0; i < prefix.length; i += 1) {
    if (value.charCodeAt(i) !== prefix.charCodeAt(i)) return false;
  }
  for (let i = prefix.length; i < value.length; i += 1) {
    const code = value.charCodeAt(i);
    const isDigit = code >= 48 && code <= 57;
    const isHexLetter = code >= 97 && code <= 102;
    if (!isDigit && !isHexLetter) return false;
  }
  return true;
}

function isLoopbackHost(hostname: string): boolean {
  return hostname === '127.0.0.1' || hostname === '::1' || hostname === '[::1]' || hostname === 'localhost';
}

function readLoopbackBearer(): string {
  const bearerFile = process.env.AIONUI_EVE_ARTIFACT_BEARER_FILE?.trim();
  if (!bearerFile || !path.isAbsolute(bearerFile) || path.basename(bearerFile) !== 'artifact-capability-bearer') {
    return '';
  }
  try {
    const stat = fs.lstatSync(bearerFile);
    // Same checks the image server makes on the shim token: a world- or
    // group-readable secret is not a secret, and a symlink is someone else's
    // file wearing our name.
    if (!stat.isFile() || stat.isSymbolicLink() || (stat.mode & 0o077) !== 0) return '';
    if (typeof process.getuid === 'function' && stat.uid !== process.getuid()) return '';
    return fs.readFileSync(bearerFile, 'utf8').trim();
  } catch {
    return '';
  }
}

function loopbackUrl(): string {
  const base = process.env.AIONUI_EVE_ARTIFACT_BASE_URL?.trim() || '';
  try {
    const parsed = new URL(base);
    if (parsed.protocol !== 'http:') return '';
    if (!isLoopbackHost(parsed.hostname)) return '';
    return `${parsed.origin}/eve/artifact/call`;
  } catch {
    return '';
  }
}

type CapabilityResult = { ok: boolean; [key: string]: unknown };

async function callMain(operation: string, payload: Record<string, unknown>): Promise<CapabilityResult> {
  const url = loopbackUrl();
  const bearer = readLoopbackBearer();
  if (!url || !bearer) return { ok: false, reason: 'capability-not-provisioned' };
  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: { Authorization: `Bearer ${bearer}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ operation, ...payload }),
    });
    const parsed = (await response.json()) as CapabilityResult;
    return parsed && typeof parsed === 'object' ? parsed : { ok: false, reason: 'malformed-response' };
  } catch {
    return { ok: false, reason: 'capability-unreachable' };
  }
}

function textResult(value: unknown, isError: boolean) {
  return { content: [{ type: 'text' as const, text: JSON.stringify(value) }], ...(isError ? { isError: true } : {}) };
}

const handleSchema = z
  .string()
  .refine((value) => isOpaqueCredential(value, 'evecap_'))
  .describe(
    'The opaque `edit_handle` copied VERBATIM from the artifact registry in your context. Never an artifact id, a filename, a conversation id or a guess — those are refused.'
  );

const permitSchema = z
  .string()
  .refine((value) => isOpaqueCredential(value, 'evespend_'))
  .describe(
    'The single-use `spend_permit` from THIS request in your context, copied VERBATIM. It authorises exactly one paid edit for the request the user just made. It cannot be reused for a second variation, and there is no way to obtain another one except the user asking again.'
  );

async function main() {
  const server = new McpServer({ name: 'aionui-eve-artifacts', version: '1.0.0' });
  // Read ONCE, at startup, from this process's environment — which the config
  // that spawned us populates explicitly when the seat is open. A tool list that
  // changed under the model mid-session would be worse than either answer.
  const surface = buildEveArtifactToolSurface(process.env);

  if (isToolAdvertised(surface, EVE_ARTIFACT_TOOL_ARTIFACT_GET)) {
    server.tool(
      EVE_ARTIFACT_TOOL_ARTIFACT_GET,
      describeEveArtifactTool(surface, EVE_ARTIFACT_TOOL_ARTIFACT_GET),
      { handle: handleSchema },
      async ({ handle }) => {
        const result = await callMain('artifact_get', { handle });
        return textResult(result, result.ok !== true);
      }
    );
  }

  if (isToolAdvertised(surface, EVE_ARTIFACT_TOOL_ARTIFACT_LIST)) {
    server.tool(
      EVE_ARTIFACT_TOOL_ARTIFACT_LIST,
      describeEveArtifactTool(surface, EVE_ARTIFACT_TOOL_ARTIFACT_LIST),
      { handles: z.array(handleSchema).min(1).max(24) },
      async ({ handles }) => {
        const results = [];
        // SEQUENTIAL on purpose, and the linter is told so rather than worked
        // around: these are up to 24 calls into the single Electron main
        // process, and firing them all at once would hand a model a way to make
        // one tool call cost twenty-four concurrent handlers. The calls are
        // local, free and read-only; the latency is not worth the concurrency.
        // eslint-disable-next-line no-await-in-loop
        for (const handle of handles) results.push(await callMain('artifact_get', { handle }));
        return textResult({ ok: true, artifacts: results }, false);
      }
    );
  }

  // POLICY F. The paid tool is not merely refused when the seat is closed — it
  // is not offered. An advertised capability the app will refuse teaches the
  // model to keep knocking, and puts an offer we do not honour in the transcript.
  if (isToolAdvertised(surface, EVE_ARTIFACT_TOOL_VIDEO_EDIT)) {
    server.tool(
      EVE_ARTIFACT_TOOL_VIDEO_EDIT,
      describeEveArtifactTool(surface, EVE_ARTIFACT_TOOL_VIDEO_EDIT),
      {
        handle: handleSchema,
        permit: permitSchema,
        instruction: z
          .string()
          .min(1)
          .max(2000)
          .describe('What should change about the video, in the user\'s own terms.'),
      },
      async ({ handle, permit, instruction }) => {
        const result = await callMain('video_edit', { handle, permit, instruction });
        // No path is echoed back, in either direction. Main deliberately returns
        // an artifact id and no `MEDIA:` line, so nothing here can leak a home
        // directory name into a transcript or an upstream API.
        return textResult(result, result.ok !== true);
      }
    );
  }

  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch(() => {
  // Content-free: an error message here would be written to a stream Hermes
  // reads, and this process is close enough to a bearer file that a raw throw
  // could name a path.
  console.error('[EveArtifactMCP] fatal error');
  process.exit(1);
});

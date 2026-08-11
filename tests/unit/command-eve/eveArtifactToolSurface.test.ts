/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * MAT-1747 round 2, POLICY F — the paid tool is not ADVERTISED while it is off.
 *
 * Round 1 fixed the context envelope (`allowedCapabilities` no longer names
 * `eve_video_edit` with the flag down) and reported policy F met. The
 * independent CAO found the other surface: the MCP server registered the tool
 * unconditionally, so every Hermes tool list handed the model a paid capability
 * the app would refuse.
 *
 * Two surfaces, one decision, and the tests below cover both:
 *
 *   - the TOOL LIST the MCP child publishes;
 *   - the context ENVELOPE the model reads on every turn.
 *
 * An advertised-but-refused tool is not a harmless mismatch. It teaches the
 * model to keep trying a door that will never open on its own, and it puts an
 * offer in the transcript that the product does not honour.
 *
 * POST-1.820.2 FRAMING: the flag this file passes around is the MCP CHILD's
 * env, which Main populates from its eligibility resolver
 * (`agentVideoEditFlag.ts` — default-ON for an eligible seat, `'0'`
 * kill-switch, no licence wire fails closed). An ABSENT key here therefore
 * means "Main decided this seat is closed", not "the product ships off".
 *
 * The flag is passed as an explicit env object per assertion; nothing here
 * mutates `process.env`, so the default stays default even inside this file.
 */

import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  buildEveArtifactToolSurface,
  EVE_ARTIFACT_TOOL_ARTIFACT_GET,
  EVE_ARTIFACT_TOOL_ARTIFACT_LIST,
  EVE_ARTIFACT_TOOL_IMAGE_EDIT,
  EVE_ARTIFACT_TOOL_TYPED_UI_PUBLISH,
  EVE_ARTIFACT_TOOL_VIDEO_EDIT,
  isToolAdvertised,
} from '@/process/resources/builtinMcp/eveArtifactToolSurface';
import { buildEveArtifactContextEnvelope } from '@/common/config/eveArtifactContextEnvelopeCore';
import { COMMAND_EVE_AGENT_VIDEO_EDIT_FLAG } from '@/process/commandEve/agentVideoEditFlag';
import { COMMAND_EVE_AGENT_IMAGE_EDIT_FLAG } from '@/process/commandEve/agentImageEditFlag';
import { buildCommandEveArtifactContextHermesMcpServer } from '@/process/commandEve/runtimeBootstrapCore';

const REPO_ROOT = path.resolve(__dirname, '../../..');

const names = (env: NodeJS.ProcessEnv) => buildEveArtifactToolSurface(env).map((tool) => tool.name);

describe('the MCP tool list is gated on the SAME flag as the envelope', () => {
  it('advertises only the free read/publish tools when the flag is absent', () => {
    expect(names({})).toEqual([
      EVE_ARTIFACT_TOOL_ARTIFACT_GET,
      EVE_ARTIFACT_TOOL_ARTIFACT_LIST,
      EVE_ARTIFACT_TOOL_TYPED_UI_PUBLISH,
    ]);
    expect(names({})).not.toContain(EVE_ARTIFACT_TOOL_VIDEO_EDIT);
  });

  it('advertises the paid tool only for the exact value `1`', () => {
    // POSITIVE CONTROL: the probe above is not simply always-false.
    expect(names({ [COMMAND_EVE_AGENT_VIDEO_EDIT_FLAG]: '1' })).toContain(EVE_ARTIFACT_TOOL_VIDEO_EDIT);
    // A spending flag that accepts several spellings gets switched on by
    // accident, so every near-miss stays off.
    for (const spelling of ['0', 'true', 'yes', 'on', '', ' ']) {
      expect(names({ [COMMAND_EVE_AGENT_VIDEO_EDIT_FLAG]: spelling })).not.toContain(EVE_ARTIFACT_TOOL_VIDEO_EDIT);
    }
  });

  it('never hides the FREE tools, whatever the flag says', () => {
    // The read half costs nothing and cannot spend. Gating it too would make the
    // whole artifact-context story collapse on every kill-switched or ineligible
    // seat — the seats whose child env carries no flag at all.
    for (const env of [{}, { [COMMAND_EVE_AGENT_VIDEO_EDIT_FLAG]: '1' }]) {
      expect(isToolAdvertised(buildEveArtifactToolSurface(env), EVE_ARTIFACT_TOOL_ARTIFACT_GET)).toBe(true);
      expect(isToolAdvertised(buildEveArtifactToolSurface(env), EVE_ARTIFACT_TOOL_ARTIFACT_LIST)).toBe(true);
      expect(isToolAdvertised(buildEveArtifactToolSurface(env), EVE_ARTIFACT_TOOL_TYPED_UI_PUBLISH)).toBe(true);
    }
  });

  it('gives every advertised tool a description, so a gated list is not a mute one', () => {
    for (const tool of buildEveArtifactToolSurface({ [COMMAND_EVE_AGENT_VIDEO_EDIT_FLAG]: '1' })) {
      expect(tool.description.length).toBeGreaterThan(40);
    }
  });

  it('1.820.3 — the IMAGE tool has its OWN carrier: each medium advertises independently', () => {
    // Neither flag: free surface only.
    expect(names({})).toEqual([
      EVE_ARTIFACT_TOOL_ARTIFACT_GET,
      EVE_ARTIFACT_TOOL_ARTIFACT_LIST,
      EVE_ARTIFACT_TOOL_TYPED_UI_PUBLISH,
    ]);
    // Image only: the image tool appears, the video tool does not.
    const imageOnly = names({ [COMMAND_EVE_AGENT_IMAGE_EDIT_FLAG]: '1' });
    expect(imageOnly).toContain(EVE_ARTIFACT_TOOL_IMAGE_EDIT);
    expect(imageOnly).not.toContain(EVE_ARTIFACT_TOOL_VIDEO_EDIT);
    // Video only: unchanged from the pre-image surface.
    const videoOnly = names({ [COMMAND_EVE_AGENT_VIDEO_EDIT_FLAG]: '1' });
    expect(videoOnly).toContain(EVE_ARTIFACT_TOOL_VIDEO_EDIT);
    expect(videoOnly).not.toContain(EVE_ARTIFACT_TOOL_IMAGE_EDIT);
    // Both: both paid tools, free tools still first.
    const both = names({ [COMMAND_EVE_AGENT_VIDEO_EDIT_FLAG]: '1', [COMMAND_EVE_AGENT_IMAGE_EDIT_FLAG]: '1' });
    expect(both).toEqual([
      EVE_ARTIFACT_TOOL_ARTIFACT_GET,
      EVE_ARTIFACT_TOOL_ARTIFACT_LIST,
      EVE_ARTIFACT_TOOL_TYPED_UI_PUBLISH,
      EVE_ARTIFACT_TOOL_VIDEO_EDIT,
      EVE_ARTIFACT_TOOL_IMAGE_EDIT,
    ]);
    // Near-miss spellings stay off for the image flag too.
    for (const spelling of ['0', 'true', 'yes', '']) {
      expect(names({ [COMMAND_EVE_AGENT_IMAGE_EDIT_FLAG]: spelling })).not.toContain(EVE_ARTIFACT_TOOL_IMAGE_EDIT);
    }
  });
});

/**
 * Is the paid registration LEXICALLY INSIDE the guard?
 *
 * The round-2 assertions here were `toContain('isToolAdvertised(surface, …)')`
 * and `not.toContain("server.tool(\n    'eve_video_edit'")`, and an independent
 * audit was right that between them they did not pin the thing they claimed to.
 * The first passes for any file that merely MENTIONS the guard — including one
 * where the guard sits above an unconditional registration, or where the
 * condition has been widened to `true || …`. The second is pinned to one exact
 * indentation of one exact spelling that the current code does not even use, so
 * it cannot fail at all.
 *
 * This answers the real question instead: does the `server.tool(…)` call whose
 * first argument is the paid tool sit between the braces opened by exactly the
 * guard we require? Comments and string literals are removed first — prose about
 * a guard is not a guard — and whitespace is collapsed, so re-indenting the file
 * cannot break it and cannot satisfy it either.
 *
 * Its own ability to FAIL is proved below against three fixtures, because a
 * structural check nobody has ever seen fail is exactly the kind of coverage
 * that is counted and does not exist.
 */
function stripCommentsAndLiterals(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^[\t ]*\/\/.*$/gm, '')
    .replace(/'(?:\\.|[^'\\\n])*'/g, "''")
    .replace(/"(?:\\.|[^"\\\n])*"/g, '""')
    .replace(/`(?:\\.|[^`\\])*`/g, '``')
    .replace(/\s+/g, ' ');
}

const REQUIRED_GUARD = 'if (isToolAdvertised(surface, EVE_ARTIFACT_TOOL_VIDEO_EDIT)) {';

/**
 * The `server.tool(` call whose first argument names the paid tool, or -1.
 *
 * Only the shared-constant spelling is looked for here, because a raw-literal
 * registration is refused outright by its own assertion below — one probe per
 * claim, rather than a second branch in this one that nothing would ever reach.
 */
function paidRegistrationIndex(code: string): number {
  const call = 'server.tool(';
  for (let at = code.indexOf(call); at >= 0; at = code.indexOf(call, at + 1)) {
    if (
      code
        .slice(at + call.length)
        .trimStart()
        .startsWith('EVE_ARTIFACT_TOOL_VIDEO_EDIT')
    )
      return at;
  }
  return -1;
}

type GuardVerdict = 'guarded' | 'unguarded' | 'not-registered';

function judgePaidToolRegistration(source: string): GuardVerdict {
  const code = stripCommentsAndLiterals(source);
  const registration = paidRegistrationIndex(code);
  if (registration < 0) return 'not-registered';
  const guardAt = code.indexOf(REQUIRED_GUARD);
  if (guardAt < 0) return 'unguarded';
  const open = guardAt + REQUIRED_GUARD.length - 1;
  let depth = 0;
  for (let i = open; i < code.length; i += 1) {
    if (code[i] === '{') depth += 1;
    else if (code[i] === '}') {
      depth -= 1;
      if (depth === 0) return registration > open && registration < i ? 'guarded' : 'unguarded';
    }
  }
  return 'unguarded';
}

describe('the guard probe this file depends on can actually fail', () => {
  const guardedFixture = [
    'async function main() {',
    '  const surface = buildEveArtifactToolSurface(process.env);',
    '  if (isToolAdvertised(surface, EVE_ARTIFACT_TOOL_VIDEO_EDIT)) {',
    '    server.tool(EVE_ARTIFACT_TOOL_VIDEO_EDIT, description, schema, handler);',
    '  }',
    '}',
  ].join('\n');

  it('says GUARDED for a registration inside the guard', () => {
    expect(judgePaidToolRegistration(guardedFixture)).toBe('guarded');
  });

  it('says UNGUARDED when the guard is deleted — the round-1 regression', () => {
    const unguarded = guardedFixture
      .split('\n')
      .filter((line) => !line.includes('isToolAdvertised(surface, EVE_ARTIFACT_TOOL_VIDEO_EDIT)'))
      .join('\n');
    expect(judgePaidToolRegistration(unguarded)).toBe('unguarded');
  });

  it('says UNGUARDED when the registration is moved OUT of a guard that still exists', () => {
    // The case the old `toContain` assertion could never see: the guard is still
    // in the file, the paid tool is registered next to it anyway.
    const moved = [
      'async function main() {',
      '  const surface = buildEveArtifactToolSurface(process.env);',
      '  if (isToolAdvertised(surface, EVE_ARTIFACT_TOOL_VIDEO_EDIT)) {',
      '    logSomething();',
      '  }',
      '  server.tool(EVE_ARTIFACT_TOOL_VIDEO_EDIT, description, schema, handler);',
      '}',
    ].join('\n');
    expect(judgePaidToolRegistration(moved)).toBe('unguarded');
  });

  it('says UNGUARDED when the condition is widened so it can never be false', () => {
    const widened = guardedFixture.replace(
      'if (isToolAdvertised(surface, EVE_ARTIFACT_TOOL_VIDEO_EDIT)) {',
      'if (true || isToolAdvertised(surface, EVE_ARTIFACT_TOOL_VIDEO_EDIT)) {'
    );
    expect(judgePaidToolRegistration(widened)).toBe('unguarded');
  });

  it('is not fooled by a comment that merely describes the guard', () => {
    const prose = [
      'async function main() {',
      '  // if (isToolAdvertised(surface, EVE_ARTIFACT_TOOL_VIDEO_EDIT)) { — we should do this',
      '  server.tool(EVE_ARTIFACT_TOOL_VIDEO_EDIT, description, schema, handler);',
      '}',
    ].join('\n');
    expect(judgePaidToolRegistration(prose)).toBe('unguarded');
  });
});

describe('the MCP server process registers from that surface and nothing else', () => {
  const serverSource = fs.readFileSync(
    path.join(REPO_ROOT, 'packages/desktop/src/process/resources/builtinMcp/eveArtifactContextServer.ts'),
    'utf8'
  );

  it('registers the paid tool ONLY inside the shared-surface guard', () => {
    // A STRUCTURAL assertion, because the module is a stdio entry point: it
    // connects a transport on import, so it cannot be imported into a unit test
    // to be asked what it registered. The guard is therefore asserted in the
    // source — but as containment, not as the presence of a substring — and the
    // behaviour it delegates to is tested above.
    expect(judgePaidToolRegistration(serverSource)).toBe('guarded');
  });

  it('registers the paid tool exactly once, so a second unguarded copy cannot hide', () => {
    // Containment says the one we found is guarded. This says there is only one.
    const code = stripCommentsAndLiterals(serverSource);
    let found = 0;
    for (let at = code.indexOf('server.tool('); at >= 0; at = code.indexOf('server.tool(', at + 1)) {
      if (
        code
          .slice(at + 'server.tool('.length)
          .trimStart()
          .startsWith('EVE_ARTIFACT_TOOL_VIDEO_EDIT')
      )
        found += 1;
    }
    expect(found).toBe(1);
  });

  it('names the paid tool by the shared constant and never by a raw literal', () => {
    // The round-1 shape registered `'eve_video_edit'` directly. A raw name is
    // how the tool list stops being decided in one place.
    const code = stripCommentsAndLiterals(serverSource.replace(/'eve_video_edit'/g, 'RAW_TOOL_NAME'));
    expect(code).not.toContain('RAW_TOOL_NAME');
  });
});

describe('the Hermes config tells the child which surface to publish', () => {
  const valid = {
    nodeExecutable: '/Applications/Command EVE.app/Contents/Resources/node',
    scriptPath: '/Applications/Command EVE.app/Contents/Resources/app/out/main/builtin-mcp-eve-artifacts.js',
    shimBaseUrl: 'http://127.0.0.1:25811',
    bearerFile: '/Users/founder/Library/Application Support/command-eve/artifact-capability-bearer',
  };

  it('omits the spending flag unless Main says the seat is eligible, so a closed seat publishes the free surface', () => {
    const server = buildCommandEveArtifactContextHermesMcpServer(valid);
    expect(server?.env?.[COMMAND_EVE_AGENT_VIDEO_EDIT_FLAG]).toBeUndefined();
  });

  it('passes it explicitly when the seat really has the paid path open', () => {
    // Hermes spawns this child; whether it inherits our environment is not a
    // thing to assume. When the seat is open we say so in the config, so main
    // and the child cannot disagree about what is on offer.
    const server = buildCommandEveArtifactContextHermesMcpServer({ ...valid, videoEditEnabled: true });
    expect(server?.env?.[COMMAND_EVE_AGENT_VIDEO_EDIT_FLAG]).toBe('1');
  });

  it('1.820.3 — carries the image flag independently, and omits it unless Main says so', () => {
    const closed = buildCommandEveArtifactContextHermesMcpServer(valid);
    expect(closed?.env?.[COMMAND_EVE_AGENT_IMAGE_EDIT_FLAG]).toBeUndefined();
    const imageOnly = buildCommandEveArtifactContextHermesMcpServer({ ...valid, imageEditEnabled: true });
    expect(imageOnly?.env?.[COMMAND_EVE_AGENT_IMAGE_EDIT_FLAG]).toBe('1');
    expect(imageOnly?.env?.[COMMAND_EVE_AGENT_VIDEO_EDIT_FLAG]).toBeUndefined();
  });
});

describe('the context envelope agrees with the tool list', () => {
  const entries = [
    {
      artifactId: 'video-1',
      kind: 'video' as const,
      mimeType: 'video/mp4',
      durationSeconds: 5,
      editable: true,
      editHandle: `evecap_${'a'.repeat(64)}`,
    },
  ];

  it('names no paid capability on a closed (kill-switched or ineligible) seat', () => {
    const envelope = buildEveArtifactContextEnvelope({ entries, allowedCapabilities: [] });
    expect(envelope).toContain('artifact_id=video-1');
    expect(envelope).not.toContain(EVE_ARTIFACT_TOOL_VIDEO_EDIT);
  });

  it('names it once the seat is open — the positive control', () => {
    const envelope = buildEveArtifactContextEnvelope({
      entries,
      allowedCapabilities: [EVE_ARTIFACT_TOOL_VIDEO_EDIT],
    });
    expect(envelope).toContain(EVE_ARTIFACT_TOOL_VIDEO_EDIT);
  });
});

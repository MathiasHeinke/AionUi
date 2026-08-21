/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * CEVE-18205 — the two surfaces that must agree about `eve_video_generate`.
 *
 * POLICY F, restated for a third tool: an advertised capability the app will
 * refuse is not a cosmetic mismatch. A model that sees the tool will call it, be
 * refused, and try again in different words, because from where it sits a
 * refusal reads as its own mistake. So the TOOL LIST and the ENV THAT SPAWNS THE
 * CHILD have to be driven by one decision, and this file checks both ends of it:
 *
 *   Main  -> `buildCommandEveArtifactContextHermesMcpServer` emits the carrier
 *            only for a seat that opted in;
 *   child -> `buildEveArtifactToolSurface` registers the tool only when it sees
 *            that carrier.
 *
 * The independence assertions matter as much as the positive ones: three paid
 * tools now share one child, and closing any one of them must not darken the
 * other two.
 */

import { describe, expect, it } from 'vitest';
import {
  buildEveArtifactToolSurface,
  EVE_ARTIFACT_TOOL_ARTIFACT_GET,
  EVE_ARTIFACT_TOOL_IMAGE_EDIT,
  EVE_ARTIFACT_TOOL_VIDEO_EDIT,
  EVE_ARTIFACT_TOOL_VIDEO_GENERATE,
  isToolAdvertised,
} from '@/process/resources/builtinMcp/eveArtifactToolSurface';
import { COMMAND_EVE_AGENT_VIDEO_GENERATE_FLAG } from '@/process/commandEve/agentVideoGenerateFlag';
import { COMMAND_EVE_AGENT_VIDEO_EDIT_FLAG } from '@/process/commandEve/agentVideoEditFlag';
import { COMMAND_EVE_AGENT_IMAGE_EDIT_FLAG } from '@/process/commandEve/agentImageEditFlag';
import { buildCommandEveArtifactContextHermesMcpServer } from '@/process/commandEve/runtimeBootstrapCore';

const valid = {
  nodeExecutable: '/Applications/Command EVE.app/Contents/Resources/node',
  scriptPath: '/Applications/Command EVE.app/Contents/Resources/builtin-mcp-eve-artifacts.js',
  shimBaseUrl: 'http://127.0.0.1:25811',
  bearerFile: '/Users/x/Library/Application Support/Command EVE/command-eve-runtime/artifact-capability-bearer',
};

describe('the child tool surface', () => {
  it('does NOT advertise generate by default', () => {
    const surface = buildEveArtifactToolSurface({});
    expect(isToolAdvertised(surface, EVE_ARTIFACT_TOOL_VIDEO_GENERATE)).toBe(false);
    // Positive control: the free read half is still there, so this is a gated
    // tool and not an empty surface.
    expect(isToolAdvertised(surface, EVE_ARTIFACT_TOOL_ARTIFACT_GET)).toBe(true);
  });

  it('does not advertise generate even with the carrier until turn authority is ready', () => {
    expect(
      isToolAdvertised(
        buildEveArtifactToolSurface({ [COMMAND_EVE_AGENT_VIDEO_GENERATE_FLAG]: '1' }),
        EVE_ARTIFACT_TOOL_VIDEO_GENERATE
      )
    ).toBe(false);
    for (const value of ['0', 'true', 'yes', '']) {
      expect(
        isToolAdvertised(
          buildEveArtifactToolSurface({ [COMMAND_EVE_AGENT_VIDEO_GENERATE_FLAG]: value }),
          EVE_ARTIFACT_TOOL_VIDEO_GENERATE
        ),
        `"${value}" must not advertise generate`
      ).toBe(false);
    }
  });

  it('keeps generate fenced and image edit independent while legacy video edit stays dark', () => {
    const generateOnly = buildEveArtifactToolSurface({ [COMMAND_EVE_AGENT_VIDEO_GENERATE_FLAG]: '1' });
    expect(isToolAdvertised(generateOnly, EVE_ARTIFACT_TOOL_VIDEO_EDIT)).toBe(false);
    expect(isToolAdvertised(generateOnly, EVE_ARTIFACT_TOOL_IMAGE_EDIT)).toBe(false);

    const editsOnly = buildEveArtifactToolSurface({
      [COMMAND_EVE_AGENT_VIDEO_EDIT_FLAG]: '1',
      [COMMAND_EVE_AGENT_IMAGE_EDIT_FLAG]: '1',
    });
    expect(isToolAdvertised(editsOnly, EVE_ARTIFACT_TOOL_VIDEO_GENERATE)).toBe(false);
    expect(isToolAdvertised(editsOnly, EVE_ARTIFACT_TOOL_VIDEO_EDIT)).toBe(false);
    expect(isToolAdvertised(editsOnly, EVE_ARTIFACT_TOOL_IMAGE_EDIT)).toBe(true);
  });

  it('keeps the paid generate descriptor unreachable in the 1.823.0 child surface', () => {
    const surface = buildEveArtifactToolSurface({ [COMMAND_EVE_AGENT_VIDEO_GENERATE_FLAG]: '1' });
    expect(surface.find((tool) => tool.name === EVE_ARTIFACT_TOOL_VIDEO_GENERATE)).toBeUndefined();
  });
});

describe('the Main-side env emission', () => {
  it('omits the carrier entirely for a seat that did not opt in', () => {
    const server = buildCommandEveArtifactContextHermesMcpServer(valid);
    expect(server?.env[COMMAND_EVE_AGENT_VIDEO_GENERATE_FLAG]).toBeUndefined();
    // Positive control: the always-present keys ARE there, so this is an omitted
    // key and not an undefined server.
    expect(server?.env.AIONUI_EVE_ARTIFACT_BASE_URL).toBe('http://127.0.0.1:25811');
  });

  it('emits exactly "1" for an opted-in seat', () => {
    const server = buildCommandEveArtifactContextHermesMcpServer({ ...valid, videoGenerateEnabled: true });
    expect(server?.env[COMMAND_EVE_AGENT_VIDEO_GENERATE_FLAG]).toBe('1');
  });

  it('carries the three paid flags independently', () => {
    const generateOnly = buildCommandEveArtifactContextHermesMcpServer({ ...valid, videoGenerateEnabled: true });
    expect(generateOnly?.env[COMMAND_EVE_AGENT_VIDEO_EDIT_FLAG]).toBeUndefined();
    expect(generateOnly?.env[COMMAND_EVE_AGENT_IMAGE_EDIT_FLAG]).toBeUndefined();

    const editOnly = buildCommandEveArtifactContextHermesMcpServer({ ...valid, videoEditEnabled: true });
    expect(editOnly?.env[COMMAND_EVE_AGENT_VIDEO_GENERATE_FLAG]).toBeUndefined();
    expect(editOnly?.env[COMMAND_EVE_AGENT_VIDEO_EDIT_FLAG]).toBe('1');
  });

  it('still refuses a non-loopback shim url with the new flag set', () => {
    // The new field must not have widened the fail-closed input validation.
    expect(
      buildCommandEveArtifactContextHermesMcpServer({
        ...valid,
        shimBaseUrl: 'http://example.com:25811',
        videoGenerateEnabled: true,
      })
    ).toBeUndefined();
  });
});

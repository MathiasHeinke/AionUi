/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import { afterEach, describe, expect, it } from 'vitest';
import { EVE_SEALED_CAPABILITIES, type EveAuthorityGrant, type EveLadderRung } from '@/common/config/eveAuthorityCore';
import { renderEveAuthorityRuntime } from '@/common/config/eveAuthorityRuntimeCore';
import {
  ensureCommandEveShimAuthToken,
  startCommandEveOllamaOpenAiShim,
  stopCommandEveOllamaOpenAiShimForTest,
} from '@/process/commandEve/ollamaOpenAiShim';

const at = (ladder: EveLadderRung): EveAuthorityGrant => ({ ladder, capabilities: {}, updatedBy: 'user' });
const auth = { authorization: `Bearer ${ensureCommandEveShimAuthToken()}` };

afterEach(async () => {
  await stopCommandEveOllamaOpenAiShimForTest();
});

async function startAt(ladder: EveLadderRung): Promise<string> {
  return startWith(at(ladder));
}

async function startWith(grant: EveAuthorityGrant): Promise<string> {
  return startCommandEveOllamaOpenAiShim({
    port: 0,
    ollamaBaseUrl: 'http://127.0.0.1:1',
    commandEveApproval: () => renderEveAuthorityRuntime(grant),
  });
}

async function startWithRuntime(runtime: ReturnType<typeof renderEveAuthorityRuntime>): Promise<string> {
  return startCommandEveOllamaOpenAiShim({
    port: 0,
    ollamaBaseUrl: 'http://127.0.0.1:1',
    commandEveApproval: () => runtime,
  });
}

const fullRelease = (): EveAuthorityGrant => ({
  ladder: 5,
  capabilities: Object.fromEntries(EVE_SEALED_CAPABILITIES.map((capability) => [capability, true])),
  limits: { 'spend.money': { dailyCents: 5000 } },
  opaqueUiAutoRun: true,
  opaqueUiAutoRunGrantedAt: '2026-08-08T00:00:00.000Z',
  updatedBy: 'user',
});

async function decision(baseUrl: string, tool: string, action = ''): Promise<Record<string, unknown>> {
  const query = new URLSearchParams({ tool, action });
  const response = await fetch(`${baseUrl}/v1/command-eve/tool-approval?${query}`, { headers: auth });
  expect(response.status).toBe(200);
  return response.json() as Promise<Record<string, unknown>>;
}

describe('Hermes structured tool authority route', () => {
  it('asks before state-changing browser and computer actions below rung 4', async () => {
    const baseUrl = await startAt(1);
    await expect(decision(baseUrl, 'browser_type')).resolves.toMatchObject({ decision: 'ask', ladder: 1 });
    await expect(decision(baseUrl, 'computer_use', 'click')).resolves.toMatchObject({ decision: 'ask', ladder: 1 });
  });

  it('keeps read-only visibility open at every rung', async () => {
    const baseUrl = await startAt(0);
    await expect(decision(baseUrl, 'browser_snapshot')).resolves.toMatchObject({ decision: 'allow', ladder: 0 });
    await expect(decision(baseUrl, 'computer_use', 'capture')).resolves.toMatchObject({ decision: 'allow', ladder: 0 });
  });

  it('routes product-managed image and video generation through native approval below Full', async () => {
    const baseUrl = await startAt(0);
    await expect(decision(baseUrl, 'image_generate')).resolves.toMatchObject({ decision: 'ask', ladder: 0 });
    await expect(decision(baseUrl, 'video_generate')).resolves.toMatchObject({ decision: 'ask', ladder: 0 });

    await stopCommandEveOllamaOpenAiShimForTest();
    const fullBaseUrl = await startWith(fullRelease());
    await expect(decision(fullBaseUrl, 'image_generate')).resolves.toMatchObject({ decision: 'allow', ladder: 5 });
    await expect(decision(fullBaseUrl, 'video_generate')).resolves.toMatchObject({ decision: 'allow', ladder: 5 });
  });

  it('keeps builtin reads and surfaces open while paid MCP tools use native approval below Full', async () => {
    const baseUrl = await startAt(0);
    await expect(decision(baseUrl, 'tool_search')).resolves.toMatchObject({ decision: 'allow', ladder: 0 });
    await expect(decision(baseUrl, 'tool_describe')).resolves.toMatchObject({ decision: 'allow', ladder: 0 });
    await expect(decision(baseUrl, 'read_window_below')).resolves.toMatchObject({ decision: 'allow', ladder: 0 });
    await expect(decision(baseUrl, 'video_analyze')).resolves.toMatchObject({ decision: 'allow', ladder: 0 });
    await expect(decision(baseUrl, 'mcp__aionui_image_generation__aionui_image_generation')).resolves.toMatchObject({
      decision: 'ask',
      ladder: 0,
    });
    await expect(decision(baseUrl, 'mcp__aionui_eve_artifacts__eve_artifact_get')).resolves.toMatchObject({
      decision: 'allow',
      ladder: 0,
    });
    await expect(decision(baseUrl, 'mcp__aionui_eve_artifacts__eve_artifact_list')).resolves.toMatchObject({
      decision: 'allow',
      ladder: 0,
    });
    await expect(decision(baseUrl, 'mcp__aionui_eve_artifacts__eve_typed_ui_publish')).resolves.toMatchObject({
      decision: 'allow',
      ladder: 0,
    });
    await expect(decision(baseUrl, 'mcp__aionui_eve_artifacts__eve_image_edit')).resolves.toMatchObject({
      decision: 'ask',
      ladder: 0,
    });
    await expect(decision(baseUrl, 'mcp__aionui_eve_artifacts__eve_video_edit')).resolves.toMatchObject({
      decision: 'ask',
      ladder: 0,
    });
    await expect(decision(baseUrl, 'mcp__aionui_eve_artifacts__eve_video_generate')).resolves.toMatchObject({
      decision: 'ask',
      ladder: 0,
    });
  });

  it('never lets a new builtin-server tool or a bare bridge call inherit unattended authority', async () => {
    const baseUrl = await startWith(fullRelease());
    await expect(decision(baseUrl, 'mcp__aionui_eve_artifacts__eve_future_destructive')).resolves.toMatchObject({
      decision: 'ask',
    });
    await expect(decision(baseUrl, 'mcp__aionui_image_generation__future_tool')).resolves.toMatchObject({
      decision: 'ask',
    });
    await expect(decision(baseUrl, 'mcp__aionui_unknown_server__whatever')).resolves.toMatchObject({
      decision: 'ask',
    });
    await expect(decision(baseUrl, 'mcp__third_party__anything')).resolves.toMatchObject({ decision: 'ask' });
    await expect(decision(baseUrl, 'tool_call')).resolves.toMatchObject({ decision: 'ask' });
  });

  it('lets self-directed seats navigate and enables opaque actions only after their own grant', async () => {
    const baseUrl = await startAt(5);
    await expect(decision(baseUrl, 'browser_navigate')).resolves.toMatchObject({ decision: 'allow', ladder: 5 });
    await expect(decision(baseUrl, 'browser_click')).resolves.toMatchObject({ decision: 'ask', ladder: 5 });
    await expect(decision(baseUrl, 'computer_use', 'type')).resolves.toMatchObject({ decision: 'ask', ladder: 5 });

    await stopCommandEveOllamaOpenAiShimForTest();
    const releasedBaseUrl = await startWith(fullRelease());
    await expect(decision(releasedBaseUrl, 'browser_click')).resolves.toMatchObject({ decision: 'allow', ladder: 5 });
    await expect(decision(releasedBaseUrl, 'computer_use', 'type')).resolves.toMatchObject({
      decision: 'allow',
      ladder: 5,
    });
  });

  it('keeps unknown future tools installed but operation-approved until every seal is enforceable', async () => {
    const baseUrl = await startAt(5);
    await expect(decision(baseUrl, 'future_destructive_tool')).resolves.toMatchObject({ decision: 'ask' });
    const response = await fetch(`${baseUrl}/v1/command-eve/tool-approval?tool=browser_click`);
    expect(response.status).toBe(401);

    await stopCommandEveOllamaOpenAiShimForTest();
    const releasedBaseUrl = await startWith(fullRelease());
    await expect(decision(releasedBaseUrl, 'future_destructive_tool')).resolves.toMatchObject({ decision: 'ask' });
    await expect(decision(releasedBaseUrl, 'browser_future_destructive_action')).resolves.toMatchObject({
      decision: 'ask',
    });
    await expect(decision(releasedBaseUrl, 'computer_use', 'future_destructive_action')).resolves.toMatchObject({
      decision: 'ask',
    });

    await stopCommandEveOllamaOpenAiShimForTest();
    const lowerBaseUrl = await startAt(4);
    await expect(decision(lowerBaseUrl, 'future_destructive_tool')).resolves.toMatchObject({ decision: 'ask' });
  });

  it('keeps the direct outward seal precise instead of requiring every full-release seal', async () => {
    const baseUrl = await startWith({
      ladder: 1,
      capabilities: { 'publish.outward': true },
      updatedBy: 'user',
    });
    await expect(decision(baseUrl, 'discord', 'create_thread')).resolves.toMatchObject({ decision: 'allow' });
  });

  it('keeps structured effect tools sealed when only opaque UI auto-run is open', async () => {
    const baseUrl = await startWith({
      ladder: 5,
      capabilities: {},
      opaqueUiAutoRun: true,
      opaqueUiAutoRunGrantedAt: '2026-08-08T00:00:00.000Z',
      updatedBy: 'user',
    });
    await expect(decision(baseUrl, 'browser_click')).resolves.toMatchObject({ decision: 'allow' });
    await expect(decision(baseUrl, 'discord', 'create_thread')).resolves.toMatchObject({ decision: 'ask' });
    await expect(decision(baseUrl, 'skill_manage', 'delete')).resolves.toMatchObject({ decision: 'ask' });
    await expect(decision(baseUrl, 'future_destructive_tool')).resolves.toMatchObject({ decision: 'ask' });
  });

  it('pauses a stored opaque UI grant below rung 4', async () => {
    const baseUrl = await startWith({
      ladder: 3,
      capabilities: {},
      opaqueUiAutoRun: true,
      opaqueUiAutoRunGrantedAt: '2026-08-08T00:00:00.000Z',
      updatedBy: 'user',
    });
    await expect(decision(baseUrl, 'browser_click')).resolves.toMatchObject({ decision: 'ask', ladder: 3 });
    await expect(decision(baseUrl, 'computer_use', 'click')).resolves.toMatchObject({ decision: 'ask', ladder: 3 });
  });

  it('keeps the route authenticated', async () => {
    const baseUrl = await startWith(fullRelease());
    await expect(decision(baseUrl, 'browser_click')).resolves.toMatchObject({ decision: 'allow', ladder: 5 });
    const response = await fetch(`${baseUrl}/v1/command-eve/tool-approval?tool=browser_click`);
    expect(response.status).toBe(401);
  });

  it('emits a valid authority revision only when the resolver provides one', async () => {
    await stopCommandEveOllamaOpenAiShimForTest();
    const revision = 'A'.repeat(32);
    const baseUrl = await startWithRuntime({
      ...renderEveAuthorityRuntime(fullRelease()),
      authority_revision: revision,
    });
    await expect(decision(baseUrl, 'browser_click')).resolves.toMatchObject({
      decision: 'allow',
      authority_revision: revision,
    });

    await stopCommandEveOllamaOpenAiShimForTest();
    const malformedBaseUrl = await startWithRuntime({
      ...renderEveAuthorityRuntime(fullRelease()),
      authority_revision: 'invalid revision!',
    });
    await expect(decision(malformedBaseUrl, 'browser_click')).resolves.toMatchObject({
      decision: 'allow',
    });
    const malformedPayload = await decision(malformedBaseUrl, 'browser_click');
    expect(Object.hasOwn(malformedPayload, 'authority_revision')).toBe(false);

    await stopCommandEveOllamaOpenAiShimForTest();
    for (const boundary of ['A'.repeat(15), `${'A'.repeat(128)}\n`, 'A'.repeat(129), ' has spaces ']) {
      const boundaryBaseUrl = await startWithRuntime({
        ...renderEveAuthorityRuntime(fullRelease()),
        authority_revision: boundary,
      });
      const payload = await decision(boundaryBaseUrl, 'browser_click');
      expect(payload).toMatchObject({ decision: 'allow' });
      expect(Object.hasOwn(payload, 'authority_revision')).toBe(false);
    }
  });

  it('fails closed without a revision when authority resolution throws', async () => {
    const baseUrl = await startCommandEveOllamaOpenAiShim({
      port: 0,
      ollamaBaseUrl: 'http://127.0.0.1:1',
      commandEveApproval: () => {
        throw new Error('authority backend unavailable');
      },
    });
    const payload = await decision(baseUrl, 'browser_click');
    expect(payload).toEqual({ decision: 'ask', ladder: 0 });
  });

  it('applies the same seat rung to memory, skills, process and cron actions', async () => {
    const baseUrl = await startAt(4);
    await expect(decision(baseUrl, 'memory', 'add')).resolves.toMatchObject({ decision: 'allow' });
    await expect(decision(baseUrl, 'memory', 'remove')).resolves.toMatchObject({ decision: 'ask' });
    await expect(decision(baseUrl, 'skill_manage', 'patch')).resolves.toMatchObject({ decision: 'allow' });
    await expect(decision(baseUrl, 'skill_manage', 'delete')).resolves.toMatchObject({ decision: 'ask' });
    await expect(decision(baseUrl, 'process', 'poll')).resolves.toMatchObject({ decision: 'allow' });
    await expect(decision(baseUrl, 'cronjob', 'create')).resolves.toMatchObject({ decision: 'allow' });
  });
});

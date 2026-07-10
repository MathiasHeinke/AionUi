/**
 * E2E: team_describe_assistant (and follow-up team_spawn_agent) via the real
 * TeamMcpServer TCP bridge.
 *
 * What we're exercising (and why unit tests weren't enough):
 *   - The MCP tool is registered in the stdio bridge (`teamMcpStdio.ts`) and
 *     dispatched by the TCP server in `TeamMcpServer.ts`. Unit tests only
 *     reach into the server handler — they never exercise the length-prefixed
 *     TCP framing, the auth-token check, or the stdio-side registration.
 *   - A teammate spawned via `custom_agent_id` needs the server to resolve
 *     the preset backend from config and hand a real `TeamAgent` back to
 *     the caller. This E2E walks the whole path end-to-end.
 *
 * Flow:
 *   1. Create a minimal team via `team.create` + `team.ensureSession` bridges
 *      (so the TCP server starts and the leader's conversation gets
 *      `extra.teamMcpStdioConfig` written).
 *   2. Pull the port + auth token from the leader conversation's
 *      `teamMcpStdioConfig.env` — the same info the stdio bridge would get.
 *   3. Open a raw TCP socket from the Playwright worker and speak the MCP
 *      frame protocol directly: one framed JSON request, one framed JSON
 *      response. Call `team_describe_assistant` with a known preset id,
 *      then `team_spawn_agent` with the same id.
 *   4. Assert the describe response contains the preset's name + skills
 *      + "team_spawn_agent" hint, and that the spawn adds a teammate with
 *      the correct `customAgentId`.
 *   5. Cleanup via `team.remove`.
 *
 * Why not hit the tool through the leader agent? Leader inference is
 * non-deterministic and slow (~2-3 min); asserting on natural-language
 * output is flaky. The MCP TCP endpoint is the deterministic surface.
 */
import * as net from 'node:net';
import { test, expect } from '../fixtures';
import { invokeBridge } from '../helpers';

type TcpReply = { result?: string; error?: string };
type McpJsonRpcResponse = {
  result?: {
    content?: Array<{ type?: string; text?: string }>;
    isError?: boolean;
    [key: string]: unknown;
  };
  error?: { message?: string };
};
type StdioEnvEntry = { name?: string; value?: string };
type StdioConfig = { env?: StdioEnvEntry[]; port?: number; token?: string };
type LeaderConversation = {
  id?: string;
  extra?: { teamMcpStdioConfig?: StdioConfig; team_mcp_stdio_config?: StdioConfig };
} | null;

/** Backend /api/teams/:id GET response shape — aligns with aioncore schema. */
type TTeamBackendAgent = {
  slot_id: string;
  conversation_id: string;
  role: string;
  name: string;
  backend: string;
  model: string;
  status: string;
  custom_agent_id?: string;
};
type TTeam = {
  id: string;
  name: string;
  agents: TTeamBackendAgent[];
};

// Prefer familiar assistants when present, but only after discovering the
// runtime catalog through team_list_assistants. IDs are not a stable contract.
const PREFERRED_ASSISTANT_IDS = [
  'builtin-cowork',
  'builtin-word-creator',
  'builtin-ppt-creator',
  'builtin-excel-creator',
] as const;

type AssistantCatalogEntry = {
  assistant_id?: string;
  id?: string;
  name?: string;
  backend?: string;
};

function writeTcpFrame(socket: net.Socket, payload: Record<string, unknown>): void {
  const body = Buffer.from(JSON.stringify(payload), 'utf-8');
  const frame = Buffer.allocUnsafe(4 + body.length);
  frame.writeUInt32BE(body.length, 0);
  body.copy(frame, 4);
  socket.write(frame);
}

function toTcpReply(response: McpJsonRpcResponse): TcpReply {
  if (response.error) return { error: response.error.message ?? 'Unknown JSON-RPC error' };
  const text = response.result?.content
    ?.filter((item) => item.type === 'text' && typeof item.text === 'string')
    .map((item) => item.text)
    .join('\n');
  if (response.result?.isError) return { error: text || 'MCP tool returned an error' };
  return { result: text || JSON.stringify(response.result ?? {}) };
}

/** Authenticate a TCP MCP session, optionally call one tool, then close. */
function sendMcpRequest(
  port: number,
  authToken: string,
  slotId: string,
  toolName?: string,
  args: Record<string, unknown> = {},
  timeoutMs = 15_000
): Promise<TcpReply> {
  return new Promise<TcpReply>((resolve, reject) => {
    const socket = net.createConnection({ host: '127.0.0.1', port }, () => {
      writeTcpFrame(socket, {
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: {
          auth_token: authToken,
          slot_id: slotId,
          protocolVersion: '2024-11-05',
          capabilities: {},
          clientInfo: { name: 'command-eve-e2e', version: '1.0' },
        },
      });
    });

    let pending = Buffer.alloc(0);
    let phase: 'initialize' | 'tool' = 'initialize';
    let settled = false;

    const finish = (err: Error | null, value?: TcpReply): void => {
      if (settled) return;
      settled = true;
      socket.destroy();
      if (err) reject(err);
      else resolve(value as TcpReply);
    };

    socket.on('data', (chunk) => {
      pending = Buffer.concat([pending, chunk]);
      while (!settled && pending.length >= 4) {
        const bodyLen = pending.readUInt32BE(0);
        if (pending.length < 4 + bodyLen) return;
        const body = pending.subarray(4, 4 + bodyLen).toString('utf-8');
        pending = pending.subarray(4 + bodyLen);

        let response: McpJsonRpcResponse;
        try {
          response = JSON.parse(body) as McpJsonRpcResponse;
        } catch (parseErr) {
          finish(parseErr as Error);
          return;
        }

        if (phase === 'initialize') {
          if (response.error || !toolName) {
            finish(null, toTcpReply(response));
            return;
          }
          phase = 'tool';
          writeTcpFrame(socket, {
            jsonrpc: '2.0',
            id: 2,
            method: 'tools/call',
            params: { name: toolName, arguments: args },
          });
          continue;
        }

        finish(null, toTcpReply(response));
      }
    });

    socket.on('error', (err) => finish(err));
    socket.on('end', () => finish(new Error('TCP connection ended before response')));
    socket.setTimeout(timeoutMs);
    socket.on('timeout', () => finish(new Error('TCP request timeout')));
  });
}

function readEnv(env: StdioEnvEntry[] | undefined, name: string): string | undefined {
  return env?.find((e) => e.name === name)?.value;
}

test.describe('Team MCP - team_describe_assistant', () => {
  test('describes a preset and then spawns it as a teammate via the real TCP bridge', async ({ page }) => {
    test.setTimeout(180_000);

    let createdTeamId: string | undefined;

    try {
      // ── 1. Create team with the public Command EVE leader ────────────────
      const created = await invokeBridge<{ id: string }>(page, 'team.create', {
        name: `E2E Describe Assistant ${Date.now()}`,
        agents: [
          {
            name: 'Leader',
            role: 'lead',
            assistant_id: 'command-eve-chief-of-staff',
            model: 'default',
          },
        ],
      });
      expect(created.id, 'team.create must create a Command EVE-led team').toBeTruthy();
      createdTeamId = created.id;

      // Starting the session is what boots the TCP MCP server and writes the
      // stdio config into the leader's conversation extra.
      await invokeBridge(page, 'team.ensure-session', { team_id: createdTeamId });

      // ── 2. Read the port + auth token from the leader conversation ───────
      const team = await invokeBridge<TTeam | null>(page, 'team.get', { id: createdTeamId });
      expect(team, 'team.get should return the freshly-created team').toBeTruthy();
      expect(Array.isArray(team!.agents), JSON.stringify(team)).toBe(true);
      const leader = team!.agents.find((a) => a.role === 'lead');
      expect(leader?.conversation_id, 'leader must have a conversation id').toBeTruthy();

      const leaderConv = await invokeBridge<LeaderConversation>(page, 'get-conversation', {
        id: leader!.conversation_id,
      });
      const stdioConfig = leaderConv?.extra?.teamMcpStdioConfig ?? leaderConv?.extra?.team_mcp_stdio_config;
      const portStr =
        readEnv(stdioConfig?.env, 'TEAM_MCP_PORT') ?? (stdioConfig?.port ? String(stdioConfig.port) : undefined);
      const token = readEnv(stdioConfig?.env, 'TEAM_MCP_TOKEN') ?? stdioConfig?.token;
      expect(portStr, 'teamMcpStdioConfig must expose TEAM_MCP_PORT').toBeTruthy();
      expect(token, 'teamMcpStdioConfig must expose TEAM_MCP_TOKEN').toBeTruthy();
      const port = parseInt(portStr!, 10);
      expect(Number.isFinite(port) && port > 0).toBe(true);

      // ── 3a. Discover the real runtime catalog, then describe one entry ───
      const catalogReply = await sendMcpRequest(port, token!, leader!.slot_id, 'team_list_assistants');
      expect(catalogReply.error, 'team_list_assistants should not error').toBeFalsy();
      const catalog = JSON.parse(catalogReply.result ?? '{}') as { assistants?: AssistantCatalogEntry[] };
      const catalogIds = (catalog.assistants ?? [])
        .map((assistant) => assistant.assistant_id ?? assistant.id)
        .filter((id): id is string => Boolean(id));
      expect(catalogIds.length, `team_list_assistants returned no IDs: ${catalogReply.result}`).toBeGreaterThan(0);

      const candidateIds = [
        ...PREFERRED_ASSISTANT_IDS.filter((id) => catalogIds.includes(id)),
        ...catalogIds.filter((id) => !PREFERRED_ASSISTANT_IDS.includes(id as (typeof PREFERRED_ASSISTANT_IDS)[number])),
      ];
      let presetId: string | undefined;
      let describeText: string | undefined;
      const describeErrors: string[] = [];
      for (const candidate of candidateIds) {
        const reply = await sendMcpRequest(port, token!, leader!.slot_id, 'team_describe_assistant', {
          assistant_id: candidate,
          locale: 'en-US',
        });
        if (!reply.error && reply.result) {
          presetId = candidate;
          describeText = reply.result;
          break;
        }
        describeErrors.push(`${candidate}: ${reply.error ?? '<empty result>'}`);
      }
      expect(presetId, `no preferred preset was enabled (tried: ${describeErrors.join('; ')})`).toBeTruthy();
      expect(describeText).toContain(presetId!);
      expect(describeText).toContain('Backend:');
      expect(describeText).toContain('## Description');
      expect(describeText).toContain('## Skills');
      expect(describeText).toContain('## Example tasks');
      expect(describeText).toContain('team_spawn_agent');
      expect(describeText).toContain(`assistant_id="${presetId}"`);

      // ── 3b. Reject bogus auth token (defence-in-depth smoke test) ────────
      const unauthorizedReply = await sendMcpRequest(port, 'not-the-real-token', leader!.slot_id);
      expect(unauthorizedReply.error).toMatch(/Authentication failed/i);

      // ── 3c. Surface a useful error when preset id is unknown ─────────────
      const notFoundReply = await sendMcpRequest(port, token!, leader!.slot_id, 'team_describe_assistant', {
        assistant_id: 'builtin-does-not-exist',
      });
      expect(notFoundReply.error, 'unknown preset must error').toBeTruthy();
      expect(notFoundReply.error).toMatch(/not found/i);

      // ── 4. team_spawn_agent using the same assistant_id ──────────────────
      const teammateName = `doc-writer-${Date.now()}`;
      const spawnReply = await sendMcpRequest(
        port,
        token!,
        leader!.slot_id,
        'team_spawn_agent',
        { name: teammateName, assistant_id: presetId },
        30_000
      );
      expect(spawnReply.error, 'spawn should not error').toBeFalsy();
      expect(spawnReply.result).toContain(teammateName);

      // Backend verification: team now has two agents, and the new one
      // carries the expected preset metadata.
      const teamAfterSpawn = await invokeBridge<TTeam | null>(page, 'team.get', { id: createdTeamId });
      expect(teamAfterSpawn?.agents.length).toBe(2);
      const spawned = teamAfterSpawn!.agents.find((a) => a.name === teammateName);
      expect(spawned, 'spawned teammate must be present').toBeTruthy();
      expect(spawned!.custom_agent_id).toBe(presetId);
      expect(spawned!.backend).toBeTruthy();
    } finally {
      if (createdTeamId) {
        await invokeBridge(page, 'team.remove', { id: createdTeamId }).catch(() => {});
      }
    }
  });
});

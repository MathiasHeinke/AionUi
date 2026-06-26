/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import { afterEach, describe, expect, it } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import {
  ensureCommandEveAssistant,
  resolveCommandEveManagedSkillImportPaths,
} from '@/process/commandEve/assistantBootstrap';
import { COMMAND_EVE_ASSISTANT_ID } from '@/common/config/commandEveShell';
import { resolveCommandEveRuntimeBootstrapPaths } from '@/process/commandEve/runtimeBootstrapCore';
import { __resetActiveSeatForTests, setActiveSeatId } from '@/process/commandEve/seatContextCore';
import { writeCompanyBrainSeed } from '@/process/commandEve/companyBrainSeedCore';

const tempRoots: string[] = [];
const originalFetch = globalThis.fetch;

const makeRoot = (): string => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'command-eve-assistant-bootstrap-test-'));
  tempRoots.push(root);
  return root;
};

const writeJson = (filePath: string, value: unknown): void => {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`);
};

afterEach(() => {
  globalThis.fetch = originalFetch;
  __resetActiveSeatForTests();
  for (const root of tempRoots.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

const SEAT_A = 'a1b2c3d4-e5f6-4789-aabb-ccddeeff0011';

/**
 * Run ensureCommandEveAssistant end-to-end against a fetch-mock that captures
 * the assistant-skill prompts written for each locale. Returns the captured
 * skill bodies so the test can assert WHICH identity the assembled prompt
 * carries (the load-bearing ISO-6 wiring proof).
 */
async function captureAssistantSkills(userDataPath: string): Promise<Record<string, string>> {
  const ready = {
    id: COMMAND_EVE_ASSISTANT_ID,
    name: 'EVE',
    preset_agent_type: 'hermes',
    enabled_skills: [],
    custom_skill_names: [],
  };
  const skills: Record<string, string> = {};
  const fetchMock = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = new URL(String(input));
    const method = String(init?.method || 'GET').toUpperCase();
    const body = typeof init?.body === 'string' ? JSON.parse(init.body) : undefined;
    if (url.pathname === '/api/agents/management') return jsonResponse({ success: true, data: [{ backend: 'hermes', available: true }] });
    if (url.pathname === '/api/assistants' && method === 'GET') return jsonResponse({ success: true, data: [ready] });
    if (url.pathname === '/api/assistants' && method === 'POST') return jsonResponse({ success: true, data: ready });
    if (url.pathname === `/api/assistants/${COMMAND_EVE_ASSISTANT_ID}` && method === 'PUT') return jsonResponse({ success: true, data: ready });
    if (url.pathname === `/api/assistants/${COMMAND_EVE_ASSISTANT_ID}/state`) return jsonResponse({ success: true, data: ready });
    if (url.pathname === '/api/skills/assistant-skill/write' && method === 'POST') {
      skills[String(body?.locale)] = String(body?.content || '');
      return jsonResponse({ success: true, data: true });
    }
    if (url.pathname.startsWith('/api/skills/assistant-') && method === 'POST') return jsonResponse({ success: true, data: true });
    if (url.pathname === '/api/skills/import-symlink') return jsonResponse({ success: true, data: {} });
    throw new Error(`Unexpected request ${method} ${url.pathname}`);
  };
  globalThis.fetch = fetchMock as typeof fetch;
  await ensureCommandEveAssistant(25809, '1.1.1', { userDataPath });
  return skills;
}

describe('ISO-6 wiring — the assembled prompt reflects the ACTIVE seat, not the admin', () => {
  it('a real seat with an ISO-3 seed renders the CLIENT entity, never the admin profile', async () => {
    const root = makeRoot();
    const paths = resolveCommandEveRuntimeBootstrapPaths(root, 'seat-1');
    // The GLOBAL admin profile that the legacy path would render.
    writeJson(paths.firstRunProfile, {
      version: 'command-eve-first-run-profile/v0',
      source: 'registration',
      confidence: 'verified',
      needs_confirmation: false,
      updated_at: new Date().toISOString(),
      founder_name: 'Mathias Admin',
      company_name: 'FYN Labs GmbH',
    });

    // Provision the active real seat + write ITS client truth (ISO-3) under the
    // seat-scoped hermesHome.
    setActiveSeatId(SEAT_A);
    writeCompanyBrainSeed({ userDataPath: root, seed: { kind: 'connect_client', value: 'Mueller GmbH' } });

    const skills = await captureAssistantSkills(root);

    for (const locale of ['de-DE', 'en-US']) {
      const prompt = skills[locale] || '';
      expect(prompt).toContain('Mueller GmbH');
      expect(prompt).not.toContain('Mathias Admin');
      expect(prompt).not.toContain('FYN Labs GmbH');
      expect(prompt).toContain(locale === 'de-DE' ? 'Seat-Datenhaltung' : 'Seat data posture');
    }
  });

  it('the LEGACY seat renders the admin profile exactly (byte-identical path)', async () => {
    const root = makeRoot();
    const paths = resolveCommandEveRuntimeBootstrapPaths(root, 'seat-1');
    writeJson(paths.firstRunProfile, {
      version: 'command-eve-first-run-profile/v0',
      source: 'registration',
      confidence: 'verified',
      needs_confirmation: false,
      updated_at: new Date().toISOString(),
      founder_name: 'Mathias Admin',
      company_name: 'FYN Labs GmbH',
    });
    // No setActiveSeatId → legacy default.
    const skills = await captureAssistantSkills(root);
    for (const locale of ['de-DE', 'en-US']) {
      const prompt = skills[locale] || '';
      expect(prompt).toContain('Mathias Admin');
      expect(prompt).toContain('FYN Labs GmbH');
      expect(prompt).not.toContain(locale === 'de-DE' ? 'Client-Seat-Entitaet' : 'Client seat entity');
    }
  });
});

function jsonResponse(payload: unknown): Response {
  return {
    ok: true,
    status: 200,
    json: async () => payload,
    text: async () => JSON.stringify(payload),
  } as Response;
}

describe('Command EVE assistant bootstrap', () => {
  it('resolves only executable managed SKILL.md paths for AionUI custom-skill import', () => {
    const root = makeRoot();
    const paths = resolveCommandEveRuntimeBootstrapPaths(root);
    const managedSkillDir = path.join(root, 'skills-command-eve');
    fs.mkdirSync(path.join(managedSkillDir, 'first-run-company-discovery'), { recursive: true });
    fs.writeFileSync(path.join(managedSkillDir, 'first-run-company-discovery', 'SKILL.md'), '# First run\n');
    fs.mkdirSync(path.join(managedSkillDir, 'missing-skill-md'), { recursive: true });
    writeJson(paths.runtimeReconciliation, {
      version: 'command-eve-runtime-reconciliation/v0',
      managed_skill_dir: managedSkillDir,
      executable_skill_ids: ['first-run-company-discovery', 'missing-skill-md', '../escape', 'Content Machine'],
    });

    expect(resolveCommandEveManagedSkillImportPaths(root)).toEqual([
      {
        id: 'first-run-company-discovery',
        path: path.join(managedSkillDir, 'first-run-company-discovery'),
      },
    ]);
  });

  it('recreates a stale managed EVE assistant when preset reconciliation does not persist via PUT', async () => {
    const staleAssistant = {
      id: COMMAND_EVE_ASSISTANT_ID,
      name: 'EVE',
      preset_agent_type: 'aionrs',
      enabled_skills: [],
      custom_skill_names: [],
    };
    const repairedAssistant = {
      ...staleAssistant,
      preset_agent_type: 'hermes',
    };
    const calls: Array<{ method: string; path: string; body?: unknown }> = [];
    let assistantListReads = 0;

    const fetchMock = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      const url = new URL(String(input));
      const method = String(init?.method || 'GET').toUpperCase();
      const body = typeof init?.body === 'string' ? JSON.parse(init.body) : undefined;
      calls.push({ method, path: url.pathname, body });

      if (url.pathname === '/api/agents/management') {
        return jsonResponse({ success: true, data: [{ backend: 'hermes', available: true }] });
      }

      if (url.pathname === '/api/assistants' && method === 'GET') {
        assistantListReads += 1;
        return jsonResponse({ success: true, data: [assistantListReads < 3 ? staleAssistant : repairedAssistant] });
      }

      if (url.pathname === `/api/assistants/${COMMAND_EVE_ASSISTANT_ID}` && method === 'PUT') {
        return jsonResponse({ success: true, data: staleAssistant });
      }

      if (url.pathname === `/api/assistants/${COMMAND_EVE_ASSISTANT_ID}` && method === 'DELETE') {
        return jsonResponse({ success: true, data: true });
      }

      if (url.pathname === '/api/assistants' && method === 'POST') {
        expect(body).toMatchObject({
          id: COMMAND_EVE_ASSISTANT_ID,
          preset_agent_type: 'hermes',
        });
        return jsonResponse({ success: true, data: repairedAssistant });
      }

      if (url.pathname === `/api/assistants/${COMMAND_EVE_ASSISTANT_ID}/state` && method === 'PATCH') {
        return jsonResponse({ success: true, data: repairedAssistant });
      }

      if (url.pathname.startsWith('/api/skills/assistant-') && method === 'POST') {
        return jsonResponse({ success: true, data: true });
      }

      throw new Error(`Unexpected request ${method} ${url.pathname}`);
    };

    globalThis.fetch = fetchMock as typeof fetch;
    await ensureCommandEveAssistant(25809, '1.0.0-alpha.4');

    expect(calls.map((call) => `${call.method} ${call.path}`)).toEqual(
      expect.arrayContaining([
        `PUT /api/assistants/${COMMAND_EVE_ASSISTANT_ID}`,
        `DELETE /api/assistants/${COMMAND_EVE_ASSISTANT_ID}`,
        'POST /api/assistants',
        `PATCH /api/assistants/${COMMAND_EVE_ASSISTANT_ID}/state`,
      ])
    );
  });
});

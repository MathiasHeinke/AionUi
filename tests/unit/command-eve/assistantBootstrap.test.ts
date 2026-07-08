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
  rosterPurposeForKind,
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
    if (url.pathname === '/api/agents/management')
      return jsonResponse({ success: true, data: [{ backend: 'hermes', available: true }] });
    if (url.pathname === '/api/assistants' && method === 'GET') return jsonResponse({ success: true, data: [ready] });
    if (url.pathname === '/api/assistants' && method === 'POST') return jsonResponse({ success: true, data: ready });
    if (url.pathname === `/api/assistants/${COMMAND_EVE_ASSISTANT_ID}` && method === 'PUT')
      return jsonResponse({ success: true, data: ready });
    if (url.pathname === `/api/assistants/${COMMAND_EVE_ASSISTANT_ID}/state`)
      return jsonResponse({ success: true, data: ready });
    if (url.pathname === '/api/skills/assistant-skill/write' && method === 'POST') {
      skills[String(body?.locale)] = String(body?.content || '');
      return jsonResponse({ success: true, data: true });
    }
    if (url.pathname.startsWith('/api/skills/assistant-') && method === 'POST')
      return jsonResponse({ success: true, data: true });
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

// TEST-HONESTY MIRROR (c) — the REAL assembly seam. Run ensureCommandEveAssistant
// end-to-end (buildCommandEveSeatContextBlock → withSeatBlock → writeAssistantResource)
// and assert the seat-context BLOCK actually lands in the WRITTEN assistant-skill
// resource — not a fixture that merely re-renders the pure block. Also proves H2:
// the block reports the REAL board ('default') EVE writes, never the old "keins".
describe('mirror (c) — the seat-context block is REALLY written into the assistant resource', () => {
  it('a real seat: the assembled resource CONTAINS the Seat-Kontext block for its client + the DEFAULT board (H2)', async () => {
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
    setActiveSeatId(SEAT_A);
    writeCompanyBrainSeed({ userDataPath: root, seed: { kind: 'connect_client', value: 'Mueller GmbH' } });

    const skills = await captureAssistantSkills(root);

    // The German resource carries the real Seat-Kontext block …
    expect(skills['de-DE']).toContain('## Seat-Kontext');
    // … reporting the REAL board EVE writes (H2), never the misleading "keins".
    expect(skills['de-DE']).toContain('Aktives Board: default');
    expect(skills['de-DE']).not.toContain('Aktives Board: keins');
    // The English resource mirrors it.
    expect(skills['en-US']).toContain('## Seat context');
    expect(skills['en-US']).toContain('Active board: default');
    expect(skills['en-US']).not.toContain('Active board: none');
  });

  it('the FOUNDER seat: the assembled resource carries the Founder seat-context block', async () => {
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
    // Legacy/founder seat (no setActiveSeatId).
    const skills = await captureAssistantSkills(root);
    expect(skills['de-DE']).toContain('Founder-Seat');
    expect(skills['en-US']).toContain('Founder seat');
    // The founder block is the roster shape, never the real-seat "Aktives Board" line.
    expect(skills['de-DE']).not.toContain('Aktives Board');
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

function errorResponse(status: number, message: string): Response {
  return {
    ok: false,
    status,
    json: async () => ({ success: false, error: message }),
    text: async () => JSON.stringify({ success: false, error: message }),
  } as Response;
}

describe('Command EVE assistant bootstrap', () => {
  it('creates EVE with an explicit Hermes agent_id so providerless installs can seed the assistant', async () => {
    let storedAssistant: Record<string, unknown> | undefined;
    let createdBody: Record<string, unknown> | undefined;

    const fetchMock = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      const url = new URL(String(input));
      const method = String(init?.method || 'GET').toUpperCase();
      const body = typeof init?.body === 'string' ? JSON.parse(init.body) : undefined;

      if (url.pathname === '/api/agents/management') {
        return jsonResponse({
          success: true,
          data: [{ id: 'agent-hermes-acp', backend: 'hermes', agent_type: 'acp', available: true }],
        });
      }

      if (url.pathname === '/api/assistants' && method === 'GET') {
        return jsonResponse({ success: true, data: storedAssistant ? [storedAssistant] : [] });
      }

      if (url.pathname === '/api/assistants' && method === 'POST') {
        createdBody = body as Record<string, unknown>;
        if (createdBody.agent_id !== 'agent-hermes-acp') {
          return errorResponse(
            400,
            'Cannot create assistant: no providers configured. Add a provider before creating an assistant, or pass an explicit `agent_id` in the request body.'
          );
        }
        storedAssistant = {
          ...createdBody,
          enabled_skills: [],
          custom_skill_names: [],
        };
        return jsonResponse({ success: true, data: storedAssistant });
      }

      if (url.pathname === `/api/assistants/${COMMAND_EVE_ASSISTANT_ID}/state` && method === 'PATCH') {
        return jsonResponse({ success: true, data: storedAssistant });
      }

      if (url.pathname.startsWith('/api/skills/assistant-') && method === 'POST') {
        return jsonResponse({ success: true, data: true });
      }

      throw new Error(`Unexpected request ${method} ${url.pathname}`);
    };

    globalThis.fetch = fetchMock as typeof fetch;

    await expect(ensureCommandEveAssistant(25809, '1.7.8')).resolves.toMatchObject({
      status: 'ready',
      assistant_id: COMMAND_EVE_ASSISTANT_ID,
      preset_agent_type: 'hermes',
    });
    expect(createdBody).toMatchObject({
      id: COMMAND_EVE_ASSISTANT_ID,
      agent_id: 'agent-hermes-acp',
      preset_agent_type: 'hermes',
    });
  });

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

  it('does NOT destructively recreate (no DELETE+POST) when the PUT cannot reconcile the preset — keeps EVE present and still resolves', async () => {
    // The backend permanently reports the assistant on the 'aionrs' preset; the
    // merge-only PUT cannot flip it to 'hermes'. The OLD behavior recreated it via
    // DELETE + POST, which soft-deleted the assistant's user definition — making EVE
    // VANISH from /api/assistants mid-session AND bricking aioncore's bootstrap on the
    // next restart. The fix: keep the merged assistant (NO destructive recreate) and do
    // not throw over a cosmetic preset mismatch (the runtime resolves the live agent).
    const staleAssistant = {
      id: COMMAND_EVE_ASSISTANT_ID,
      name: 'EVE',
      preset_agent_type: 'aionrs',
      enabled_skills: [],
      custom_skill_names: [],
    };
    const calls: Array<{ method: string; path: string }> = [];

    const fetchMock = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      const url = new URL(String(input));
      const method = String(init?.method || 'GET').toUpperCase();
      calls.push({ method, path: url.pathname });

      if (url.pathname === '/api/agents/management') {
        return jsonResponse({ success: true, data: [{ backend: 'hermes', available: true }] });
      }
      if (url.pathname === '/api/assistants' && method === 'GET') {
        return jsonResponse({ success: true, data: [staleAssistant] });
      }
      if (url.pathname === `/api/assistants/${COMMAND_EVE_ASSISTANT_ID}` && method === 'PUT') {
        return jsonResponse({ success: true, data: staleAssistant });
      }
      if (url.pathname === `/api/assistants/${COMMAND_EVE_ASSISTANT_ID}/state` && method === 'PATCH') {
        return jsonResponse({ success: true, data: staleAssistant });
      }
      if (url.pathname.startsWith('/api/skills/assistant-') && method === 'POST') {
        return jsonResponse({ success: true, data: true });
      }
      // A DELETE on the assistant or a recreate-POST /api/assistants would land here and
      // fail the test — they must NOT happen anymore.
      throw new Error(`Unexpected request ${method} ${url.pathname}`);
    };

    globalThis.fetch = fetchMock as typeof fetch;
    // Must RESOLVE (not throw) even though the preset never reconciles to hermes.
    await expect(ensureCommandEveAssistant(25809, '1.0.0-alpha.4')).resolves.toBeDefined();

    const sigs = calls.map((call) => `${call.method} ${call.path}`);
    expect(sigs).toContain(`PUT /api/assistants/${COMMAND_EVE_ASSISTANT_ID}`);
    expect(sigs).toContain(`PATCH /api/assistants/${COMMAND_EVE_ASSISTANT_ID}/state`);
    // The destructive recreate must NOT happen — it is the soft-delete source.
    expect(sigs).not.toContain(`DELETE /api/assistants/${COMMAND_EVE_ASSISTANT_ID}`);
    expect(calls.filter((call) => call.method === 'POST' && call.path === '/api/assistants')).toHaveLength(0);
  });
});

describe('K3 rosterPurposeForKind — kind-aware founder roster purpose', () => {
  it('client (default) keeps the pre-K3 wording verbatim (regression-safe)', () => {
    expect(rosterPurposeForKind('client', 'delegate', 'de-DE')).toBe(
      'Client-Seat (invisible delivery, streng isoliert)'
    );
    expect(rosterPurposeForKind('client', 'admin', 'de-DE')).toBe('Client-Seat (Admin-Zugriff)');
    expect(rosterPurposeForKind('client', 'delegate', 'en-US')).toBe(
      'Client seat (invisible delivery, strictly isolated)'
    );
    expect(rosterPurposeForKind('client', 'admin', 'en-US')).toBe('Client seat (admin access)');
  });

  it('own_company reads as an own project/firm', () => {
    expect(rosterPurposeForKind('own_company', 'admin', 'de-DE')).toBe('Eigenes Projekt/eigene Firma des Operators');
    expect(rosterPurposeForKind('own_company', 'delegate', 'en-US')).toBe("Operator's own project/firm");
  });

  it('department reads as a department/area', () => {
    expect(rosterPurposeForKind('department', 'admin', 'de-DE')).toBe('Abteilung/Bereich des Operators');
    expect(rosterPurposeForKind('department', 'delegate', 'en-US')).toBe("Operator's department/area");
  });
});

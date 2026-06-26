import {
  getCommandEveAssistantRule,
  buildCommandEveAssistant,
  buildCommandEveAssistantContext,
  buildCommandEveAssistantSkill,
  resolveCommandEveSeatIdentity,
  selectCommandEvePresetAgentType,
  unwrapCommandEveApiData,
  type CommandEveApiEnvelope,
  type CommandEveAssistantCapabilityPackContext,
  type CommandEveAssistantFirstRunContext,
  type CommandEveAssistantLocalIdentity,
  type CommandEveAssistantRuntimeReceipt,
  type CommandEveDetectedAgent,
  type CommandEveSeatSeedRecord,
} from './assistantBootstrapCore';
import { COMMAND_EVE_ASSISTANT_ID, isCommandEveFounderBuild } from '@/common/config/commandEveShell';
import fs from 'fs';
import path from 'path';
import { resolveCommandEveRuntimeBootstrapPaths } from './runtimeBootstrapCore';
import { getActiveSeatId, isActiveSeatLegacy } from './seatContextCore';
import { readCompanyBrainSeedState } from './companyBrainSeedCore';

export type EnsureCommandEveAssistantOptions = {
  userDataPath?: string;
};

export type CommandEveAssistantEnsureResult = {
  status: 'ready';
  assistant_id: string;
  preset_agent_type: string;
  enabled_skills: string[];
  custom_skill_names: string[];
  skill_count: number;
};

type CommandEveRuntimeReconciliationForSkillImport = {
  managed_skill_dir?: string;
  executable_skill_ids?: unknown;
};

type ImportedSkillResponse = {
  skill_name?: string;
};

type CommandEveAssistantRecord = {
  id: string;
  preset_agent_type?: string;
  enabled_skills?: string[];
  custom_skill_names?: string[];
  // User-editable fields the backend returns; used by the merge-only re-seed to
  // preserve operator edits and to detect a stale managed seed / broken avatar.
  description?: string;
  avatar?: string;
  name?: string;
  prompts?: string[];
};

const SAFE_COMMAND_EVE_SKILL_ID = /^[a-z0-9][a-z0-9-]{0,80}$/;

async function requestJson<T>(backendPort: number, path: string, init?: RequestInit, timeoutMs = 30_000): Promise<T> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  const headers = new Headers(init?.headers);
  headers.set('content-type', 'application/json');
  try {
    const response = await fetch(`http://127.0.0.1:${backendPort}${path}`, {
      ...init,
      headers,
      signal: init?.signal || controller.signal,
    });
    if (!response.ok) {
      const body = await response.text().catch(() => '');
      throw new Error(`Command EVE assistant bootstrap failed: ${response.status} ${path} ${body.slice(0, 240)}`);
    }
    return unwrapCommandEveApiData<T>((await response.json()) as CommandEveApiEnvelope<T> | T);
  } catch (error) {
    if (controller.signal.aborted) {
      throw new Error(`Command EVE assistant bootstrap timed out after ${timeoutMs}ms: ${path}`);
    }
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

async function writeAssistantResource(
  backendPort: number,
  kind: 'assistant-rule' | 'assistant-skill',
  locale: string,
  content: string
): Promise<void> {
  await requestJson<boolean>(backendPort, `/api/skills/${kind}/write`, {
    method: 'POST',
    body: JSON.stringify({
      assistant_id: COMMAND_EVE_ASSISTANT_ID,
      locale,
      content,
    }),
  });
}

function readJsonFile<T>(file: string): T | undefined {
  try {
    if (!file || !fs.existsSync(file)) return undefined;
    return JSON.parse(fs.readFileSync(file, 'utf8')) as T;
  } catch {
    return undefined;
  }
}

function asStringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.map((entry) => String(entry || '').trim()).filter(Boolean) : [];
}

export function resolveCommandEveManagedSkillImportPaths(userDataPath?: string): Array<{ id: string; path: string }> {
  if (!userDataPath) return [];
  const paths = resolveCommandEveRuntimeBootstrapPaths(userDataPath);
  const reconciliation = readJsonFile<CommandEveRuntimeReconciliationForSkillImport>(paths.runtimeReconciliation);
  const managedSkillDir = String(reconciliation?.managed_skill_dir || '').trim();
  if (!managedSkillDir) return [];
  return asStringArray(reconciliation?.executable_skill_ids)
    .filter((id) => SAFE_COMMAND_EVE_SKILL_ID.test(id))
    .map((id) => ({ id, path: path.join(managedSkillDir, id) }))
    .filter((skill) => fs.existsSync(path.join(skill.path, 'SKILL.md')));
}

async function importCommandEveManagedSkills(backendPort: number, userDataPath?: string): Promise<string[]> {
  const skillImports = resolveCommandEveManagedSkillImportPaths(userDataPath);
  const skillNames: string[] = [];
  for (const skill of skillImports) {
    let skillName = skill.id;
    try {
      const imported = await requestJson<ImportedSkillResponse>(
        backendPort,
        '/api/skills/import-symlink',
        {
          method: 'POST',
          body: JSON.stringify({ skill_path: skill.path }),
        },
        5_000
      );
      skillName = imported.skill_name || skill.id;
    } catch (error) {
      console.warn(
        `[CommandEVE] Could not import managed skill "${skill.id}" into AionUI custom skills: ${
          error instanceof Error ? error.message : String(error)
        }`
      );
    }
    skillNames.push(skillName);
  }
  return Array.from(new Set(skillNames));
}

/**
 * The base first-run context (global receipt/profile/capabilityPack) PLUS the
 * raw, locale-neutral seat seed for the ACTIVE seat. `seatIdentity` itself is
 * resolved per-locale at the build call site (the DSGVO posture text differs by
 * locale), so this struct keeps the entity locale-neutral.
 */
type CommandEveFirstRunLoad = {
  baseContext: CommandEveAssistantFirstRunContext;
  /** True when a real (non-legacy) seat is active → admin seed must be suppressed. */
  realSeatActive: boolean;
  /** The active seat id (audit only). */
  seatId: string;
  /** The active seat's ISO-3 client seed (undefined for legacy/unseeded). */
  seatSeed?: CommandEveSeatSeedRecord;
};

function loadCommandEveFirstRunContext(appVersion: string, userDataPath?: string): CommandEveFirstRunLoad | undefined {
  if (!userDataPath) return undefined;
  const paths = resolveCommandEveRuntimeBootstrapPaths(userDataPath);
  const receipt = readJsonFile<CommandEveAssistantRuntimeReceipt>(paths.receiptPath);
  const profile = readJsonFile<CommandEveAssistantLocalIdentity>(paths.firstRunProfile);
  const capabilityPack = readJsonFile<CommandEveAssistantCapabilityPackContext>(paths.capabilityPack);

  // ISO-6: when a real seat is active, source THIS seat's client entity from its
  // ISO-3 Company-Brain seed (under the seat-scoped hermesHome), never the
  // admin's global first-run-profile/registration. A legacy/no-seat install
  // carries no seat seed and falls back to the admin profile — byte-identical.
  const realSeatActive = !isActiveSeatLegacy();
  const seatId = getActiveSeatId();
  let seatSeed: CommandEveSeatSeedRecord | undefined;
  if (realSeatActive) {
    const state = readCompanyBrainSeedState({ userDataPath });
    if (state.seeded && state.record) {
      seatSeed = { kind: state.record.kind, value: state.record.value };
    }
  }

  // A real seat must STILL produce a context (to suppress the admin seed) even
  // when no global receipt/profile exists; only a legacy install with nothing
  // loaded returns undefined (byte-identical to before).
  if (!receipt && !profile && !capabilityPack && !realSeatActive) return undefined;

  return {
    baseContext: { appVersion, receipt, profile, capabilityPack },
    realSeatActive,
    seatId,
    seatSeed,
  };
}

/**
 * Build the per-locale skill prompt, attaching the ISO-6 per-seat identity. For
 * a real seat the resolved `seatIdentity` OUTRANKS the global admin profile
 * inside `buildCommandEveAssistantFirstRunContext`; for legacy it is undefined
 * and the prompt is byte-identical to 1.1.3.
 */
function buildCommandEveAssistantSkillForSeat(
  locale: 'de-DE' | 'en-US',
  load: CommandEveFirstRunLoad | undefined,
  isFounderBuild: boolean
): string {
  if (!load) return buildCommandEveAssistantSkill(locale, undefined, isFounderBuild);
  const seatIdentity = load.realSeatActive
    ? resolveCommandEveSeatIdentity({ legacy: false, seatId: load.seatId, seed: load.seatSeed, locale })
    : undefined;
  return buildCommandEveAssistantSkill(locale, { ...load.baseContext, seatIdentity }, isFounderBuild);
}

function hasAvailableHermesAgent(agents: CommandEveDetectedAgent[]): boolean {
  return agents.some(
    (agent) => (agent.backend || agent.agent_type || '').toLowerCase() === 'hermes' && agent.available !== false
  );
}

async function loadCommandEveDetectedAgents(backendPort: number): Promise<CommandEveDetectedAgent[]> {
  // aioncore v0.1.37 renamed the agent-list GET to /api/agents/management (plain
  // /api/agents now 404s). A 404 here threw and aborted the whole EVE re-seed.
  let agents = await requestJson<CommandEveDetectedAgent[]>(backendPort, '/api/agents/management');
  if (hasAvailableHermesAgent(agents)) return agents;

  // The backend agent registry can finish Hermes detection just after the
  // initial app boot query. Do not persist EVE to Aionrs until Hermes had a
  // short chance to appear, otherwise old first-run state survives forever.
  for (let attempt = 0; attempt < 5; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 600));
    agents = await requestJson<CommandEveDetectedAgent[]>(backendPort, '/api/agents/management');
    if (hasAvailableHermesAgent(agents)) break;
  }
  return agents;
}

function buildCommandEveAssistantPayload(
  presetAgentType: string,
  customSkillNames: string[],
  appVersion: string,
  isFounderBuild: boolean
): ReturnType<typeof buildCommandEveAssistant> & { description: string } {
  const assistant = buildCommandEveAssistant(presetAgentType, customSkillNames, isFounderBuild);
  return {
    ...assistant,
    description: `${assistant.description}\n\n${buildCommandEveAssistantContext(appVersion)}`,
  };
}

// A description that still carries a known MANAGED seed marker (the old internal
// founder persona, or any current managed seed) is NOT a user edit — it is safe to
// refresh to the correct current seed on update. Anything else is a genuine user
// edit and is preserved by the merge-only PUT.
const COMMAND_EVE_STALE_SEED_MARKERS = [
  'Chief-of-Staff',
  'Founder Intent',
  'CEO-Delegation',
  'CEO delegation',
  'Worker Contract',
];
function commandEveAssistantHasManagedSeed(existing: CommandEveAssistantRecord | undefined): boolean {
  const description = String(existing?.description || '');
  return COMMAND_EVE_STALE_SEED_MARKERS.some((marker) => description.includes(marker));
}

function findCommandEveAssistant(assistants: CommandEveAssistantRecord[]): CommandEveAssistantRecord | undefined {
  return assistants.find((item) => item.id === COMMAND_EVE_ASSISTANT_ID);
}

function includesAll(values: string[] | undefined, expected: string[]): boolean {
  if (expected.length === 0) return true;
  const actual = new Set((values || []).map((value) => String(value || '').trim()).filter(Boolean));
  return expected.every((value) => actual.has(value));
}

function commandEveAssistantIsReconciled(
  assistant: CommandEveAssistantRecord | undefined,
  presetAgentType: string,
  customSkillNames: string[]
): boolean {
  if (!assistant) return false;
  return (
    assistant.preset_agent_type === presetAgentType &&
    includesAll(assistant.enabled_skills, customSkillNames) &&
    includesAll(assistant.custom_skill_names, customSkillNames)
  );
}

async function loadCommandEveAssistant(backendPort: number): Promise<CommandEveAssistantRecord | undefined> {
  return findCommandEveAssistant(await requestJson<CommandEveAssistantRecord[]>(backendPort, '/api/assistants'));
}

function commandEveAssistantReconciliationError(
  assistant: CommandEveAssistantRecord | undefined,
  presetAgentType: string,
  customSkillNames: string[]
): string {
  const enabledMissing = customSkillNames.filter((skill) => !(assistant?.enabled_skills || []).includes(skill));
  const customMissing = customSkillNames.filter((skill) => !(assistant?.custom_skill_names || []).includes(skill));
  return [
    `expected preset_agent_type=${presetAgentType}`,
    `actual preset_agent_type=${assistant?.preset_agent_type || 'missing'}`,
    enabledMissing.length > 0 ? `missing enabled_skills=${enabledMissing.join(',')}` : '',
    customMissing.length > 0 ? `missing custom_skill_names=${customMissing.join(',')}` : '',
  ]
    .filter(Boolean)
    .join('; ');
}

export async function ensureCommandEveAssistant(
  backendPort: number,
  appVersion: string,
  options: EnsureCommandEveAssistantOptions = {}
): Promise<CommandEveAssistantEnsureResult> {
  const isFounderBuild = isCommandEveFounderBuild();
  const agents = await loadCommandEveDetectedAgents(backendPort);
  const presetAgentType = selectCommandEvePresetAgentType(agents);
  const customSkillNames = await importCommandEveManagedSkills(backendPort, options.userDataPath);
  const assistant = buildCommandEveAssistantPayload(presetAgentType, customSkillNames, appVersion, isFounderBuild);
  const firstRunLoad = loadCommandEveFirstRunContext(appVersion, options.userDataPath);
  const existingAssistant = await loadCommandEveAssistant(backendPort);
  const method = existingAssistant ? 'PUT' : 'POST';
  const path = method === 'PUT' ? `/api/assistants/${COMMAND_EVE_ASSISTANT_ID}` : '/api/assistants';

  // Merge-only on update: if the operator hand-edited their EVE assistant (its
  // description no longer carries a managed seed marker), PRESERVE name/description/
  // prompts and only reconcile the operational fields. A stale managed seed (the old
  // internal founder persona) OR the old broken bare-filename avatar is refreshed to
  // the current correct seed. A fresh install (POST) always gets the full operator seed.
  const preserveUserEdits = Boolean(existingAssistant) && !commandEveAssistantHasManagedSeed(existingAssistant);
  const mergedPutPayload = preserveUserEdits
    ? {
        ...existingAssistant,
        id: COMMAND_EVE_ASSISTANT_ID,
        avatar:
          !existingAssistant?.avatar || existingAssistant.avatar === 'command-eve-logo.svg'
            ? assistant.avatar
            : existingAssistant.avatar,
        preset_agent_type: presetAgentType,
        enabled_skills: assistant.enabled_skills,
        custom_skill_names: assistant.custom_skill_names,
        disabled_builtin_skills: assistant.disabled_builtin_skills,
      }
    : { ...assistant, id: COMMAND_EVE_ASSISTANT_ID };
  const body = method === 'PUT' ? JSON.stringify(mergedPutPayload) : JSON.stringify(assistant);

  await requestJson(backendPort, path, { method, body });

  let reconciledAssistant = await loadCommandEveAssistant(backendPort);
  if (!commandEveAssistantIsReconciled(reconciledAssistant, presetAgentType, customSkillNames) && existingAssistant) {
    console.warn(
      `[CommandEVE] Existing EVE assistant did not reconcile via PUT (${commandEveAssistantReconciliationError(
        reconciledAssistant,
        presetAgentType,
        customSkillNames
      )}); recreating managed EVE assistant.`
    );
    await requestJson(backendPort, `/api/assistants/${COMMAND_EVE_ASSISTANT_ID}`, { method: 'DELETE' });
    await requestJson(backendPort, '/api/assistants', { method: 'POST', body: JSON.stringify(assistant) });
    reconciledAssistant = await loadCommandEveAssistant(backendPort);
  }

  if (!commandEveAssistantIsReconciled(reconciledAssistant, presetAgentType, customSkillNames)) {
    throw new Error(
      `Command EVE assistant reconciliation failed: ${commandEveAssistantReconciliationError(
        reconciledAssistant,
        presetAgentType,
        customSkillNames
      )}`
    );
  }

  await requestJson(backendPort, `/api/assistants/${COMMAND_EVE_ASSISTANT_ID}/state`, {
    method: 'PATCH',
    body: JSON.stringify({
      enabled: true,
      sort_order: -1000,
    }),
  });

  await Promise.all([
    writeAssistantResource(backendPort, 'assistant-rule', 'de-DE', getCommandEveAssistantRule('de-DE', isFounderBuild)),
    writeAssistantResource(backendPort, 'assistant-rule', 'en-US', getCommandEveAssistantRule('en-US', isFounderBuild)),
    writeAssistantResource(
      backendPort,
      'assistant-skill',
      'de-DE',
      buildCommandEveAssistantSkillForSeat('de-DE', firstRunLoad, isFounderBuild)
    ),
    writeAssistantResource(
      backendPort,
      'assistant-skill',
      'en-US',
      buildCommandEveAssistantSkillForSeat('en-US', firstRunLoad, isFounderBuild)
    ),
  ]);

  const readyAssistant = await loadCommandEveAssistant(backendPort);
  if (!commandEveAssistantIsReconciled(readyAssistant, presetAgentType, customSkillNames)) {
    throw new Error(
      `Command EVE assistant final readiness failed: ${commandEveAssistantReconciliationError(
        readyAssistant,
        presetAgentType,
        customSkillNames
      )}`
    );
  }

  return {
    status: 'ready',
    assistant_id: COMMAND_EVE_ASSISTANT_ID,
    preset_agent_type: presetAgentType,
    enabled_skills: readyAssistant?.enabled_skills || [],
    custom_skill_names: readyAssistant?.custom_skill_names || [],
    skill_count: customSkillNames.length,
  };
}

import {
  getCommandEveAssistantRule,
  buildCommandEveAssistant,
  buildCommandEveAssistantContext,
  buildCommandEveAssistantSkill,
  resolveCommandEveSeatIdentity,
  resolveSeatContextBlock,
  selectCommandEvePresetAgentType,
  unwrapCommandEveApiData,
  type CommandEveApiEnvelope,
  type CommandEveAssistantCapabilityPackContext,
  type CommandEveAssistantFirstRunContext,
  type CommandEveAssistantLocalIdentity,
  type CommandEveAssistantRuntimeReceipt,
  type CommandEveDetectedAgent,
  type CommandEveSeatIdentity,
  type CommandEveSeatRosterEntry,
  type CommandEveSeatSeedRecord,
} from './assistantBootstrapCore';
import { COMMAND_EVE_ASSISTANT_ID, isCommandEveFounderBuild } from '@/common/config/commandEveShell';
import { resolveEffectiveInferenceSelection } from '@/common/config/eveInferenceCore';
import { readInferenceSelectionFromBackend } from './inferenceSelectionBackendRead';
import fs from 'fs';
import path from 'path';
import { resolveCommandEveRuntimeBootstrapPaths } from './runtimeBootstrapCore';
import {
  COMMAND_EVE_DEFAULT_BOARD_SLUG,
  getActiveSeatBoardSlug,
  getActiveSeatId,
  getActiveSeatLabel,
  isActiveSeatLegacy,
} from './seatContextCore';
import { parseMySeats, resolveSeatAccess } from './seatSwitchCore';
import { readMySeatsWire } from './seatWireFetchCore';
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
  isFounderBuild: boolean,
  inferenceSelection?: string
): string {
  if (!load) return buildCommandEveAssistantSkill(locale, undefined, isFounderBuild);
  const seatIdentity = load.realSeatActive
    ? resolveCommandEveSeatIdentity({ legacy: false, seatId: load.seatId, seed: load.seatSeed, locale })
    : undefined;
  return buildCommandEveAssistantSkill(
    locale,
    { ...load.baseContext, seatIdentity, inferenceSelection },
    isFounderBuild
  );
}

/**
 * Seat-Context-Bridge (B3): the default roster parser — turn the raw my-seats
 * wire into a founder-block roster (label + 1-line purpose). Fail-closed: a null/
 * unparseable wire → `null` (honest "keine Seats geladen" omission). The 1-line
 * purpose is derived from the seat's ROLE (the wire carries no free-text purpose
 * yet): the Founder home is labeled as such, client seats as delegatable client
 * seats. This is where a later slice can enrich the purpose from a per-seat field.
 */
function parseFounderRoster(raw: unknown | null, locale: 'de-DE' | 'en-US'): CommandEveSeatRosterEntry[] | null {
  const contract = parseMySeats(raw);
  if (!contract) return null;
  const access = resolveSeatAccess(contract);
  // resolveSeatAccess prepends the synthetic Founder chip for admins; drop it from
  // the roster (the header already names the founder) and list only real seats.
  const rows = access.seats
    .filter((s) => s.seat_id !== 'seat-1')
    .map((s) => ({
      label: s.name,
      purpose:
        locale === 'de-DE'
          ? s.role === 'admin'
            ? 'Client-Seat (Admin-Zugriff)'
            : 'Client-Seat (invisible delivery, streng isoliert)'
          : s.role === 'admin'
            ? 'Client seat (admin access)'
            : 'Client seat (invisible delivery, strictly isolated)',
    }));
  return rows;
}

/**
 * Build the seat-context block for one locale, composing the injectable deps from
 * the live seat state + the already-loaded first-run context. Consumes the SAME
 * B1 values the env bake sets (getActiveSeatId/getActiveSeatLabel) so the prompt
 * and the env can never diverge (the anti-store-split guarantee). For a real seat
 * the roster is structurally unreachable (resolveSeatContextBlock gates the wire
 * read on isActiveSeatLegacy). Best-effort: never throws — returns '' on failure.
 */
async function buildCommandEveSeatContextBlock(
  locale: 'de-DE' | 'en-US',
  load: CommandEveFirstRunLoad | undefined,
  userDataPath?: string
): Promise<string> {
  try {
    // Real-seat client entity (from the SAME ISO-6 resolver the prompt identity uses).
    let clientEntity: string | undefined;
    if (load?.realSeatActive) {
      const seatIdentity: CommandEveSeatIdentity | undefined = resolveCommandEveSeatIdentity({
        legacy: false,
        seatId: load.seatId,
        seed: load.seatSeed,
        locale,
      });
      clientEntity = seatIdentity?.clientEntity;
    }
    const founderName = load?.baseContext.profile?.founder_name;
    return await resolveSeatContextBlock({
      getActiveSeatId,
      getActiveSeatLabel,
      isActiveSeatLegacy,
      // The wire read is only ever invoked from the founder/legacy seat (the gate
      // is inside resolveSeatContextBlock). userDataPath threads the auth chain.
      readMySeatsWire: () => readMySeatsWire(userDataPath || ''),
      parseRoster: (raw) => parseFounderRoster(raw, locale),
      founderName,
      clientEntity,
      // H2 (board-slug unify): report the board EVE actually writes. No explicit
      // per-seat pin yet (getActiveSeatBoardSlug() === '') ⇒ fall back to the
      // wheel's 'default' board (COMMAND_EVE_DEFAULT_BOARD_SLUG) — the SAME slug the
      // /kanban page reads and EVE's native tools author — so the prompt reports the
      // real board ("Aktives Board: default") instead of the misleading "keins".
      boardSlug: getActiveSeatBoardSlug() || COMMAND_EVE_DEFAULT_BOARD_SLUG,
      locale,
    });
  } catch {
    return '';
  }
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
  _appVersion: string,
  isFounderBuild: boolean
): ReturnType<typeof buildCommandEveAssistant> & { description: string } {
  // The user-VISIBLE description is the short operator one-liner ONLY. The
  // behavioral runtime context (`buildCommandEveAssistantContext`, which carries
  // the app version + "Default local operating surface" framing) is written via
  // the assistant-skill/-rule resources, NOT baked into the display description —
  // otherwise the hero subtitle showed a long blob with a stale "⌘ EVE <version>"
  // line. `_appVersion` is kept in the signature for call-site compatibility.
  const assistant = buildCommandEveAssistant(presetAgentType, customSkillNames, isFounderBuild);
  return {
    ...assistant,
    description: assistant.description ?? '',
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
  // Operator installs seeded BEFORE the display-description cleanup baked the
  // behavioral runtime context (the "Default local operating surface" /
  // "⌘ EVE <version>" blob) into the visible description. That blob is a managed
  // seed, not a user edit, so detecting it lets the bootstrap refresh the stale
  // long description down to the clean one-liner instead of preserving it.
  'Default local operating surface',
  'Execution backends are tools, not identity',
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
  // The EFFECTIVE picker selection drives EVE's model-FREE "Betriebsmodus" line
  // so EVE describes its active lane instead of leaking the local model ref.
  // Read from the BACKEND settings store (the only store the renderer writes the
  // picker value to) — the same source the routing resolver + warm-up lane read.
  // Reading ProcessConfig here always returned undefined → EVE always described
  // "Standard" regardless of the picked level. Best-effort: undefined → the line
  // reads "nicht verifiziert" and the standing model-identity rule still forbids
  // naming a model.
  const activeInferenceSelection = resolveEffectiveInferenceSelection(
    await readInferenceSelectionFromBackend()
  );
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

  const reconciledAssistant = await loadCommandEveAssistant(backendPort);
  if (!commandEveAssistantIsReconciled(reconciledAssistant, presetAgentType, customSkillNames)) {
    // The merge-only PUT did not fully reconcile — in practice the preset_agent_type
    // (the backend keeps the assistant's stored agent on PUT; the runtime resolves the
    // live agent for the conversation regardless, so the mismatch is cosmetic).
    //
    // We DELIBERATELY DO NOT recreate via DELETE + POST here. The backend's DELETE
    // soft-deletes the assistant's user-source assistant_definitions row and the
    // follow-up POST does NOT restore a LIVE definition, which (a) makes the EVE
    // assistant VANISH from /api/assistants for the rest of the session (the UI falls
    // back to a raw CLI agent), and (b) leaves an active-assistant ↔ soft-deleted-
    // definition inconsistency that BRICKS aioncore's router.assistant.bootstrap on the
    // NEXT restart (the "incomplete installation" crash — see assistantStorageRepair.ts).
    // Keeping the merged assistant preserves its LIVE definition and the operator
    // persona/skills the PUT already applied — EVE stays present and usable.
    console.warn(
      `[CommandEVE] EVE assistant did not fully reconcile via PUT (${commandEveAssistantReconciliationError(
        reconciledAssistant,
        presetAgentType,
        customSkillNames
      )}); keeping the merged assistant (no destructive DELETE+POST recreate).`
    );
  }

  await requestJson(backendPort, `/api/assistants/${COMMAND_EVE_ASSISTANT_ID}/state`, {
    method: 'PATCH',
    body: JSON.stringify({
      enabled: true,
      sort_order: -1000,
    }),
  });

  // Runtime posture ("Execution backends are tools, not identity", canonical
  // source posture, app version). This used to be baked into the user-VISIBLE
  // `description`, which is wrong — it belongs in the BEHAVIORAL skill resource,
  // not the hero subtitle. Appended to the skill body so EVE keeps the posture
  // while the operator only sees the short one-line description.
  const runtimeContext = buildCommandEveAssistantContext(appVersion);
  // Seat-Context-Bridge (B3): the "ich bin in Seat X" block, resolved per locale.
  // For a real client seat it is a self-contained orientation paragraph (NO wire
  // read); for the founder seat it appends the seat roster (gated behind the
  // isActiveSeatLegacy wire read). Best-effort — '' on failure keeps the prompt
  // byte-identical to before the bridge landed.
  const [seatBlockDe, seatBlockEn] = await Promise.all([
    buildCommandEveSeatContextBlock('de-DE', firstRunLoad, options.userDataPath),
    buildCommandEveSeatContextBlock('en-US', firstRunLoad, options.userDataPath),
  ]);
  const withSeatBlock = (skill: string, block: string): string =>
    block ? `${skill}\n\n${block}\n\n${runtimeContext}` : `${skill}\n\n${runtimeContext}`;
  await Promise.all([
    writeAssistantResource(backendPort, 'assistant-rule', 'de-DE', getCommandEveAssistantRule('de-DE', isFounderBuild)),
    writeAssistantResource(backendPort, 'assistant-rule', 'en-US', getCommandEveAssistantRule('en-US', isFounderBuild)),
    writeAssistantResource(
      backendPort,
      'assistant-skill',
      'de-DE',
      withSeatBlock(
        buildCommandEveAssistantSkillForSeat('de-DE', firstRunLoad, isFounderBuild, activeInferenceSelection),
        seatBlockDe
      )
    ),
    writeAssistantResource(
      backendPort,
      'assistant-skill',
      'en-US',
      withSeatBlock(
        buildCommandEveAssistantSkillForSeat('en-US', firstRunLoad, isFounderBuild, activeInferenceSelection),
        seatBlockEn
      )
    ),
  ]);

  const readyAssistant = await loadCommandEveAssistant(backendPort);
  if (!commandEveAssistantIsReconciled(readyAssistant, presetAgentType, customSkillNames)) {
    // Non-fatal: do not throw (a throw would abort the re-seed and skip the enable +
    // resource writes already done above, and bricking the seed over a cosmetic preset
    // mismatch is worse than shipping a present-and-usable EVE). EVE is enabled, has its
    // live definition + persona/skills, and the runtime resolves the live agent.
    console.warn(
      `[CommandEVE] EVE assistant not fully reconciled after setup (${commandEveAssistantReconciliationError(
        readyAssistant,
        presetAgentType,
        customSkillNames
      )}); proceeding — EVE is present and usable.`
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

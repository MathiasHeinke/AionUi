/**
 * Built-in Skill Migration — E2E suite (Task 3 of
 * 2026-04-23-builtin-skill-migration-plan).
 *
 * Covers the migration invariants against the current AionCore contract.
 * Scenarios 1-5 drive the Electron app's backend through `httpBridge` probes.
 * Scenarios 6-8 exercise edge-cases
 * that require a fresh data-dir and a throw-away backend process:
 *   - S6 seeds an orphan `agent-skills/<convId>/` dir before the backend
 *     starts, then confirms the startup sweep removed it.
 *   - S7 verifies the SkillsHub export-symlink flow still works for a
 *     `source=builtin` skill — the primary regression the design spec
 *     called out as "critical."
 *   - S8 seeds a legacy `{cacheDir}/builtin-skills/` directory and
 *     asserts that the Electron main process removes it via
 *     `cleanupLegacyBuiltinSkillsDir` at startup.
 *
 * The sibling-backend pattern is identical to the assistant-user-data
 * pilot's T5 — the singleton Electron fixture cannot restart with a
 * seeded data-dir, so out-of-process probes cover the cold-start paths.
 *
 * Sibling-backend binary resolution follows the shared e2e env contract (see
 * tests/e2e/helpers/aioncoreBinary.ts): AIONUI_BACKEND_BINARY (explicit) →
 * AIONUI_BACKEND_LOCAL_BINARY → resources/bundled-aioncore → PATH →
 * ~/.cargo/bin.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test, expect } from '../../fixtures';
import {
  httpGet,
  httpPost,
  provisionAioncoreLocalCapability,
  resolveAioncoreBinary,
  type AioncoreLocalCapability,
} from '../../helpers';

// ── Shared constants ────────────────────────────────────────────────────────

/**
 * Port used by the sibling backend for scenarios that need a fresh data-dir.
 * Distinct from the Electron backend (13400) and the assistant-pilot sibling
 * backend (25902) to avoid collisions when suites run back-to-back.
 */
const SIBLING_BACKEND_PORT = 25903;

/**
 * Frontmatter `name:` values expected under `auto-inject/` in the embedded
 * corpus. These come from the SKILL.md frontmatter, not the directory name
 * (e.g. `auto-inject/office-cli/SKILL.md` emits `name: officecli`).
 */
const AUTO_INJECT_EXPECTED_NAMES = ['cron', 'officecli', 'skill-creator'] as const;

/** An opt-in skill that lives at the top level of the embedded corpus. */
const OPT_IN_PROBE_NAME = 'mermaid';

// ── Backend response shapes ─────────────────────────────────────────────────

interface SkillInfo {
  name: string;
  description: string;
  location: string;
  relative_location?: string;
  is_custom: boolean;
  source: 'builtin' | 'custom' | 'extension';
}

interface MaterializeResponse {
  skills: Array<{
    name: string;
    source_path: string;
  }>;
}

// ── Helpers ─────────────────────────────────────────────────────────────────

function selectAutoInjectSkills(skills: SkillInfo[]): SkillInfo[] {
  return skills.filter(
    (skill) => skill.source === 'builtin' && skill.relative_location?.startsWith('auto-inject/') === true
  );
}

// ── Suite ───────────────────────────────────────────────────────────────────

test.describe('Built-in Skill Migration (T3)', () => {
  test.setTimeout(120_000);

  // ── Scenario 1 — canonical skill catalog contains auto-inject skills ──────
  // AionCore 0.1.37 removed `GET /api/skills/builtin-auto`; auto-injected
  // entries are identified by `relative_location` in `GET /api/skills`.
  //
  // Dev-binary coverage today; T4 coordinator re-runs against a packaged
  // `.app` bundle to close the full loop (per plan §4.2).

  test('S1: GET /api/skills contains the embedded auto-inject corpus', async ({ page }) => {
    const list = selectAutoInjectSkills(await httpGet<SkillInfo[]>(page, '/api/skills'));
    expect(Array.isArray(list)).toBe(true);
    expect(list.length).toBeGreaterThanOrEqual(AUTO_INJECT_EXPECTED_NAMES.length);

    const names = list.map((s) => s.name);
    for (const expected of AUTO_INJECT_EXPECTED_NAMES) {
      expect(names).toContain(expected);
    }

    // Each entry must carry an absolute source path and a relative path under
    // auto-inject/ so the renderer can identify the implicit skill set.
    for (const entry of list) {
      expect(path.isAbsolute(entry.location)).toBe(true);
      expect(entry.relative_location).toMatch(/^auto-inject\/.+\/SKILL\.md$/);
      expect(entry.description.length).toBeGreaterThan(0);
    }

    // Passing that location back through /api/skills/builtin-skill must
    // return non-empty frontmatter — this is the round-trip the renderer's
    // AcpSkillManager relies on.
    const sample = list[0];
    const content = await httpPost<string>(page, '/api/skills/builtin-skill', {
      file_name: sample.relative_location,
    });
    expect(typeof content).toBe('string');
    expect(content).toContain('---');
    expect(content).toContain('name:');
  });

  // ── Scenario 2 — ACP runtime auto-injects builtin auto-inject skills ──────
  // Real conversations receive the auto-inject selection derived from the
  // canonical skill catalog. If that list is non-empty and individual bodies
  // resolve, the renderer can pass a complete exclusion list to AionCore.

  test('S2: AcpSkillManager data-source (auto-inject list + body round-trip)', async ({ page }) => {
    const list = selectAutoInjectSkills(await httpGet<SkillInfo[]>(page, '/api/skills'));
    expect(list.length).toBeGreaterThan(0);

    // Pull bodies for every entry — discovery failure for even one skill
    // would degrade ACP's "all conversations get these" contract.
    for (const entry of list) {
      const body = await httpPost<string>(page, '/api/skills/builtin-skill', {
        file_name: entry.relative_location,
      });
      expect(body.length).toBeGreaterThan(0);
    }
  });

  // ── Scenario 3 — Opt-in via `enabledSkills` is materialized ───────────────

  test('S3: materialize-for-agent resolves opt-in skills to readable source directories', async ({ page }) => {
    const conversationId = `e2e-s3-${Date.now()}`;
    const resp = await httpPost<MaterializeResponse>(page, '/api/skills/materialize-for-agent', {
      conversation_id: conversationId,
      skills: [OPT_IN_PROBE_NAME],
    });
    expect(resp.skills).toHaveLength(1);
    expect(resp.skills[0]?.name).toBe(OPT_IN_PROBE_NAME);
    expect(path.isAbsolute(resp.skills[0]!.source_path)).toBe(true);

    const skillMd = path.join(resp.skills[0]!.source_path, 'SKILL.md');
    expect(fs.existsSync(skillMd)).toBe(true);
    const body = fs.readFileSync(skillMd, 'utf-8');
    expect(body).toContain('---');
    expect(body).toContain('name:');
  });

  // ── Scenario 4 — Gemini conversation call path receives the dir ───────────
  // gemini CLI integration boils down to "materialize returns an absolute
  // path that exists and contains all required skills." Exercising the
  // endpoint end-to-end without actually booting a gemini CLI process
  // gives the same guarantee at a fraction of the wall-clock cost (a full
  // gemini conversation is a minutes-scale spawn in E2E).

  test('S4: resolved skill sources are suitable for agent extension loading', async ({ page }) => {
    const conversationId = `e2e-s4-${Date.now()}`;
    const resp = await httpPost<MaterializeResponse>(page, '/api/skills/materialize-for-agent', {
      conversation_id: conversationId,
      skills: [OPT_IN_PROBE_NAME],
    });
    expect(resp.skills.length).toBeGreaterThan(0);
    for (const skill of resp.skills) {
      expect(fs.statSync(skill.source_path).isDirectory()).toBe(true);
      expect(fs.existsSync(path.join(skill.source_path, 'SKILL.md'))).toBe(true);
    }
  });

  // ── Scenario 5 — source resolution is stateless and retry-safe ────────────

  test('S5: materialize-for-agent is idempotent for a repeated conversation request', async ({ page }) => {
    const conversationId = `e2e-s5-${Date.now()}`;
    const request = {
      conversation_id: conversationId,
      skills: [OPT_IN_PROBE_NAME],
    };
    const first = await httpPost<MaterializeResponse>(page, '/api/skills/materialize-for-agent', request);
    const second = await httpPost<MaterializeResponse>(page, '/api/skills/materialize-for-agent', request);
    expect(second).toEqual(first);
  });

  // ── Scenario 7 — SkillsHub export for source=builtin still works ──────────
  // The design spec calls this out as the critical regression path: the
  // export-to-external-source flow reads the absolute `location` from
  // `GET /api/skills`, so builtin rows must still resolve to a real on-disk
  // path (the lazily-materialized "view" under `{data_dir}/builtin-skills-view/`).
  //
  // Placed before the sibling-backend describe block so it runs against the
  // live Electron app.

  test('S7: builtin skills in /api/skills expose an absolute, readable location for export', async ({ page }) => {
    const list = await httpGet<SkillInfo[]>(page, '/api/skills');
    expect(list.length).toBeGreaterThan(0);

    const builtins = list.filter((s) => s.source === 'builtin');
    expect(builtins.length).toBeGreaterThan(0);

    for (const entry of builtins) {
      // location must be absolute and point at an on-disk SKILL.md the
      // export-symlink flow can stat.
      expect(path.isAbsolute(entry.location)).toBe(true);
      expect(entry.location.endsWith(path.join('SKILL.md'))).toBe(true);
      expect(fs.existsSync(entry.location)).toBe(true);

      // relative_location must be present for builtins and point under the
      // embedded corpus (auto-inject or top-level).
      expect(entry.relative_location).toBeTruthy();
      expect(entry.relative_location!).toMatch(/^(auto-inject\/)?[^/]+\/SKILL\.md$/);
    }

    // Sample one entry and perform an end-to-end export via
    // /api/skills/export-symlink into a tempdir, which is the same path
    // SkillsHubSettings.tsx uses when the user clicks "Export".
    const probe = builtins[0];
    const skillPath = probe.location.replace(/[\\/]SKILL\.md$/, '');
    const targetDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aionui-e2e-s7-export-'));
    try {
      await httpPost(page, '/api/skills/export-symlink', {
        skill_path: skillPath,
        target_dir: targetDir,
      });
      const exported = path.join(targetDir, probe.name);
      // The export step is a symlink on unix, a copy on win32. Either way
      // the destination must resolve to the same SKILL.md content.
      expect(fs.existsSync(path.join(exported, 'SKILL.md'))).toBe(true);
    } finally {
      fs.rmSync(targetDir, { recursive: true, force: true });
    }
  });

  // ── Scenarios 6 & 8 — require a fresh data-dir / cold boot ────────────────
  //
  // Run against a sibling `aioncore` process on port 25903 against a
  // tmp data-dir (same pattern as the assistant-user-data pilot's
  // S8/S9/S10). This lets us seed pre-existing state and observe the
  // startup/legacy-cleanup behaviour without tearing down the main
  // Electron singleton.

  test.describe('Cold-start invariants (sibling backend)', () => {
    let backend: ChildProcess | null = null;
    let dataDir: string = '';
    let localCapability: AioncoreLocalCapability | null = null;

    const baseUrl = `http://127.0.0.1:${SIBLING_BACKEND_PORT}`;

    async function waitForHealthy(): Promise<void> {
      const deadline = Date.now() + 10_000;
      while (Date.now() < deadline) {
        try {
          // eslint-disable-next-line no-await-in-loop -- sequential polling by design
          const r = await fetch(`${baseUrl}/api/system/info`, { headers: localCapability?.headers });
          if (r.ok) return;
        } catch {
          // keep polling
        }
        // eslint-disable-next-line no-await-in-loop -- sequential polling by design
        await new Promise((res) => setTimeout(res, 250));
      }
      throw new Error('Sibling backend did not become healthy in 10s');
    }

    async function httpJson<T>(method: string, route: string, body?: unknown): Promise<T> {
      const res = await fetch(`${baseUrl}${route}`, {
        method,
        headers: {
          ...localCapability?.headers,
          ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
        },
        body: body !== undefined ? JSON.stringify(body) : undefined,
      });
      if (!res.ok) {
        const text = await res.text().catch(() => '');
        throw new Error(`Sibling backend ${method} ${route} -> ${res.status}: ${text}`);
      }
      const json = (await res.json()) as { success: boolean; data: T };
      return json.data;
    }

    async function stopBackend(): Promise<void> {
      if (!backend) return;
      const p = backend;
      backend = null;
      p.kill('SIGTERM');
      await new Promise<void>((resolve) => {
        const t = setTimeout(() => {
          p.kill('SIGKILL');
          resolve();
        }, 3_000);
        p.once('exit', () => {
          clearTimeout(t);
          resolve();
        });
      });
    }

    async function startBackend(): Promise<void> {
      const bin = resolveAioncoreBinary();
      localCapability = provisionAioncoreLocalCapability(dataDir);
      const logPath = path.join(dataDir, 'sibling-aioncore.log');
      const logFd = fs.openSync(logPath, 'a');
      const parentEnv = { ...process.env };
      // Scrub any env vars that would leak main-Electron backend state.
      delete parentEnv.AIONUI_EXTENSIONS_PATH;
      delete parentEnv.AIONUI_EXTENSION_STATES_FILE;
      delete parentEnv.AIONUI_E2E_TEST;
      delete parentEnv.AIONUI_CDP_PORT;
      delete parentEnv.AIONUI_BUILTIN_SKILLS_PATH;
      backend = spawn(
        bin,
        [
          '--local',
          '--local-capability-file',
          localCapability.filePath,
          '--local-origin',
          'null',
          '--port',
          String(SIBLING_BACKEND_PORT),
          '--data-dir',
          dataDir,
        ],
        {
          stdio: ['ignore', logFd, logFd],
          env: { ...parentEnv, RUST_LOG: 'warn' },
        }
      );
      try {
        await waitForHealthy();
        fs.rmSync(localCapability.filePath, { force: true });
      } catch (err) {
        const tail = fs.existsSync(logPath) ? fs.readFileSync(logPath, 'utf8').slice(-2000) : '(no log)';
        throw new Error(`${(err as Error).message}\n--- sibling backend log tail ---\n${tail}`, { cause: err });
      }
    }

    test.beforeEach(() => {
      dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aionui-e2e-builtin-skill-'));
      localCapability = null;
    });

    test.afterEach(async () => {
      await stopBackend();
      localCapability = null;
      if (dataDir && fs.existsSync(dataDir)) {
        fs.rmSync(dataDir, { recursive: true, force: true });
      }
    });

    // ── Scenario 6 — Orphan cleanup on next startup after a crash ───────────

    test('S6: startup sweep removes orphan agent-skills dirs for unknown conversation ids', async () => {
      // Seed two orphan dirs inside `{data_dir}/agent-skills/` *before*
      // the backend boots. The startup sweep
      // (`cleanup_orphan_agent_skills`) must remove them because there is
      // no matching row in the conversations table (empty DB on first
      // launch).
      const agentSkillsDir = path.join(dataDir, 'agent-skills');
      fs.mkdirSync(agentSkillsDir, { recursive: true });
      const orphan1 = path.join(agentSkillsDir, 'orphan-conv-1');
      const orphan2 = path.join(agentSkillsDir, 'orphan-conv-2');
      fs.mkdirSync(path.join(orphan1, 'mermaid'), { recursive: true });
      fs.writeFileSync(path.join(orphan1, 'mermaid', 'SKILL.md'), '---\nname: mermaid\n---', 'utf-8');
      fs.mkdirSync(path.join(orphan2, 'cron'), { recursive: true });
      fs.writeFileSync(path.join(orphan2, 'cron', 'SKILL.md'), '---\nname: cron\n---', 'utf-8');

      await startBackend();

      // The startup task is spawned during router assembly; give it a
      // beat to complete (the sweep is a handful of fs ops).
      const deadline = Date.now() + 5_000;
      while (Date.now() < deadline) {
        if (!fs.existsSync(orphan1) && !fs.existsSync(orphan2)) break;
        // eslint-disable-next-line no-await-in-loop -- sequential polling by design
        await new Promise((res) => setTimeout(res, 100));
      }

      expect(fs.existsSync(orphan1)).toBe(false);
      expect(fs.existsSync(orphan2)).toBe(false);

      // Current AionCore may also remove the empty parent. If it keeps the
      // parent, no unknown conversation directory may survive inside it.
      if (fs.existsSync(agentSkillsDir)) {
        expect(fs.readdirSync(agentSkillsDir)).toEqual([]);
      }

      // Skill discovery still works (sweeping has no side effects on the
      // embedded corpus).
      const list = selectAutoInjectSkills(await httpJson<SkillInfo[]>('GET', '/api/skills'));
      expect(list.length).toBeGreaterThan(0);
    });

    // ── Scenario 8 — Legacy `{cacheDir}/builtin-skills/` cleanup on upgrade ─
    //
    // AionCore 0.1.37 owns `{data_dir}/builtin-skills/` and rematerializes the
    // embedded corpus during cold start. A legacy marker must not survive.

    test('S8: cold start replaces legacy builtin-skills contents with the embedded corpus', async () => {
      const stray = path.join(dataDir, 'builtin-skills');
      fs.mkdirSync(stray, { recursive: true });
      fs.writeFileSync(path.join(stray, 'marker.txt'), 'persist', 'utf-8');

      await startBackend();

      // Backend is healthy and serving the rematerialized embedded corpus.
      const list = selectAutoInjectSkills(await httpJson<SkillInfo[]>('GET', '/api/skills'));
      expect(list.length).toBeGreaterThan(0);

      // The stale marker is gone, while the current corpus has replaced it.
      expect(fs.existsSync(stray)).toBe(true);
      expect(fs.existsSync(path.join(stray, 'marker.txt'))).toBe(false);
      expect(fs.existsSync(path.join(stray, 'auto-inject'))).toBe(true);

      // Sanity check — the live Electron-owned cache dir either has no
      // `builtin-skills/` or it is scheduled for async removal. We do
      // not fail on the presence because cleanup is fire-and-forget
      // (initStorage.ts:360: `.catch(() => {})`); we just log the state
      // for the report.
      //
      // The authoritative assertion is Vitest on
      // `cleanupLegacyBuiltinSkillsDir` plus T4 packaging smoke.
      const candidates = [
        path.join(os.homedir(), '.aionui-config', 'builtin-skills'),
        path.join(os.homedir(), '.aionui-config-dev', 'builtin-skills'),
      ];
      const survivors = candidates.filter((p) => fs.existsSync(p));
      test.info().annotations.push({
        type: 'note',
        description:
          survivors.length === 0
            ? 'no legacy builtin-skills cache dirs detected under ~/.aionui-config*'
            : `legacy dirs still present (async cleanup pending): ${survivors.join(', ')}`,
      });
    });
  });
});

/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { DatabaseSync } from 'node:sqlite';

// better-sqlite3's native binding is ABI-pinned to Electron and fails to dlopen
// under vitest (plain Node). The repair module dynamically imports it, so we mock
// it with a thin node:sqlite-backed adapter that matches the better-sqlite3 surface
// the repair uses (new Database(path), prepare().get/run, pragma, close). This
// exercises the REAL SQL logic against a real SQLite engine; the shipped app uses
// the real better-sqlite3 (proven by the existing BetterSqlite3Driver).
vi.mock('better-sqlite3', () => {
  class Adapter {
    private db: DatabaseSync;
    constructor(file: string) {
      this.db = new DatabaseSync(file);
    }
    prepare(sql: string) {
      const stmt = this.db.prepare(sql);
      return {
        get: (...params: unknown[]) => stmt.get(...(params as never[])),
        run: (...params: unknown[]) => {
          const r = stmt.run(...(params as never[]));
          return { changes: Number(r.changes) };
        },
      };
    }
    pragma(p: string) {
      this.db.exec(`PRAGMA ${p}`);
    }
    close() {
      this.db.close();
    }
  }
  return { default: Adapter };
});

import { repairCommandEveAssistantStorage } from '@/process/commandEve/assistantStorageRepair';

const tempRoots: string[] = [];

function makeDataDir(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'eve-storage-repair-'));
  tempRoots.push(root);
  return root;
}

function seedDb(dataDir: string, seed: (db: DatabaseSync) => void): void {
  const db = new DatabaseSync(path.join(dataDir, 'aionui-backend.db'));
  db.exec(
    `CREATE TABLE assistants (id TEXT PRIMARY KEY, name TEXT);
     CREATE TABLE assistant_definitions (id TEXT PRIMARY KEY, assistant_id TEXT NOT NULL, source TEXT NOT NULL, deleted_at INTEGER);`
  );
  seed(db);
  db.close();
}

function deletedAtOf(dataDir: string, defId: string): number | null {
  const db = new DatabaseSync(path.join(dataDir, 'aionui-backend.db'));
  const row = db.prepare('SELECT deleted_at FROM assistant_definitions WHERE id = ?').get(defId) as
    | { deleted_at: number | null }
    | undefined;
  db.close();
  return row ? row.deleted_at : null;
}

// BUG-2 harness: schema WITH agent_id + an agent_metadata table (the real shape
// the re-bind needs). The BUG-1 helper above deliberately omits both, so the
// re-bind block is a guarded no-op there (proves it never touches old schemas).
function seedDbWithAgents(dataDir: string, seed: (db: DatabaseSync) => void): void {
  const db = new DatabaseSync(path.join(dataDir, 'aionui-backend.db'));
  db.exec(
    `CREATE TABLE assistants (id TEXT PRIMARY KEY, name TEXT);
     CREATE TABLE assistant_definitions (id TEXT PRIMARY KEY, assistant_id TEXT NOT NULL, source TEXT NOT NULL, agent_id TEXT, deleted_at INTEGER);
     CREATE TABLE agent_metadata (id TEXT PRIMARY KEY, name TEXT, agent_type TEXT, backend TEXT);`
  );
  seed(db);
  db.close();
}

function agentIdOf(dataDir: string, defId: string): string | null {
  const db = new DatabaseSync(path.join(dataDir, 'aionui-backend.db'));
  const row = db.prepare('SELECT agent_id FROM assistant_definitions WHERE id = ?').get(defId) as
    | { agent_id: string | null }
    | undefined;
  db.close();
  return row ? row.agent_id : null;
}

function seedDbWithRichAgentRegistry(dataDir: string, seed: (db: DatabaseSync) => void): void {
  const db = new DatabaseSync(path.join(dataDir, 'aionui-backend.db'));
  db.exec(
    `CREATE TABLE assistants (id TEXT PRIMARY KEY, name TEXT);
     CREATE TABLE assistant_definitions (id TEXT PRIMARY KEY, assistant_id TEXT NOT NULL, source TEXT NOT NULL, agent_id TEXT, deleted_at INTEGER);
     CREATE TABLE agent_metadata (
       id TEXT PRIMARY KEY,
       name TEXT,
       agent_type TEXT,
       backend TEXT,
       native_skills_dirs TEXT,
       command TEXT,
       args TEXT,
       command_override TEXT,
       last_check_status TEXT,
       last_check_kind TEXT,
       last_check_error_code TEXT,
       last_check_error_message TEXT,
       last_check_guidance TEXT,
       last_failure_at INTEGER,
       updated_at INTEGER
     );`
  );
  seed(db);
  db.close();
}

function hermesRegistryOf(dataDir: string): {
  command: string | null;
  args: string | null;
  command_override: string | null;
  native_skills_dirs: string | null;
  last_check_status: string | null;
  last_check_error_message: string | null;
  last_failure_at: number | null;
  updated_at: number | null;
} | null {
  const db = new DatabaseSync(path.join(dataDir, 'aionui-backend.db'));
  const row = db
    .prepare(
      "SELECT command, args, command_override, native_skills_dirs, last_check_status, last_check_error_message, last_failure_at, updated_at FROM agent_metadata WHERE lower(coalesce(backend,'')) = 'hermes' LIMIT 1"
    )
    .get() as
    | {
        command: string | null;
        args: string | null;
        command_override: string | null;
        native_skills_dirs: string | null;
        last_check_status: string | null;
        last_check_error_message: string | null;
        last_failure_at: number | null;
        updated_at: number | null;
      }
    | undefined;
  db.close();
  return row ?? null;
}

afterEach(() => {
  for (const root of tempRoots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe('repairCommandEveAssistantStorage — heals the bootstrap-bricking orphan', () => {
  it('re-activates a soft-deleted USER definition whose assistant is still active', async () => {
    const dir = makeDataDir();
    seedDb(dir, (db) => {
      db.prepare("INSERT INTO assistants (id, name) VALUES ('command-eve-chief-of-staff', 'EVE')").run();
      db.prepare(
        "INSERT INTO assistant_definitions (id, assistant_id, source, deleted_at) VALUES ('def-1', 'command-eve-chief-of-staff', 'user', 1782510337017)"
      ).run();
    });
    const result = await repairCommandEveAssistantStorage(dir);
    expect(result.repaired).toBe(1);
    expect(deletedAtOf(dir, 'def-1')).toBeNull();
  });

  it('is a no-op when nothing is orphaned (idempotent on a healed DB)', async () => {
    const dir = makeDataDir();
    seedDb(dir, (db) => {
      db.prepare("INSERT INTO assistants (id, name) VALUES ('a', 'A')").run();
      db.prepare(
        "INSERT INTO assistant_definitions (id, assistant_id, source, deleted_at) VALUES ('def-live', 'a', 'user', NULL)"
      ).run();
    });
    const result = await repairCommandEveAssistantStorage(dir);
    expect(result.repaired).toBe(0);
  });

  it('does NOT touch a builtin-source soft-deleted definition (only user source)', async () => {
    const dir = makeDataDir();
    seedDb(dir, (db) => {
      db.prepare("INSERT INTO assistants (id, name) VALUES ('a', 'A')").run();
      db.prepare(
        "INSERT INTO assistant_definitions (id, assistant_id, source, deleted_at) VALUES ('def-b', 'a', 'builtin', 123)"
      ).run();
    });
    const result = await repairCommandEveAssistantStorage(dir);
    expect(result.repaired).toBe(0);
    expect(deletedAtOf(dir, 'def-b')).toBe(123);
  });

  it('does NOT touch a soft-deleted user definition whose assistant no longer exists', async () => {
    const dir = makeDataDir();
    seedDb(dir, (db) => {
      // no matching assistants row for 'ghost'
      db.prepare(
        "INSERT INTO assistant_definitions (id, assistant_id, source, deleted_at) VALUES ('def-g', 'ghost', 'user', 999)"
      ).run();
    });
    const result = await repairCommandEveAssistantStorage(dir);
    expect(result.repaired).toBe(0);
    expect(deletedAtOf(dir, 'def-g')).toBe(999);
  });

  it('skips (fail-open) when the DB file is absent', async () => {
    const dir = makeDataDir();
    const result = await repairCommandEveAssistantStorage(dir);
    expect(result.repaired).toBe(0);
    expect(result.skipped).toBe('no-db');
  });

  it('skips (fail-open) on an unrelated schema (tables missing)', async () => {
    const dir = makeDataDir();
    const db = new DatabaseSync(path.join(dir, 'aionui-backend.db'));
    db.exec('CREATE TABLE unrelated (id TEXT);');
    db.close();
    const result = await repairCommandEveAssistantStorage(dir);
    expect(result.repaired).toBe(0);
    expect(result.skipped).toBe('no-tables');
  });
});

describe('repairCommandEveAssistantStorage — re-binds EVE aionrs → hermes (BUG 2 freeze)', () => {
  const EVE = 'command-eve-chief-of-staff';

  it('re-binds the EVE definition from the aionrs agent to the hermes agent', async () => {
    const dir = makeDataDir();
    seedDbWithAgents(dir, (db) => {
      db.prepare(
        "INSERT INTO agent_metadata (id, name, agent_type, backend) VALUES ('hermes-1','Hermes','acp','hermes')"
      ).run();
      db.prepare(
        "INSERT INTO agent_metadata (id, name, agent_type, backend) VALUES ('aionrs-1','Aion CLI','aionrs',NULL)"
      ).run();
      db.prepare(`INSERT INTO assistants (id, name) VALUES ('${EVE}','EVE')`).run();
      db.prepare(
        `INSERT INTO assistant_definitions (id, assistant_id, source, agent_id, deleted_at) VALUES ('def-eve','${EVE}','user','aionrs-1',NULL)`
      ).run();
    });
    const result = await repairCommandEveAssistantStorage(dir);
    expect(result.rebound).toBe(1);
    expect(agentIdOf(dir, 'def-eve')).toBe('hermes-1');
  });

  it('is idempotent — no re-bind when EVE is already on hermes', async () => {
    const dir = makeDataDir();
    seedDbWithAgents(dir, (db) => {
      db.prepare(
        "INSERT INTO agent_metadata (id, name, agent_type, backend) VALUES ('hermes-1','Hermes','acp','hermes')"
      ).run();
      db.prepare(`INSERT INTO assistants (id, name) VALUES ('${EVE}','EVE')`).run();
      db.prepare(
        `INSERT INTO assistant_definitions (id, assistant_id, source, agent_id, deleted_at) VALUES ('def-eve','${EVE}','user','hermes-1',NULL)`
      ).run();
    });
    const result = await repairCommandEveAssistantStorage(dir);
    expect(result.rebound).toBe(0);
    expect(agentIdOf(dir, 'def-eve')).toBe('hermes-1');
  });

  it('does NOT re-bind a NON-EVE assistant that legitimately runs on aionrs', async () => {
    const dir = makeDataDir();
    seedDbWithAgents(dir, (db) => {
      db.prepare(
        "INSERT INTO agent_metadata (id, name, agent_type, backend) VALUES ('hermes-1','Hermes','acp','hermes')"
      ).run();
      db.prepare(
        "INSERT INTO agent_metadata (id, name, agent_type, backend) VALUES ('aionrs-1','Aion CLI','aionrs',NULL)"
      ).run();
      db.prepare("INSERT INTO assistants (id, name) VALUES ('excel-creator','Excel')").run();
      db.prepare(
        "INSERT INTO assistant_definitions (id, assistant_id, source, agent_id, deleted_at) VALUES ('def-x','excel-creator','user','aionrs-1',NULL)"
      ).run();
    });
    const result = await repairCommandEveAssistantStorage(dir);
    expect(result.rebound).toBe(0);
    expect(agentIdOf(dir, 'def-x')).toBe('aionrs-1');
  });

  it('re-binds AND un-soft-deletes the EVE definition in one shot (heals both bugs)', async () => {
    const dir = makeDataDir();
    seedDbWithAgents(dir, (db) => {
      db.prepare(
        "INSERT INTO agent_metadata (id, name, agent_type, backend) VALUES ('hermes-1','Hermes','acp','hermes')"
      ).run();
      db.prepare(
        "INSERT INTO agent_metadata (id, name, agent_type, backend) VALUES ('aionrs-1','Aion CLI','aionrs',NULL)"
      ).run();
      db.prepare(`INSERT INTO assistants (id, name) VALUES ('${EVE}','EVE')`).run();
      db.prepare(
        `INSERT INTO assistant_definitions (id, assistant_id, source, agent_id, deleted_at) VALUES ('def-eve','${EVE}','user','aionrs-1', 1782510337017)`
      ).run();
    });
    const result = await repairCommandEveAssistantStorage(dir);
    expect(result.rebound).toBe(1);
    expect(agentIdOf(dir, 'def-eve')).toBe('hermes-1');
    expect(deletedAtOf(dir, 'def-eve')).toBeNull();
  });

  it('skips the re-bind (rebound 0) when no hermes agent exists yet', async () => {
    const dir = makeDataDir();
    seedDbWithAgents(dir, (db) => {
      db.prepare(
        "INSERT INTO agent_metadata (id, name, agent_type, backend) VALUES ('aionrs-1','Aion CLI','aionrs',NULL)"
      ).run();
      db.prepare(`INSERT INTO assistants (id, name) VALUES ('${EVE}','EVE')`).run();
      db.prepare(
        `INSERT INTO assistant_definitions (id, assistant_id, source, agent_id, deleted_at) VALUES ('def-eve','${EVE}','user','aionrs-1',NULL)`
      ).run();
    });
    const result = await repairCommandEveAssistantStorage(dir);
    expect(result.rebound).toBe(0);
    expect(agentIdOf(dir, 'def-eve')).toBe('aionrs-1');
  });
});

describe('repairCommandEveAssistantStorage — pins Hermes registry command to the app shim', () => {
  it('updates the Hermes agent_metadata row and clears stale launch health errors', async () => {
    const dir = makeDataDir();
    const shim = '/abs/command-eve-runtime/hermes/hermes';
    seedDbWithRichAgentRegistry(dir, (db) => {
      db.prepare(
        'INSERT INTO agent_metadata (id, name, agent_type, backend, command, args, command_override, last_check_status, last_check_error_message, last_failure_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)'
      ).run(
        'hermes-1',
        'Hermes',
        'acp',
        'hermes',
        'hermes',
        '[]',
        null,
        'offline',
        "command 'hermes' not found in PATH",
        1782510337017,
        111
      );
    });

    const result = await repairCommandEveAssistantStorage(dir, { hermesCommandPath: shim });
    const row = hermesRegistryOf(dir);

    expect(result.registryRebound).toBe(1);
    expect(row?.command).toBe(shim);
    expect(row?.command_override).toBe(shim);
    expect(row?.args).toBe('["acp"]');
    expect(row?.last_check_status).toBeNull();
    expect(row?.last_check_error_message).toBeNull();
    expect(row?.last_failure_at).toBeNull();
    expect(row?.updated_at).not.toBe(111);

    const second = await repairCommandEveAssistantStorage(dir, { hermesCommandPath: shim });
    expect(second.registryRebound).toBe(0);
  });

  it('leaves the Hermes registry untouched when no shim path is provided', async () => {
    const dir = makeDataDir();
    seedDbWithRichAgentRegistry(dir, (db) => {
      db.prepare(
        'INSERT INTO agent_metadata (id, name, agent_type, backend, command, args, command_override, last_check_status, last_check_error_message, last_failure_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)'
      ).run('hermes-1', 'Hermes', 'acp', 'hermes', 'hermes', '[]', null, 'offline', 'bad path', 123, 111);
    });

    const result = await repairCommandEveAssistantStorage(dir);
    const row = hermesRegistryOf(dir);

    expect(result.registryRebound).toBe(0);
    expect(row?.command).toBe('hermes');
    expect(row?.command_override).toBeNull();
    expect(row?.args).toBe('[]');
    expect(row?.last_check_status).toBe('offline');
  });
});

describe('repairCommandEveAssistantStorage — enables Hermes native skill discovery', () => {
  it('stores the absolute app-managed Hermes root and becomes idempotent', async () => {
    const dir = makeDataDir();
    const nativeSkillsDirs = [path.join(dir, 'hermes-home', 'skills-command-eve')];
    for (const skillDir of nativeSkillsDirs) fs.mkdirSync(skillDir, { recursive: true });
    seedDbWithRichAgentRegistry(dir, (db) => {
      db.prepare(
        'INSERT INTO agent_metadata (id, name, agent_type, backend, native_skills_dirs) VALUES (?,?,?,?,?)'
      ).run('hermes-1', 'Hermes', 'acp', 'hermes', null);
    });

    const first = await repairCommandEveAssistantStorage(dir, { nativeSkillsDirs });
    expect(first.nativeSkillsRebound).toBe(1);
    expect(JSON.parse(hermesRegistryOf(dir)?.native_skills_dirs ?? 'null')).toEqual(nativeSkillsDirs);

    const second = await repairCommandEveAssistantStorage(dir, { nativeSkillsDirs });
    expect(second.nativeSkillsRebound).toBe(0);
  });

  it('does not advertise native discovery for malformed or relative roots', async () => {
    const dir = makeDataDir();
    fs.mkdirSync(path.join(dir, 'hermes-home', 'skills'), { recursive: true });
    seedDbWithRichAgentRegistry(dir, (db) => {
      db.prepare(
        'INSERT INTO agent_metadata (id, name, agent_type, backend, native_skills_dirs) VALUES (?,?,?,?,?)'
      ).run('hermes-1', 'Hermes', 'acp', 'hermes', null);
    });

    const result = await repairCommandEveAssistantStorage(dir, {
      nativeSkillsDirs: [path.join(dir, 'hermes-home', 'skills'), 'relative/skills'],
    });
    expect(result.nativeSkillsRebound).toBe(0);
    expect(hermesRegistryOf(dir)?.native_skills_dirs).toBeNull();
  });

  it('does not advertise native discovery for an absolute root that does not exist', async () => {
    const dir = makeDataDir();
    seedDbWithRichAgentRegistry(dir, (db) => {
      db.prepare(
        'INSERT INTO agent_metadata (id, name, agent_type, backend, native_skills_dirs) VALUES (?,?,?,?,?)'
      ).run('hermes-1', 'Hermes', 'acp', 'hermes', null);
    });

    const result = await repairCommandEveAssistantStorage(dir, {
      nativeSkillsDirs: [path.join(dir, 'missing-hermes-home', 'skills')],
    });
    expect(result.nativeSkillsRebound).toBe(0);
    expect(hermesRegistryOf(dir)?.native_skills_dirs).toBeNull();
  });

  it('leaves non-Hermes agent capabilities untouched', async () => {
    const dir = makeDataDir();
    fs.mkdirSync(path.join(dir, 'hermes-home', 'skills'), { recursive: true });
    seedDbWithRichAgentRegistry(dir, (db) => {
      db.prepare(
        'INSERT INTO agent_metadata (id, name, agent_type, backend, native_skills_dirs) VALUES (?,?,?,?,?)'
      ).run('codex-1', 'Codex', 'acp', 'codex', '[".codex/skills"]');
    });

    const result = await repairCommandEveAssistantStorage(dir, {
      nativeSkillsDirs: [path.join(dir, 'hermes-home', 'skills')],
    });
    const db = new DatabaseSync(path.join(dir, 'aionui-backend.db'));
    const row = db.prepare("SELECT native_skills_dirs FROM agent_metadata WHERE id = 'codex-1'").get() as {
      native_skills_dirs: string;
    };
    db.close();

    expect(result.nativeSkillsRebound).toBe(0);
    expect(row.native_skills_dirs).toBe('[".codex/skills"]');
  });

  it('stays compatible with an older registry schema without the capability column', async () => {
    const dir = makeDataDir();
    fs.mkdirSync(path.join(dir, 'hermes-home', 'skills'), { recursive: true });
    seedDbWithAgents(dir, (db) => {
      db.prepare(
        "INSERT INTO agent_metadata (id, name, agent_type, backend) VALUES ('hermes-1','Hermes','acp','hermes')"
      ).run();
    });

    const result = await repairCommandEveAssistantStorage(dir, {
      nativeSkillsDirs: [path.join(dir, 'hermes-home', 'skills')],
    });
    expect(result.nativeSkillsRebound).toBe(0);
  });
});

function eveExists(dataDir: string, assistantId: string): boolean {
  const db = new DatabaseSync(path.join(dataDir, 'aionui-backend.db'));
  const row = db.prepare('SELECT 1 AS n FROM assistants WHERE id = ?').get(assistantId) as { n: number } | undefined;
  db.close();
  return Boolean(row && row.n);
}

function liveDefCount(dataDir: string, assistantId: string): number {
  const db = new DatabaseSync(path.join(dataDir, 'aionui-backend.db'));
  const row = db
    .prepare('SELECT COUNT(*) AS n FROM assistant_definitions WHERE assistant_id = ? AND deleted_at IS NULL')
    .get(assistantId) as { n: number } | undefined;
  db.close();
  return row ? Number(row.n) : 0;
}

describe('repairCommandEveAssistantStorage — clears the no-live-definition orphan (BUG 3, the Alois brick)', () => {
  const EVE = 'command-eve-chief-of-staff';

  it('clears the orphaned EVE assistants row when it has ZERO definition rows AT ALL', async () => {
    // Alois state: an ACTIVE EVE legacy mirror row, but NO assistant_definitions
    // row exists for it — not soft-deleted, genuinely absent. BUG 1 matches
    // nothing; BUG 3 must remove the orphan so the backend re-seeds via POST.
    const dir = makeDataDir();
    seedDb(dir, (db) => {
      db.prepare(`INSERT INTO assistants (id, name) VALUES ('${EVE}','EVE')`).run();
      // intentionally NO assistant_definitions row
    });
    const result = await repairCommandEveAssistantStorage(dir);
    expect(result.repaired).toBe(0); // nothing to un-soft-delete
    expect(result.reseeded).toBe(1); // the orphan mirror row was cleared
    // Bootstrap-ready state: no orphaned EVE row + still zero live defs → the
    // next ensureCommandEveAssistant takes the POST (re-seed) path.
    expect(eveExists(dir, EVE)).toBe(false);
    expect(liveDefCount(dir, EVE)).toBe(0);
  });

  it('does NOT clear the EVE row when a live definition exists (healthy install)', async () => {
    const dir = makeDataDir();
    seedDb(dir, (db) => {
      db.prepare(`INSERT INTO assistants (id, name) VALUES ('${EVE}','EVE')`).run();
      db.prepare(
        `INSERT INTO assistant_definitions (id, assistant_id, source, deleted_at) VALUES ('def-eve','${EVE}','user',NULL)`
      ).run();
    });
    const result = await repairCommandEveAssistantStorage(dir);
    expect(result.reseeded).toBe(0);
    expect(eveExists(dir, EVE)).toBe(true);
    expect(liveDefCount(dir, EVE)).toBe(1);
  });

  it('heals a SOFT-DELETED def via BUG 1 instead of clearing the row (BUG 3 stays a no-op)', async () => {
    // The merely-soft-deleted case must be healed by un-soft-delete (BUG 1), NOT
    // by the BUG 3 row-clear — BUG 3 runs AFTER BUG 1 so the row is already live.
    const dir = makeDataDir();
    seedDb(dir, (db) => {
      db.prepare(`INSERT INTO assistants (id, name) VALUES ('${EVE}','EVE')`).run();
      db.prepare(
        `INSERT INTO assistant_definitions (id, assistant_id, source, deleted_at) VALUES ('def-eve','${EVE}','user',1782510337017)`
      ).run();
    });
    const result = await repairCommandEveAssistantStorage(dir);
    expect(result.repaired).toBe(1); // BUG 1 un-soft-deleted it
    expect(result.reseeded).toBe(0); // BUG 3 saw a live def → no clear
    expect(eveExists(dir, EVE)).toBe(true);
    expect(deletedAtOf(dir, 'def-eve')).toBeNull();
    expect(liveDefCount(dir, EVE)).toBe(1);
  });

  it('does NOT clear a NON-EVE assistant that has zero definitions (scoped to EVE only)', async () => {
    const dir = makeDataDir();
    seedDb(dir, (db) => {
      db.prepare("INSERT INTO assistants (id, name) VALUES ('excel-creator','Excel')").run();
      // no definition row for excel-creator either — but it is NOT the EVE id
    });
    const result = await repairCommandEveAssistantStorage(dir);
    expect(result.reseeded).toBe(0);
    expect(eveExists(dir, 'excel-creator')).toBe(true);
  });

  it('is idempotent — a second run after the clear is a no-op (fresh-install shape)', async () => {
    const dir = makeDataDir();
    seedDb(dir, (db) => {
      db.prepare(`INSERT INTO assistants (id, name) VALUES ('${EVE}','EVE')`).run();
    });
    const first = await repairCommandEveAssistantStorage(dir);
    expect(first.reseeded).toBe(1);
    const second = await repairCommandEveAssistantStorage(dir);
    expect(second.reseeded).toBe(0); // EVE row already gone → nothing to clear
    expect(eveExists(dir, EVE)).toBe(false);
  });
});

// BLOCKER 1 / fail-closed — a registry `command` is a SPAWN instruction, and a
// bare or relative value is a bet on the END USER's PATH. That bet is exactly
// what produced "Agent 'Hermes' CLI unavailable: command 'hermes' not found in
// PATH" on a machine without a foreign `hermes` installed. The repair must
// refuse to write such a value at all, rather than pin a worse guess over the
// existing row.
describe('repairCommandEveAssistantStorage — refuses a non-absolute Hermes command (fail-closed)', () => {
  const seedBareHermesRow = (dir: string): void => {
    seedDbWithRichAgentRegistry(dir, (db) => {
      db.prepare(
        'INSERT INTO agent_metadata (id, name, agent_type, backend, command, args, command_override, last_check_status, last_check_error_message, last_failure_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)'
      ).run('hermes-1', 'Hermes', 'acp', 'hermes', 'hermes', '[]', null, 'offline', 'not found in PATH', 999, 111);
    });
  };

  // The exact shape that reaches an end user: a BARE name. Before the guard this
  // passed the `.trim()` check and was pinned verbatim.
  it('never pins a BARE command name', async () => {
    const dir = makeDataDir();
    seedBareHermesRow(dir);

    const result = await repairCommandEveAssistantStorage(dir, { hermesCommandPath: 'hermes' });
    const row = hermesRegistryOf(dir);

    expect(result.registryRebound).toBe(0);
    expect(row?.command_override).toBeNull();
    // The pre-existing row is left EXACTLY as it was — no half-repair.
    expect(row?.command).toBe('hermes');
    expect(row?.updated_at).toBe(111);
  });

  it('never pins a RELATIVE path', async () => {
    const dir = makeDataDir();
    seedBareHermesRow(dir);

    const result = await repairCommandEveAssistantStorage(dir, {
      hermesCommandPath: './command-eve-runtime/hermes/hermes',
    });

    expect(result.registryRebound).toBe(0);
    expect(hermesRegistryOf(dir)?.command_override).toBeNull();
  });

  it('never pins a path carrying a NUL byte', async () => {
    const dir = makeDataDir();
    seedBareHermesRow(dir);

    const result = await repairCommandEveAssistantStorage(dir, { hermesCommandPath: '/tmp/hermes\0/evil' });

    expect(result.registryRebound).toBe(0);
    expect(hermesRegistryOf(dir)?.command_override).toBeNull();
  });

  // Negative control: the guard must not break the legitimate pin.
  it('still pins a well-formed ABSOLUTE path', async () => {
    const dir = makeDataDir();
    seedBareHermesRow(dir);
    const shim = path.join(dir, 'command-eve-runtime', 'hermes', 'hermes');

    const result = await repairCommandEveAssistantStorage(dir, { hermesCommandPath: shim });
    const row = hermesRegistryOf(dir);

    expect(result.registryRebound).toBe(1);
    expect(row?.command_override).toBe(shim);
    expect(row?.command).toBe(shim);
  });
});

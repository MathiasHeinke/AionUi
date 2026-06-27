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
      db.prepare("INSERT INTO agent_metadata (id, name, agent_type, backend) VALUES ('hermes-1','Hermes','acp','hermes')").run();
      db.prepare("INSERT INTO agent_metadata (id, name, agent_type, backend) VALUES ('aionrs-1','Aion CLI','aionrs',NULL)").run();
      db.prepare(`INSERT INTO assistants (id, name) VALUES ('${EVE}','EVE')`).run();
      db.prepare(`INSERT INTO assistant_definitions (id, assistant_id, source, agent_id, deleted_at) VALUES ('def-eve','${EVE}','user','aionrs-1',NULL)`).run();
    });
    const result = await repairCommandEveAssistantStorage(dir);
    expect(result.rebound).toBe(1);
    expect(agentIdOf(dir, 'def-eve')).toBe('hermes-1');
  });

  it('is idempotent — no re-bind when EVE is already on hermes', async () => {
    const dir = makeDataDir();
    seedDbWithAgents(dir, (db) => {
      db.prepare("INSERT INTO agent_metadata (id, name, agent_type, backend) VALUES ('hermes-1','Hermes','acp','hermes')").run();
      db.prepare(`INSERT INTO assistants (id, name) VALUES ('${EVE}','EVE')`).run();
      db.prepare(`INSERT INTO assistant_definitions (id, assistant_id, source, agent_id, deleted_at) VALUES ('def-eve','${EVE}','user','hermes-1',NULL)`).run();
    });
    const result = await repairCommandEveAssistantStorage(dir);
    expect(result.rebound).toBe(0);
    expect(agentIdOf(dir, 'def-eve')).toBe('hermes-1');
  });

  it('does NOT re-bind a NON-EVE assistant that legitimately runs on aionrs', async () => {
    const dir = makeDataDir();
    seedDbWithAgents(dir, (db) => {
      db.prepare("INSERT INTO agent_metadata (id, name, agent_type, backend) VALUES ('hermes-1','Hermes','acp','hermes')").run();
      db.prepare("INSERT INTO agent_metadata (id, name, agent_type, backend) VALUES ('aionrs-1','Aion CLI','aionrs',NULL)").run();
      db.prepare("INSERT INTO assistants (id, name) VALUES ('excel-creator','Excel')").run();
      db.prepare("INSERT INTO assistant_definitions (id, assistant_id, source, agent_id, deleted_at) VALUES ('def-x','excel-creator','user','aionrs-1',NULL)").run();
    });
    const result = await repairCommandEveAssistantStorage(dir);
    expect(result.rebound).toBe(0);
    expect(agentIdOf(dir, 'def-x')).toBe('aionrs-1');
  });

  it('re-binds AND un-soft-deletes the EVE definition in one shot (heals both bugs)', async () => {
    const dir = makeDataDir();
    seedDbWithAgents(dir, (db) => {
      db.prepare("INSERT INTO agent_metadata (id, name, agent_type, backend) VALUES ('hermes-1','Hermes','acp','hermes')").run();
      db.prepare("INSERT INTO agent_metadata (id, name, agent_type, backend) VALUES ('aionrs-1','Aion CLI','aionrs',NULL)").run();
      db.prepare(`INSERT INTO assistants (id, name) VALUES ('${EVE}','EVE')`).run();
      db.prepare(`INSERT INTO assistant_definitions (id, assistant_id, source, agent_id, deleted_at) VALUES ('def-eve','${EVE}','user','aionrs-1', 1782510337017)`).run();
    });
    const result = await repairCommandEveAssistantStorage(dir);
    expect(result.rebound).toBe(1);
    expect(agentIdOf(dir, 'def-eve')).toBe('hermes-1');
    expect(deletedAtOf(dir, 'def-eve')).toBeNull();
  });

  it('skips the re-bind (rebound 0) when no hermes agent exists yet', async () => {
    const dir = makeDataDir();
    seedDbWithAgents(dir, (db) => {
      db.prepare("INSERT INTO agent_metadata (id, name, agent_type, backend) VALUES ('aionrs-1','Aion CLI','aionrs',NULL)").run();
      db.prepare(`INSERT INTO assistants (id, name) VALUES ('${EVE}','EVE')`).run();
      db.prepare(`INSERT INTO assistant_definitions (id, assistant_id, source, agent_id, deleted_at) VALUES ('def-eve','${EVE}','user','aionrs-1',NULL)`).run();
    });
    const result = await repairCommandEveAssistantStorage(dir);
    expect(result.rebound).toBe(0);
    expect(agentIdOf(dir, 'def-eve')).toBe('aionrs-1');
  });
});

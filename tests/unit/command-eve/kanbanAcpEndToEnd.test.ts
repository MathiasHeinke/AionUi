/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * COMPA-626 K12 — the real end-to-end: the actual kanbanAcpMain handlers (propose → peek
 * → apply) run against a REAL marketing kanban.db in a temp seat home. Proves that a
 * proposal writes NOTHING until confirm (K1/K2), that confirm dispatches to the real
 * createKanbanMarketingCard and lands a card in the DB (K12), and that a receipt is
 * written (K13). No Electron / no LLM — the main-process seam exercised against real IO.
 */

import { execFileSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const tempRoots: string[] = [];
let ROOT = '';

// getDataPath drives every seat-home resolution in the handlers → point it at the temp.
vi.mock('@process/utils/utils', async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return { ...actual, getDataPath: () => ROOT };
});

// Imported AFTER the mock so the handlers capture the mocked getDataPath.
import { __resetActiveSeatForTests, getActiveSeatKind, setActiveSeatKind } from '@/process/commandEve/seatContextCore';
import { applyKanbanAcpIntent, kanbanAcpProposeHandler, peekKanbanAcpForRenderer, readKanbanAcpBoard } from '@/process/commandEve/kanbanAcpMain';
import { __resetKanbanAcpForTest } from '@/process/commandEve/kanbanAcpConfirmStore';

const marketingBoardPath = (root: string): string => path.join(root, 'command-eve-runtime', 'hermes', 'home', 'kanban', 'boards', 'marketing', 'kanban.db');

const writeJson = (filePath: string, value: unknown): void => {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`);
};

const writeLockedReconciliation = (root: string): void => {
  writeJson(path.join(root, 'command-eve-runtime', 'capabilities', 'command-eve-runtime-reconciliation.json'), {
    version: 'command-eve-runtime-reconciliation/v0',
    hermes_config: { mcp_servers: [], kanban_dispatch_in_gateway: false, kanban_auto_decompose: false },
  });
};

const createNativeKanbanDb = (dbPath: string): void => {
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  execFileSync(
    'python3',
    [
      '-c',
      `
import sqlite3, sys
conn = sqlite3.connect(sys.argv[1])
try:
    conn.executescript("""
      CREATE TABLE tasks (
        id TEXT PRIMARY KEY, title TEXT NOT NULL, body TEXT, assignee TEXT, status TEXT NOT NULL,
        priority INTEGER DEFAULT 0, created_by TEXT, created_at INTEGER NOT NULL, started_at INTEGER,
        completed_at INTEGER, workspace_kind TEXT NOT NULL DEFAULT 'scratch', workspace_path TEXT,
        branch_name TEXT, claim_lock TEXT, claim_expires INTEGER, tenant TEXT, result TEXT,
        idempotency_key TEXT, consecutive_failures INTEGER NOT NULL DEFAULT 0, worker_pid INTEGER,
        last_failure_error TEXT, max_runtime_seconds INTEGER, last_heartbeat_at INTEGER, current_run_id INTEGER,
        workflow_template_id TEXT, current_step_key TEXT, skills TEXT, model_override TEXT, max_retries INTEGER,
        goal_mode INTEGER NOT NULL DEFAULT 0, goal_max_turns INTEGER, session_id TEXT
      );
      CREATE TABLE task_events ( id INTEGER PRIMARY KEY AUTOINCREMENT, task_id TEXT NOT NULL, run_id INTEGER, kind TEXT NOT NULL, payload TEXT, created_at INTEGER NOT NULL );
      CREATE TABLE task_comments ( id INTEGER PRIMARY KEY AUTOINCREMENT, task_id TEXT NOT NULL, author TEXT NOT NULL, body TEXT NOT NULL, created_at INTEGER NOT NULL );
      CREATE TABLE task_links ( parent_id TEXT NOT NULL, child_id TEXT NOT NULL, PRIMARY KEY (parent_id, child_id) );
    """)
    conn.commit()
finally:
    conn.close()
`,
      dbPath,
    ],
    { encoding: 'utf8' }
  );
};

beforeEach(() => {
  ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'command-eve-kanban-acp-e2e-'));
  tempRoots.push(ROOT);
  writeLockedReconciliation(ROOT);
  createNativeKanbanDb(marketingBoardPath(ROOT));
  __resetActiveSeatForTests();
  setActiveSeatKind('own_company'); // an OPERATOR seat — the surface is operator-only
  __resetKanbanAcpForTest();
});
afterEach(() => {
  for (const r of tempRoots) fs.rmSync(r, { recursive: true, force: true });
  tempRoots.length = 0;
  vi.clearAllMocks();
});

describe('COMPA-626 K12 — real propose → confirm → kanban.db write', () => {
  it('the reset seat is an operator seat (not client), so the surface is reachable', () => {
    expect(getActiveSeatKind()).not.toBe('client');
  });

  it('propose writes NOTHING; only the confirmed apply lands a real card + a receipt', async () => {
    // The board starts empty.
    const board0 = readKanbanAcpBoard();
    expect(board0.ok).toBe(true);
    expect(board0.cards.length).toBe(0);

    // Propose a create — 202 + intent_id, and NO card written yet (K1).
    const res = await kanbanAcpProposeHandler({ op: 'create', title: 'K12 Launchpage', reason: 'e2e beweis' });
    expect(res.status).toBe(202);
    const intentId = (res.payload as { intent_id?: string }).intent_id as string;
    expect(intentId).toBeTruthy();
    expect(readKanbanAcpBoard().cards.length).toBe(0); // still nothing (propose = no write)

    // The renderer peek carries the mutation_hash the confirm must present (K5/K11).
    const pending = peekKanbanAcpForRenderer();
    expect(pending?.intent_id).toBe(intentId);

    // A tampered confirm (wrong hash) is refused — no write (K5).
    const tampered = await applyKanbanAcpIntent(intentId, 'k_wronghash');
    expect(tampered.ok).toBe(false);
    expect(readKanbanAcpBoard().cards.length).toBe(0);

    // Re-propose (the tampered attempt consumed nothing? consume removes on hash-mismatch=refuse, intent stays) —
    // the real confirm with the right hash lands the card (K2/K12).
    const live = peekKanbanAcpForRenderer();
    expect(live?.intent_id).toBe(intentId);
    const applied = await applyKanbanAcpIntent(intentId, live!.mutation_hash);
    expect(applied.ok).toBe(true);

    // The REAL kanban.db now has the card (K12).
    const board2 = readKanbanAcpBoard();
    expect(board2.cards.some((c) => c.title === 'K12 Launchpage')).toBe(true);

    // A receipt was written (K13) and records the apply.
    const receipt = path.join(ROOT, 'eve-kanban-acp', 'receipts.jsonl');
    expect(fs.existsSync(receipt)).toBe(true);
    expect(fs.readFileSync(receipt, 'utf8')).toContain('"event":"applied"');
  });
});

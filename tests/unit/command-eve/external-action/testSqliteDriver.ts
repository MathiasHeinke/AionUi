import { DatabaseSync } from 'node:sqlite';

import type { ISqliteDriver, IStatement } from '@/process/services/database/drivers/ISqliteDriver';

class NodeSqliteStatement implements IStatement {
  constructor(private readonly statement: ReturnType<DatabaseSync['prepare']>) {}

  get(...args: unknown[]): unknown {
    return this.statement.get(...args);
  }

  all(...args: unknown[]): unknown[] {
    return this.statement.all(...args) as unknown[];
  }

  run(...args: unknown[]): { changes: number; lastInsertRowid: number | bigint } {
    return this.statement.run(...args);
  }
}

export class NodeSqliteDriver implements ISqliteDriver {
  private readonly database: DatabaseSync;

  constructor(databasePath: string) {
    this.database = new DatabaseSync(databasePath);
  }

  prepare(sql: string): IStatement {
    return new NodeSqliteStatement(this.database.prepare(sql));
  }

  exec(sql: string): void {
    this.database.exec(sql);
  }

  pragma(sql: string, options?: { simple?: boolean }): unknown {
    const row = this.database.prepare(`PRAGMA ${sql}`).get();
    if (options?.simple && row && typeof row === 'object') return Object.values(row)[0];
    return row;
  }

  transaction<T>(fn: (...args: unknown[]) => T): (...args: unknown[]) => T {
    return (...args: unknown[]): T => {
      this.database.exec('BEGIN IMMEDIATE');
      try {
        const result = fn(...args);
        this.database.exec('COMMIT');
        return result;
      } catch (error) {
        this.database.exec('ROLLBACK');
        throw error;
      }
    };
  }

  close(): void {
    this.database.close();
  }
}

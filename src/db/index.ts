import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { config } from '../config.js';
import { logger } from '../util/logger.js';
import { MIGRATIONS } from './migrations.js';

export type Row = Record<string, unknown>;

let db: DatabaseSync | null = null;

/**
 * `node:sqlite` returns null-prototype rows, which break `instanceof`-ish checks
 * and spread-into-class patterns downstream. Normalising here keeps every caller
 * dealing with ordinary objects.
 */
function plain<T extends object>(row: unknown): T | undefined {
  return row == null ? undefined : ({ ...(row as Row) } as T);
}

export function getDb(): DatabaseSync {
  if (!db) throw new Error('Database not initialised — call initDb() first.');
  return db;
}

export function initDb(dbPath: string = config.dbPath): DatabaseSync {
  if (db) return db;

  if (dbPath !== ':memory:') {
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  }

  db = new DatabaseSync(dbPath);
  // WAL keeps readers (the web UI) from blocking the bot's writes.
  if (dbPath !== ':memory:') db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA foreign_keys = ON');
  db.exec('PRAGMA busy_timeout = 5000');

  runMigrations(db);
  return db;
}

/** Test helper: a throwaway in-memory database with the full schema applied. */
export function initTestDb(): DatabaseSync {
  db = null;
  return initDb(':memory:');
}

export function closeDb(): void {
  db?.close();
  db = null;
}

function runMigrations(database: DatabaseSync): void {
  database.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      id INTEGER PRIMARY KEY,
      name TEXT NOT NULL,
      applied_at TEXT NOT NULL
    )
  `);

  const applied = new Set(
    database
      .prepare('SELECT id FROM schema_migrations')
      .all()
      .map((r) => Number((r as Row).id)),
  );

  for (const migration of MIGRATIONS) {
    if (applied.has(migration.id)) continue;
    database.exec('BEGIN');
    try {
      database.exec(migration.up);
      database
        .prepare('INSERT INTO schema_migrations (id, name, applied_at) VALUES (?, ?, ?)')
        .run(migration.id, migration.name, new Date().toISOString());
      database.exec('COMMIT');
      logger.info({ migration: migration.name }, 'applied migration');
    } catch (err) {
      database.exec('ROLLBACK');
      throw new Error(`Migration ${migration.id} (${migration.name}) failed: ${String(err)}`);
    }
  }
}

/* ------------------------------------------------------------------ */
/* Small query helpers                                                 */
/* ------------------------------------------------------------------ */

type Param = string | number | bigint | null | Uint8Array;

export function one<T extends object>(sql: string, ...params: Param[]): T | undefined {
  return plain<T>(getDb().prepare(sql).get(...params));
}

export function many<T extends object>(sql: string, ...params: Param[]): T[] {
  return getDb()
    .prepare(sql)
    .all(...params)
    .map((r) => plain<T>(r)!);
}

export function run(sql: string, ...params: Param[]): { changes: number; lastInsertRowid: number } {
  const res = getDb()
    .prepare(sql)
    .run(...params);
  return { changes: Number(res.changes), lastInsertRowid: Number(res.lastInsertRowid) };
}

/**
 * Runs `fn` inside a transaction. Nested calls join the outer transaction
 * rather than failing on SQLite's lack of nested BEGIN.
 */
let txDepth = 0;
export function transaction<T>(fn: () => T): T {
  const database = getDb();
  if (txDepth > 0) return fn();

  txDepth++;
  database.exec('BEGIN');
  try {
    const result = fn();
    database.exec('COMMIT');
    return result;
  } catch (err) {
    database.exec('ROLLBACK');
    throw err;
  } finally {
    txDepth--;
  }
}

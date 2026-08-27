import fs from 'node:fs';
import { DateTime } from 'luxon';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import {
  backupDir,
  createBackup,
  listBackups,
  pruneBackups,
  runDailyBackup,
} from '../src/domain/backup.js';
import { joinBooking } from '../src/domain/bookings.js';
import { settleBooking } from '../src/domain/ledger.js';
import { booking, freshDb, user } from './helpers.js';

function clearBackups(): void {
  fs.rmSync(backupDir(), { recursive: true, force: true });
}

beforeEach(() => {
  freshDb();
  clearBackups();
});

afterEach(() => clearBackups());

describe('database backups', () => {
  it('writes a snapshot that is a readable database with the real data in it', () => {
    const alice = user('Alice');
    const bob = user('Bob');
    const b = booking(alice, { totalCostCents: 2000, minPlayers: 2, maxPlayers: 2 });
    joinBooking(b.code, bob);
    settleBooking(b.id);

    const file = createBackup();
    expect(file).not.toBeNull();
    expect(fs.existsSync(file!.path)).toBe(true);
    expect(file!.sizeBytes).toBeGreaterThan(0);

    // The point of a backup is that it can be opened and still holds the ledger.
    const restored = new DatabaseSync(file!.path);
    try {
      const bookings = restored.prepare('SELECT code FROM bookings').all() as { code: string }[];
      expect(bookings.map((r) => r.code)).toEqual([b.code]);

      const charges = restored
        .prepare(`SELECT amount_cents FROM ledger_entries WHERE kind = 'CHARGE'`)
        .all() as { amount_cents: number }[];
      expect(charges).toEqual([{ amount_cents: 1000 }]);
    } finally {
      restored.close();
    }
  });

  it('takes at most one snapshot per day', () => {
    const today = DateTime.utc();

    expect(runDailyBackup(14, today).status).toBe('created');
    expect(runDailyBackup(14, today).status).toBe('skipped');
    expect(listBackups()).toHaveLength(1);
  });

  it('takes a fresh snapshot once the day rolls over', () => {
    const day1 = DateTime.fromISO('2026-08-20T10:00:00Z', { zone: 'utc' });
    const day2 = day1.plus({ days: 1 });

    expect(runDailyBackup(14, day1).status).toBe('created');
    expect(runDailyBackup(14, day2).status).toBe('created');
    expect(listBackups()).toHaveLength(2);
  });

  it('keeps only the newest snapshots', () => {
    const start = DateTime.fromISO('2026-08-01T10:00:00Z', { zone: 'utc' });
    for (let i = 0; i < 10; i++) createBackup(start.plus({ days: i }));
    expect(listBackups()).toHaveLength(10);

    expect(pruneBackups(3)).toBe(7);

    const remaining = listBackups().map((f) => f.name);
    expect(remaining).toHaveLength(3);
    // Newest first, and the oldest ones are the ones that went.
    expect(remaining[0]).toContain('2026-08-10');
    expect(remaining).not.toContain('justplayit-2026-08-01.db');
  });

  it('prunes as part of the daily run', () => {
    const start = DateTime.fromISO('2026-08-01T10:00:00Z', { zone: 'utc' });
    for (let i = 0; i < 5; i++) runDailyBackup(2, start.plus({ days: i }));
    expect(listBackups()).toHaveLength(2);
  });

  it('reports an empty list rather than failing when nothing has been backed up', () => {
    expect(listBackups()).toEqual([]);
    expect(pruneBackups(5)).toBe(0);
  });
});

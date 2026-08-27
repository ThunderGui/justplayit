import fs from 'node:fs';
import path from 'node:path';
import { DateTime } from 'luxon';
import { config } from '../config.js';
import { getDb } from '../db/index.js';
import { logger } from '../util/logger.js';

/**
 * The database is the only irreplaceable state this bot holds: every booking,
 * every debt, every payment. The WhatsApp credentials in `wa-auth/` are
 * deliberately NOT backed up — re-linking the device is a thirty-second QR
 * scan, whereas a lost ledger cannot be reconstructed, and copying live
 * session credentials into dated files on the same disk is a liability rather
 * than a safety net.
 */

export interface BackupFile {
  name: string;
  path: string;
  sizeBytes: number;
  createdAt: string;
}

export function backupDir(): string {
  return path.join(config.dataDir, 'backups');
}

function stampFor(date: DateTime): string {
  return date.toUTC().toFormat('yyyy-LL-dd');
}

/**
 * Takes a consistent snapshot with `VACUUM INTO`, which reads through the WAL
 * and writes a single defragmented file. Unlike copying the .db by hand this is
 * atomic and safe while the bot is mid-write.
 */
export function createBackup(at: DateTime = DateTime.utc()): BackupFile | null {
  const dir = backupDir();
  fs.mkdirSync(dir, { recursive: true });

  const name = `justplayit-${stampFor(at)}.db`;
  const target = path.join(dir, name);

  // VACUUM INTO refuses to overwrite, so a same-day rerun replaces the file.
  if (fs.existsSync(target)) fs.rmSync(target);

  try {
    // The path is ours, but escape quotes anyway rather than trusting that.
    getDb().exec(`VACUUM INTO '${target.replace(/'/g, "''")}'`);
  } catch (err) {
    logger.error({ err }, 'backup failed');
    return null;
  }

  const stat = fs.statSync(target);
  logger.info({ name, sizeBytes: stat.size }, 'database backup written');

  return {
    name,
    path: target,
    sizeBytes: stat.size,
    createdAt: at.toUTC().toISO()!,
  };
}

export function listBackups(): BackupFile[] {
  const dir = backupDir();
  if (!fs.existsSync(dir)) return [];

  return fs
    .readdirSync(dir)
    .filter((name) => name.startsWith('justplayit-') && name.endsWith('.db'))
    .map((name) => {
      const full = path.join(dir, name);
      const stat = fs.statSync(full);
      return {
        name,
        path: full,
        sizeBytes: stat.size,
        createdAt: stat.mtime.toISOString(),
      };
    })
    .sort((a, b) => b.name.localeCompare(a.name));
}

/** Keeps the newest `keep` snapshots and deletes the rest. */
export function pruneBackups(keep: number): number {
  const stale = listBackups().slice(Math.max(keep, 1));
  for (const file of stale) {
    try {
      fs.rmSync(file.path);
    } catch (err) {
      logger.error({ err, name: file.name }, 'could not remove old backup');
    }
  }
  if (stale.length > 0) logger.info({ removed: stale.length }, 'pruned old backups');
  return stale.length;
}

export type BackupOutcome =
  | { status: 'created'; file: BackupFile }
  | { status: 'skipped' }
  | { status: 'failed' };

/**
 * Runs at most one snapshot per calendar day. Driven from the scheduler scan
 * rather than a timer, so a bot that was switched off overnight still takes
 * today's backup the moment it comes back up.
 */
export function runDailyBackup(keep: number, at: DateTime = DateTime.utc()): BackupOutcome {
  // In-memory databases exist only for tests; there is nothing to preserve.
  if (config.dbPath === ':memory:') return { status: 'skipped' };

  const todaysName = `justplayit-${stampFor(at)}.db`;
  if (listBackups().some((file) => file.name === todaysName)) return { status: 'skipped' };

  const file = createBackup(at);
  if (!file) return { status: 'failed' };

  pruneBackups(keep);
  return { status: 'created', file };
}

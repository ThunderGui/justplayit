import { DateTime } from 'luxon';
import { one, run } from '../db/index.js';
import { nowIso } from '../util/datetime.js';

/**
 * A question the bot has asked one user and is waiting on. Used for the
 * second confirmation the design requires before a late cancellation, and for
 * the GDPR erasure confirmation.
 */
export type PendingKind = 'LATE_LEAVE' | 'FORGET_ME';

export interface PendingAction<T = unknown> {
  id: number;
  user_id: number;
  chat_id: string;
  kind: PendingKind;
  payload: T;
  expires_at: string;
  created_at: string;
}

interface PendingRow {
  id: number;
  user_id: number;
  chat_id: string;
  kind: PendingKind;
  payload: string;
  expires_at: string;
  created_at: string;
}

const DEFAULT_TTL_MINUTES = 10;

/**
 * Only one question is outstanding per user and chat at a time — a new one
 * replaces the old, so a forgotten prompt can never be answered by an
 * unrelated "yes" ten minutes later.
 */
export function setPending(
  userId: number,
  chatId: string,
  kind: PendingKind,
  payload: unknown,
  ttlMinutes = DEFAULT_TTL_MINUTES,
): void {
  run('DELETE FROM pending_actions WHERE user_id = ? AND chat_id = ?', userId, chatId);
  run(
    `INSERT INTO pending_actions (user_id, chat_id, kind, payload, expires_at, created_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
    userId,
    chatId,
    kind,
    JSON.stringify(payload ?? {}),
    DateTime.utc().plus({ minutes: ttlMinutes }).toISO()!,
    nowIso(),
  );
}

export function takePending<T = unknown>(
  userId: number,
  chatId: string,
): PendingAction<T> | undefined {
  const row = one<PendingRow>(
    'SELECT * FROM pending_actions WHERE user_id = ? AND chat_id = ?',
    userId,
    chatId,
  );
  if (!row) return undefined;

  // Consume it either way: an expired prompt must not linger.
  run('DELETE FROM pending_actions WHERE id = ?', row.id);
  if (row.expires_at < nowIso()) return undefined;

  return { ...row, payload: JSON.parse(row.payload) as T };
}

export function clearPending(userId: number, chatId: string): void {
  run('DELETE FROM pending_actions WHERE user_id = ? AND chat_id = ?', userId, chatId);
}

export function purgeExpiredPending(): number {
  return run('DELETE FROM pending_actions WHERE expires_at < ?', nowIso()).changes;
}

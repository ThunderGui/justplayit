import { DateTime } from 'luxon';
import { many, one, run } from '../db/index.js';
import { nowIso } from '../util/datetime.js';
import { balanceFor } from './ledger.js';
import { findUserById } from './users.js';

/**
 * How long a debtor is left alone after being reminded by the same person.
 * The point of the bot is to take the awkwardness of chasing people off the
 * organiser; an unlimited nudge button would just automate the awkwardness
 * instead of removing it.
 */
export const REMINDER_COOLDOWN_HOURS = 24;

export interface ReminderTarget {
  userId: number;
  /** Positive: what this person owes the creditor, netted. */
  cents: number;
  /** When they were last reminded by this creditor, if ever. */
  lastRemindedAt?: string;
}

export interface PendingReminders {
  /** Debtors who can be reminded right now. */
  due: ReminderTarget[];
  /** Debtors skipped because they were reminded recently. */
  onCooldown: ReminderTarget[];
}

function lastReminderAt(creditorId: number, debtorId: number): string | undefined {
  return one<{ sent_at: string }>(
    `SELECT sent_at FROM payment_reminders
      WHERE from_user_id = ? AND to_user_id = ?
      ORDER BY sent_at DESC LIMIT 1`,
    creditorId,
    debtorId,
  )?.sent_at;
}

/**
 * Everyone who owes `creditorId` money, split into those it is fair to nudge
 * now and those who were nudged too recently.
 *
 * @param onlyUserId restrict to a single debtor, when the creditor named one.
 */
export function pendingReminders(creditorId: number, onlyUserId?: number): PendingReminders {
  const cutoff = DateTime.utc().minus({ hours: REMINDER_COOLDOWN_HOURS }).toISO()!;

  const due: ReminderTarget[] = [];
  const onCooldown: ReminderTarget[] = [];

  for (const entry of balanceFor(creditorId)) {
    // balanceFor is from the creditor's perspective: negative means the other
    // person owes them.
    if (entry.cents >= 0) continue;
    if (onlyUserId != null && entry.otherUserId !== onlyUserId) continue;

    const debtor = findUserById(entry.otherUserId);
    // An erased user has no number left to message.
    if (!debtor || debtor.anonymised_at) continue;

    const lastRemindedAt = lastReminderAt(creditorId, entry.otherUserId);
    const target: ReminderTarget = {
      userId: entry.otherUserId,
      cents: -entry.cents,
      ...(lastRemindedAt ? { lastRemindedAt } : {}),
    };

    if (lastRemindedAt && lastRemindedAt > cutoff) onCooldown.push(target);
    else due.push(target);
  }

  const biggestFirst = (a: ReminderTarget, b: ReminderTarget) => b.cents - a.cents;
  due.sort(biggestFirst);
  onCooldown.sort(biggestFirst);

  return { due, onCooldown };
}

export function recordReminder(creditorId: number, debtorId: number, cents: number): void {
  run(
    `INSERT INTO payment_reminders (from_user_id, to_user_id, amount_cents, sent_at)
     VALUES (?, ?, ?, ?)`,
    creditorId,
    debtorId,
    cents,
    nowIso(),
  );
}

/** Reminder history, newest first. Used by the admin console. */
export function listReminders(limit = 100): {
  from_user_id: number;
  to_user_id: number;
  amount_cents: number;
  sent_at: string;
}[] {
  return many(
    `SELECT from_user_id, to_user_id, amount_cents, sent_at
       FROM payment_reminders ORDER BY sent_at DESC LIMIT ?`,
    limit,
  );
}

/** Hours a debtor still has to wait before the same person may nudge again. */
export function cooldownRemainingHours(lastRemindedAt: string): number {
  const elapsed = DateTime.utc().diff(DateTime.fromISO(lastRemindedAt, { zone: 'utc' }), 'hours')
    .hours;
  return Math.max(0, Math.ceil(REMINDER_COOLDOWN_HOURS - elapsed));
}

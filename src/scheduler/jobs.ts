import { DateTime } from 'luxon';
import { many, one, run } from '../db/index.js';
import { settlementMessages, type OutgoingMessage } from '../bot/commands.js';
import {
  endsAt,
  findBookingById,
  getRoster,
  listUpcoming,
  type Booking,
} from '../domain/bookings.js';
import { balanceFor, settleBooking } from '../domain/ledger.js';
import { purgeExpiredPending } from '../domain/pending.js';
import { getSettings } from '../domain/settings.js';
import { displayName, findUserById } from '../domain/users.js';
import { t } from '../i18n/index.js';
import { nowIso } from '../util/datetime.js';
import { logger } from '../util/logger.js';
import { formatMoney } from '../util/money.js';

/** How long after the final whistle to wait before splitting the cost. */
const SETTLE_GRACE_HOURS = 3;

export interface Notifier {
  sendToGroup(text: string, mentionUserIds?: number[]): Promise<void>;
  sendToUser(userId: number, text: string): Promise<void>;
}

/** Marks a one-off job as done so reminders never fire twice. */
function claimJob(kind: string, bookingId: number | null): boolean {
  const existing = one(
    'SELECT 1 AS x FROM scheduled_jobs WHERE kind = ? AND booking_id IS ?',
    kind,
    bookingId,
  );
  if (existing) return false;

  run(
    `INSERT INTO scheduled_jobs (kind, booking_id, due_at, done_at, created_at)
     VALUES (?, ?, ?, ?, ?)`,
    kind,
    bookingId,
    nowIso(),
    nowIso(),
    nowIso(),
  );
  return true;
}

/**
 * Splits the cost of any game that finished more than a few hours ago.
 * Running from a scan rather than a timer means a restart never loses a
 * settlement that was due while the bot was down.
 */
export async function runAutoSettlement(notifier: Notifier): Promise<number> {
  const settings = getSettings();
  const dict = t(settings.language);
  const cutoff = DateTime.utc().minus({ hours: SETTLE_GRACE_HOURS }).toISO()!;

  const due = many<Booking>(
    `SELECT * FROM bookings
      WHERE status = 'OPEN' AND kind = 'MANAGED'
        AND datetime(starts_at, '+' || duration_min || ' minutes') < datetime(?)
      ORDER BY starts_at`,
    cutoff,
  );

  let settled = 0;

  for (const booking of due) {
    const result = settleBooking(booking.id);
    if (!result.ok) {
      // Nobody played: close it out quietly rather than retrying forever.
      if (result.reason === 'no_players') {
        run(`UPDATE bookings SET status = 'SETTLED', settled_at = ? WHERE id = ?`, nowIso(), booking.id);
      }
      continue;
    }

    for (const message of settlementMessages(result.booking, result.lines, dict, settings)) {
      await deliver(notifier, message);
    }
    settled++;
    logger.info({ code: booking.code }, 'auto-settled booking');
  }

  return settled;
}

/** Nudges the group about a game that is close and still short of players. */
export async function runFillReminders(notifier: Notifier): Promise<number> {
  const settings = getSettings();
  if (settings.reminderHoursBefore <= 0) return 0;

  const dict = t(settings.language);
  const horizon = DateTime.utc().plus({ hours: settings.reminderHoursBefore }).toISO()!;
  let sent = 0;

  for (const booking of listUpcoming(50)) {
    if (booking.kind === 'EXTERNAL') continue;
    if (booking.starts_at > horizon) continue;

    const roster = getRoster(booking.id);
    if (roster.confirmed.length >= booking.min_players) continue;
    if (!claimJob('FILL_REMINDER', booking.id)) continue;

    await notifier.sendToGroup(
      dict.misc.reminderUnfilled(
        booking.code,
        roster.confirmed.length,
        booking.min_players,
        settings.commandPrefix,
      ),
    );
    sent++;
  }

  return sent;
}

/**
 * Reminds debtors privately one day before the group's payment deadline.
 * Private on purpose — a public list of who has not paid is exactly the
 * awkwardness this bot exists to remove.
 */
export async function runPaymentReminders(notifier: Notifier): Promise<number> {
  const settings = getSettings();
  const dict = t(settings.language);

  const settledRecently = many<Booking>(
    `SELECT * FROM bookings WHERE status = 'SETTLED' AND settled_at IS NOT NULL`,
  );

  let sent = 0;

  for (const booking of settledRecently) {
    const deadline = DateTime.fromISO(booking.starts_at, { zone: 'utc' }).plus({
      days: settings.paymentDeadlineDays,
    });
    const daysLeft = Math.ceil(deadline.diff(DateTime.utc(), 'days').days);

    // Fire once, the day before the deadline.
    if (daysLeft > 1 || daysLeft < 0) continue;
    if (!claimJob('PAYMENT_REMINDER', booking.id)) continue;

    const payer = findUserById(booking.payer_id);
    const debtors = many<{ from_user_id: number }>(
      `SELECT DISTINCT from_user_id FROM ledger_entries
        WHERE booking_id = ? AND kind = 'CHARGE'`,
      booking.id,
    );

    for (const { from_user_id } of debtors) {
      const owed = balanceFor(from_user_id).find((b) => b.otherUserId === booking.payer_id);
      if (!owed || owed.cents <= 0) continue;

      await notifier.sendToUser(
        from_user_id,
        dict.payment.deadlineReminder(
          formatMoney(owed.cents, booking.currency),
          displayName(payer),
          Math.max(daysLeft, 0),
        ),
      );
      sent++;
    }
  }

  return sent;
}

/**
 * GDPR housekeeping: message-processing records exist only to deduplicate
 * redeliveries, so they are dropped once they can no longer serve that purpose.
 */
export function runRetentionPurge(): { messages: number; pending: number } {
  const settings = getSettings();
  const cutoff = DateTime.utc().minus({ days: settings.dataRetentionDays }).toISO()!;

  const messages = run('DELETE FROM processed_messages WHERE processed_at < ?', cutoff).changes;
  const pending = purgeExpiredPending();

  if (messages > 0) logger.info({ messages }, 'purged old message records');
  return { messages, pending };
}

async function deliver(notifier: Notifier, message: OutgoingMessage): Promise<void> {
  if (message.target === 'dm' && message.userId != null) {
    await notifier.sendToUser(message.userId, message.text);
    return;
  }
  await notifier.sendToGroup(message.text, message.mentionUserIds);
}

export interface SchedulerHandle {
  stop(): void;
  /** Runs one pass immediately; exposed for tests and manual triggers. */
  tick(): Promise<void>;
}

export function startScheduler(notifier: Notifier, intervalMs = 60_000): SchedulerHandle {
  let running = false;

  const tick = async (): Promise<void> => {
    // A slow pass must never overlap the next one.
    if (running) return;
    running = true;
    try {
      await runAutoSettlement(notifier);
      await runFillReminders(notifier);
      await runPaymentReminders(notifier);
      runRetentionPurge();
    } catch (err) {
      logger.error({ err }, 'scheduler pass failed');
    } finally {
      running = false;
    }
  };

  const timer = setInterval(() => void tick(), intervalMs);
  // Do not hold the process open just for the scheduler.
  timer.unref?.();

  return { stop: () => clearInterval(timer), tick };
}

export { findBookingById, endsAt };

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
import { runDailyBackup } from '../domain/backup.js';
import { syncExternalBooking } from '../domain/external-sync.js';
import { listGroups } from '../domain/groups.js';
import { bookingCard } from '../bot/render.js';
import { balanceFor, settleBooking, type SettlementLine } from '../domain/ledger.js';
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
  /** Sends to a specific group's chat. groupId identifies which group. */
  sendToGroup(groupId: number, text: string, mentionUserIds?: number[]): Promise<void>;
  sendToUser(userId: number, text: string): Promise<void>;
}

function jobExists(kind: string, bookingId: number | null): boolean {
  return (
    one('SELECT 1 AS x FROM scheduled_jobs WHERE kind = ? AND booking_id IS ?', kind, bookingId) !=
    null
  );
}

function recordJob(kind: string, bookingId: number | null): void {
  run(
    `INSERT OR IGNORE INTO scheduled_jobs (kind, booking_id, due_at, done_at, created_at)
     VALUES (?, ?, ?, ?, ?)`,
    kind,
    bookingId,
    nowIso(),
    nowIso(),
    nowIso(),
  );
}

/** Marks a one-off job as done so reminders never fire twice. */
function claimJob(kind: string, bookingId: number | null): boolean {
  if (jobExists(kind, bookingId)) return false;
  recordJob(kind, bookingId);
  return true;
}

/**
 * Splits the cost of any game that finished more than a few hours ago.
 * Running from a scan rather than a timer means a restart never loses a
 * settlement that was due while the bot was down.
 */
export async function runAutoSettlement(notifier: Notifier): Promise<number> {
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

    settled++;
    logger.info({ code: booking.code }, 'auto-settled booking');
  }

  // Announcing is deliberately not done here. Writing the debts and telling
  // people about them are separate concerns, and coupling them means a dropped
  // WhatsApp socket leaves money owed that nobody was ever told about.
  await runSettlementAnnouncements(notifier);

  return settled;
}

/**
 * Rebuilds the split from the ledger so a settlement can be announced later
 * than it was recorded. Charges are what each player owes; whatever they do not
 * cover is the payer's own share, which never becomes a charge because they
 * already handed the money to the club.
 */
function settlementLinesFor(booking: Booking): SettlementLine[] {
  const charges = many<{ from_user_id: number; amount_cents: number }>(
    `SELECT from_user_id, SUM(amount_cents) AS amount_cents
       FROM ledger_entries
      WHERE booking_id = ? AND kind = 'CHARGE'
      GROUP BY from_user_id`,
    booking.id,
  );

  // No charges means nobody owes anybody: a game nobody joined, or one the
  // payer played alone. There is no split to announce.
  if (charges.length === 0) return [];

  const lateIds = new Set(
    many<{ user_id: number }>(
      `SELECT user_id FROM participants WHERE booking_id = ? AND status = 'LEFT_LATE'`,
      booking.id,
    ).map((r) => r.user_id),
  );

  const lines: SettlementLine[] = charges.map((c) => ({
    userId: c.from_user_id,
    amountCents: c.amount_cents,
    lateCancellation: lateIds.has(c.from_user_id),
  }));

  const charged = charges.reduce((sum, c) => sum + c.amount_cents, 0);
  const payerShare = booking.total_cost_cents - charged;
  if (payerShare > 0) {
    lines.push({
      userId: booking.payer_id,
      amountCents: payerShare,
      lateCancellation: lateIds.has(booking.payer_id),
    });
  }

  return lines;
}

/**
 * Announces every settled booking the group has not been told about yet, and
 * keeps retrying across ticks until the message actually goes out. The job row
 * is written only after a successful send, so a failure leaves the work
 * outstanding rather than losing it.
 */
export async function runSettlementAnnouncements(notifier: Notifier): Promise<number> {
  const pending = many<Booking>(
    `SELECT b.* FROM bookings b
      WHERE b.status = 'SETTLED' AND b.kind = 'MANAGED' AND b.settled_at IS NOT NULL
        AND NOT EXISTS (
          SELECT 1 FROM scheduled_jobs j
           WHERE j.kind = 'SETTLEMENT_ANNOUNCED' AND j.booking_id = b.id
        )
      ORDER BY b.settled_at`,
  );

  let sent = 0;

  for (const booking of pending) {
    const lines = settlementLinesFor(booking);

    // A booking nobody played produces no split; there is nothing to say.
    if (lines.length === 0) {
      recordJob('SETTLEMENT_ANNOUNCED', booking.id);
      continue;
    }

    const settings = getSettings(booking.group_id);
    const dict = t(settings.language);
    try {
      for (const message of settlementMessages(booking, lines, dict, settings)) {
        await deliver(notifier, booking.group_id, message);
      }
      recordJob('SETTLEMENT_ANNOUNCED', booking.id);
      sent++;
      logger.info({ code: booking.code }, 'announced settlement');
    } catch (err) {
      // Almost always a closed socket. Stop for this pass rather than hammering
      // a dead connection; the next tick tries again.
      logger.error({ err, code: booking.code }, 'could not announce settlement, will retry');
      break;
    }
  }

  return sent;
}

/** How long a synced external booking stays fresh before a refresh. */
const EXTERNAL_REFRESH_MINUTES = 15;

/**
 * Enriches external (Playtomic) bookings with live roster/slot data, and
 * announces the enriched card once, the first time a booking is synced, so the
 * group sees who is in without anyone re-listing. Never-synced bookings are
 * done first (immediate feedback after adding); already-synced ones refresh on
 * a slower cadence.
 */
export async function runExternalSync(notifier: Notifier): Promise<number> {
  const stale = DateTime.utc().minus({ minutes: EXTERNAL_REFRESH_MINUTES }).toISO()!;
  const due = many<Booking>(
    `SELECT * FROM bookings
      WHERE kind = 'EXTERNAL' AND status = 'OPEN'
        AND datetime(starts_at) >= datetime('now', '-6 hours')
        AND (external_synced_at IS NULL OR external_synced_at < ?)
      ORDER BY external_synced_at IS NOT NULL, starts_at`,
    stale,
  );

  let synced = 0;
  for (const booking of due) {
    const firstSync = booking.external_synced_at == null;
    const result = await syncExternalBooking(booking);

    // The platform cancelled it (explicit status, or gone for two syncs): the
    // booking is now CANCELLED — tell the group once and move on.
    if (result.cancelled) {
      const settings = getSettings(booking.group_id);
      try {
        await notifier.sendToGroup(
          booking.group_id,
          t(settings.language).external.cancelled(booking.code, booking.external_provider ?? 'external'),
        );
        logger.info({ code: booking.code }, 'announced external cancellation');
      } catch (err) {
        logger.error({ err, code: booking.code }, 'could not announce external cancellation');
      }
      continue;
    }

    if (!result.ok) continue;
    synced++;

    // Announce only the first successful sync, so a refresh does not re-spam.
    if (firstSync) {
      const fresh = findBookingById(booking.id);
      if (fresh) {
        const settings = getSettings(fresh.group_id);
        try {
          await notifier.sendToGroup(fresh.group_id, bookingCard(fresh, t(settings.language), settings));
        } catch (err) {
          logger.error({ err, code: fresh.code }, 'could not announce synced external booking');
        }
      }
    }
  }
  return synced;
}

/** Nudges the group about a game that is close and still short of players. */
export async function runFillReminders(notifier: Notifier): Promise<number> {
  let sent = 0;

  for (const group of listGroups()) {
    const settings = getSettings(group.id);
    if (settings.reminderHoursBefore <= 0) continue;

    const dict = t(settings.language);
    const horizon = DateTime.utc().plus({ hours: settings.reminderHoursBefore }).toISO()!;

    for (const booking of listUpcoming(group.id, 50)) {
      if (booking.kind === 'EXTERNAL') continue;
      if (booking.starts_at > horizon) continue;

      const roster = getRoster(booking.id);
      if (roster.confirmed.length >= booking.min_players) continue;
      if (!claimJob('FILL_REMINDER', booking.id)) continue;

      await notifier.sendToGroup(
        group.id,
        `📣 ${dict.misc.reminderUnfilled(
          booking.code,
          roster.confirmed.length,
          booking.min_players,
          settings.commandPrefix,
        )}`,
      );
      sent++;
    }
  }

  return sent;
}

/**
 * Reminds debtors privately one day before the group's payment deadline.
 * Private on purpose — a public list of who has not paid is exactly the
 * awkwardness this bot exists to remove.
 */
export async function runPaymentReminders(notifier: Notifier): Promise<number> {

  const settledRecently = many<Booking>(
    `SELECT * FROM bookings WHERE status = 'SETTLED' AND settled_at IS NOT NULL`,
  );

  let sent = 0;

  for (const booking of settledRecently) {
    const settings = getSettings(booking.group_id);
    const dict = t(settings.language);
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
      const owed = balanceFor(from_user_id, booking.group_id).find(
        (b) => b.otherUserId === booking.payer_id,
      );
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
  const settings = getSettings(1);
  const cutoff = DateTime.utc().minus({ days: settings.dataRetentionDays }).toISO()!;

  const messages = run('DELETE FROM processed_messages WHERE processed_at < ?', cutoff).changes;
  const pending = purgeExpiredPending();

  if (messages > 0) logger.info({ messages }, 'purged old message records');
  return { messages, pending };
}

/**
 * Daily snapshot of the database. Self-skipping, so calling it every minute
 * costs one directory listing until the calendar day rolls over.
 */
export function runBackup(): ReturnType<typeof runDailyBackup> {
  const keep = getSettings(1).backupKeepDays;
  if (keep <= 0) return { status: 'skipped' };
  return runDailyBackup(keep);
}

async function deliver(
  notifier: Notifier,
  groupId: number,
  message: OutgoingMessage,
): Promise<void> {
  if (message.target === 'dm' && message.userId != null) {
    await notifier.sendToUser(message.userId, message.text);
    return;
  }
  await notifier.sendToGroup(groupId, message.text, message.mentionUserIds);
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

    // Each task is isolated: a dropped WhatsApp socket while announcing a
    // settlement must not also skip the backup and the retention purge, which
    // is exactly what a single try/catch around the whole pass did.
    const safely = async (task: string, fn: () => Promise<unknown> | unknown): Promise<void> => {
      try {
        await fn();
      } catch (err) {
        logger.error({ err, task }, 'scheduler task failed');
      }
    };

    try {
      await safely('externalSync', () => runExternalSync(notifier));
      await safely('autoSettlement', () => runAutoSettlement(notifier));
      await safely('settlementAnnouncements', () => runSettlementAnnouncements(notifier));
      await safely('fillReminders', () => runFillReminders(notifier));
      await safely('paymentReminders', () => runPaymentReminders(notifier));
      await safely('retentionPurge', () => runRetentionPurge());
      await safely('backup', () => runBackup());
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

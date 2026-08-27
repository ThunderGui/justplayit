import { many, one, run, transaction } from '../db/index.js';
import { nowIso } from '../util/datetime.js';
import { splitCents } from '../util/money.js';
import type { Booking } from './bookings.js';
import { findBookingById, payingUserIds } from './bookings.js';
import { getSettings } from './settings.js';

export type LedgerKind = 'CHARGE' | 'PAYMENT' | 'ADJUSTMENT';

export interface LedgerEntry {
  id: number;
  kind: LedgerKind;
  booking_id: number | null;
  from_user_id: number;
  to_user_id: number;
  amount_cents: number;
  currency: string;
  note: string | null;
  created_by: number | null;
  created_at: string;
}

/** Positive `cents` means `userId` owes `otherUserId`. */
export interface PairBalance {
  otherUserId: number;
  cents: number;
}

/* ------------------------------------------------------------------ */
/* Writing                                                             */
/* ------------------------------------------------------------------ */

export function addLedgerEntry(input: {
  kind: LedgerKind;
  fromUserId: number;
  toUserId: number;
  amountCents: number;
  currency?: string;
  bookingId?: number | null;
  note?: string | null;
  createdBy?: number | null;
}): LedgerEntry {
  const { lastInsertRowid } = run(
    `INSERT INTO ledger_entries
       (kind, booking_id, from_user_id, to_user_id, amount_cents, currency, note, created_by, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    input.kind,
    input.bookingId ?? null,
    input.fromUserId,
    input.toUserId,
    input.amountCents,
    input.currency ?? getSettings().currency,
    input.note ?? null,
    input.createdBy ?? null,
    nowIso(),
  );
  return one<LedgerEntry>('SELECT * FROM ledger_entries WHERE id = ?', lastInsertRowid)!;
}

/* ------------------------------------------------------------------ */
/* Settlement                                                          */
/* ------------------------------------------------------------------ */

export interface SettlementLine {
  userId: number;
  amountCents: number;
  /** True when this player never took the court but still owes (late cancel). */
  lateCancellation: boolean;
}

export type SettleResult =
  | { ok: true; booking: Booking; lines: SettlementLine[]; perPlayerCents: number }
  | {
      ok: false;
      reason: 'not_found' | 'cancelled' | 'already_settled' | 'no_players' | 'external';
    };

/**
 * Turns a played booking into debts owed to whoever fronted the money.
 * Idempotent by way of the SETTLED status guard.
 */
export function settleBooking(bookingId: number): SettleResult {
  return transaction<SettleResult>(() => {
    const booking = findBookingById(bookingId);
    if (!booking) return { ok: false, reason: 'not_found' };
    // Playtomic and friends collect the money themselves; nothing to split here.
    if (booking.kind === 'EXTERNAL') return { ok: false, reason: 'external' };
    if (booking.status === 'CANCELLED') return { ok: false, reason: 'cancelled' };
    if (booking.status === 'SETTLED') return { ok: false, reason: 'already_settled' };

    const payers = payingUserIds(booking);
    if (payers.length === 0) return { ok: false, reason: 'no_players' };

    const shares = splitCents(booking.total_cost_cents, payers.length);
    const lateLeaverIds = new Set(
      many<{ user_id: number }>(
        `SELECT user_id FROM participants WHERE booking_id = ? AND status = 'LEFT_LATE'`,
        booking.id,
      ).map((r) => r.user_id),
    );

    const lines: SettlementLine[] = [];

    payers.forEach((userId, index) => {
      const amountCents = shares[index]!;
      lines.push({ userId, amountCents, lateCancellation: lateLeaverIds.has(userId) });

      // The payer fronted the whole court; they do not owe themselves.
      if (userId === booking.payer_id || amountCents === 0) return;

      addLedgerEntry({
        kind: 'CHARGE',
        fromUserId: userId,
        toUserId: booking.payer_id,
        amountCents,
        currency: booking.currency,
        bookingId: booking.id,
        note: `Booking ${booking.code}`,
      });
    });

    run(`UPDATE bookings SET status = 'SETTLED', settled_at = ? WHERE id = ?`, nowIso(), booking.id);

    return {
      ok: true,
      booking: findBookingById(booking.id)!,
      lines,
      perPlayerCents: shares[0] ?? 0,
    };
  });
}

/* ------------------------------------------------------------------ */
/* Balances (the netting the design asks for)                          */
/* ------------------------------------------------------------------ */

/**
 * Nets every charge and payment between a pair of people into one number, which
 * is what makes the design's example work: if X owes you €8 from today's court
 * and you owe X €10 from next week's, the answer is "you owe X €2" — not two
 * separate debts that both have to be paid.
 *
 * Returns entries sorted largest-debt-first, zeroes omitted.
 */
export function balanceFor(userId: number): PairBalance[] {
  const rows = many<{
    kind: LedgerKind;
    from_user_id: number;
    to_user_id: number;
    total: number;
  }>(
    `SELECT kind, from_user_id, to_user_id, SUM(amount_cents) AS total
       FROM ledger_entries
      WHERE from_user_id = ? OR to_user_id = ?
      GROUP BY kind, from_user_id, to_user_id`,
    userId,
    userId,
  );

  const net = new Map<number, number>();

  for (const row of rows) {
    const other = row.from_user_id === userId ? row.to_user_id : row.from_user_id;
    const iAmSource = row.from_user_id === userId;

    // CHARGE from me => I owe (+). PAYMENT from me => I settled some of it (−).
    // ADJUSTMENT follows the same direction convention as CHARGE.
    let delta: number;
    if (row.kind === 'PAYMENT') {
      delta = iAmSource ? -row.total : row.total;
    } else {
      delta = iAmSource ? row.total : -row.total;
    }

    net.set(other, (net.get(other) ?? 0) + delta);
  }

  return [...net.entries()]
    .map(([otherUserId, cents]) => ({ otherUserId, cents }))
    .filter((b) => b.cents !== 0)
    .sort((a, b) => b.cents - a.cents);
}

export interface OverallBalanceRow {
  userId: number;
  /** Net position: positive = the group owes them, negative = they owe the group. */
  netCents: number;
}

/** Every user's net position. Sums to zero. Used by the admin overview. */
export function overallBalances(): OverallBalanceRow[] {
  const rows = many<{
    kind: LedgerKind;
    from_user_id: number;
    to_user_id: number;
    total: number;
  }>(
    `SELECT kind, from_user_id, to_user_id, SUM(amount_cents) AS total
       FROM ledger_entries GROUP BY kind, from_user_id, to_user_id`,
  );

  const net = new Map<number, number>();
  const bump = (id: number, delta: number) => net.set(id, (net.get(id) ?? 0) + delta);

  for (const row of rows) {
    const sign = row.kind === 'PAYMENT' ? -1 : 1;
    // Debtor's position goes down, creditor's goes up.
    bump(row.from_user_id, -sign * row.total);
    bump(row.to_user_id, sign * row.total);
  }

  return [...net.entries()]
    .map(([userId, netCents]) => ({ userId, netCents }))
    .filter((r) => r.netCents !== 0)
    .sort((a, b) => b.netCents - a.netCents);
}

export interface Transfer {
  fromUserId: number;
  toUserId: number;
  cents: number;
}

/**
 * Collapses the whole group's debts into the fewest transfers that settle
 * everyone — so a 6-player group with a tangle of IOUs gets a short list of
 * "pay this person this much" instead of one payment per booking.
 *
 * Greedy largest-debtor-to-largest-creditor. Not provably minimal (that problem
 * is NP-hard), but optimal for the small, sparse graphs a friend group produces.
 */
export function simplifyDebts(): Transfer[] {
  const balances = overallBalances();
  const debtors = balances.filter((b) => b.netCents < 0).map((b) => ({ ...b }));
  const creditors = balances.filter((b) => b.netCents > 0).map((b) => ({ ...b }));

  debtors.sort((a, b) => a.netCents - b.netCents);
  creditors.sort((a, b) => b.netCents - a.netCents);

  const transfers: Transfer[] = [];
  let d = 0;
  let c = 0;

  while (d < debtors.length && c < creditors.length) {
    const debtor = debtors[d]!;
    const creditor = creditors[c]!;
    const amount = Math.min(-debtor.netCents, creditor.netCents);

    if (amount > 0) {
      transfers.push({ fromUserId: debtor.userId, toUserId: creditor.userId, cents: amount });
      debtor.netCents += amount;
      creditor.netCents -= amount;
    }

    if (debtor.netCents === 0) d++;
    if (creditor.netCents === 0) c++;
  }

  return transfers;
}

/** Ledger history between two people, newest first. */
export function historyBetween(userId: number, otherUserId: number, limit = 20): LedgerEntry[] {
  return many<LedgerEntry>(
    `SELECT * FROM ledger_entries
      WHERE (from_user_id = ? AND to_user_id = ?) OR (from_user_id = ? AND to_user_id = ?)
      ORDER BY created_at DESC LIMIT ?`,
    userId,
    otherUserId,
    otherUserId,
    userId,
    limit,
  );
}

export function listLedger(limit = 200): LedgerEntry[] {
  return many<LedgerEntry>('SELECT * FROM ledger_entries ORDER BY created_at DESC LIMIT ?', limit);
}

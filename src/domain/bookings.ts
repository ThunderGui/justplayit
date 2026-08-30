import { DateTime } from 'luxon';
import { many, one, run, transaction } from '../db/index.js';
import { nowIso } from '../util/datetime.js';
import { generateUniqueCode, normaliseCode } from '../util/ids.js';
import type { Place } from './places.js';
import { findPlaceById } from './places.js';
import { getSettings } from './settings.js';
import type { User } from './users.js';

export type BookingStatus = 'OPEN' | 'CANCELLED' | 'SETTLED';
export type ParticipantStatus = 'CONFIRMED' | 'WAITLIST' | 'LEFT' | 'LEFT_LATE';

/**
 * MANAGED  — the bot owns the roster, the split and the debts.
 * EXTERNAL — booked on Playtomic or similar; the bot only surfaces it on the
 *            calendar with its link. No roster, no cost, no ledger.
 */
export type BookingKind = 'MANAGED' | 'EXTERNAL';

export interface Booking {
  id: number;
  code: string;
  kind: BookingKind;
  external_provider: string | null;
  external_url: string | null;
  creator_id: number;
  payer_id: number;
  place_id: number | null;
  custom_place: string | null;
  court: string | null;
  starts_at: string;
  duration_min: number;
  total_cost_cents: number;
  currency: string;
  min_players: number;
  max_players: number;
  cancel_limit_hours: number;
  notes: string | null;
  status: BookingStatus;
  cancelled_at: string | null;
  cancelled_by: number | null;
  settled_at: string | null;
  created_at: string;
}

export interface Participant {
  id: number;
  booking_id: number;
  user_id: number;
  status: ParticipantStatus;
  joined_at: string;
  left_at: string | null;
  seq: number;
  liable: number;
  replaced_by: number | null;
}

export interface BookingRoster {
  confirmed: Participant[];
  waitlist: Participant[];
  lateLeavers: Participant[];
}

/* ------------------------------------------------------------------ */
/* Reads                                                               */
/* ------------------------------------------------------------------ */

export function findBookingById(id: number): Booking | undefined {
  return one<Booking>('SELECT * FROM bookings WHERE id = ?', id);
}

export function findBookingByCode(code: string): Booking | undefined {
  return one<Booking>('SELECT * FROM bookings WHERE code = ?', normaliseCode(code));
}

export function getRoster(bookingId: number): BookingRoster {
  const rows = many<Participant>(
    'SELECT * FROM participants WHERE booking_id = ? ORDER BY seq',
    bookingId,
  );
  return {
    confirmed: rows.filter((p) => p.status === 'CONFIRMED'),
    waitlist: rows.filter((p) => p.status === 'WAITLIST'),
    lateLeavers: rows.filter((p) => p.status === 'LEFT_LATE'),
  };
}

export function getParticipant(bookingId: number, userId: number): Participant | undefined {
  return one<Participant>(
    'SELECT * FROM participants WHERE booking_id = ? AND user_id = ?',
    bookingId,
    userId,
  );
}

export function listUpcoming(limit = 20): Booking[] {
  return many<Booking>(
    `SELECT * FROM bookings
      WHERE status = 'OPEN' AND datetime(starts_at) >= datetime(?)
      ORDER BY starts_at
      LIMIT ?`,
    // A game already under way is still "upcoming" for listing purposes.
    DateTime.utc().minus({ hours: 3 }).toISO()!,
    limit,
  );
}

export function listAllBookings(limit = 200): Booking[] {
  return many<Booking>('SELECT * FROM bookings ORDER BY starts_at DESC LIMIT ?', limit);
}

export function placeLabel(booking: Booking): string {
  if (booking.custom_place) return booking.custom_place;
  const place: Place | undefined = booking.place_id ? findPlaceById(booking.place_id) : undefined;
  return place?.name ?? 'unknown place';
}

export function placeAddress(booking: Booking): string | null {
  if (booking.place_id) return findPlaceById(booking.place_id)?.address ?? null;
  return booking.custom_place;
}

export function endsAt(booking: Booking): string {
  return DateTime.fromISO(booking.starts_at, { zone: 'utc' })
    .plus({ minutes: booking.duration_min })
    .toISO()!;
}

/** The moment after which leaving makes the player liable for their share. */
export function cancellationDeadline(booking: Booking): string {
  return DateTime.fromISO(booking.starts_at, { zone: 'utc' })
    .minus({ hours: booking.cancel_limit_hours })
    .toISO()!;
}

export function isPastCancellationDeadline(booking: Booking, at: string = nowIso()): boolean {
  return at >= cancellationDeadline(booking);
}

/* ------------------------------------------------------------------ */
/* Overlap detection                                                   */
/* ------------------------------------------------------------------ */

/**
 * "No same time double reservations" — two OPEN bookings may not overlap in
 * time at all, regardless of club. The group is one set of players; they cannot
 * be on two courts at once.
 */
export function findOverlapping(
  startsAtIso: string,
  durationMin: number,
  excludeBookingId?: number,
): Booking | undefined {
  const start = DateTime.fromISO(startsAtIso, { zone: 'utc' });
  const end = start.plus({ minutes: durationMin });

  return one<Booking>(
    `SELECT * FROM bookings
      WHERE status = 'OPEN'
        AND id <> COALESCE(?, -1)
        AND datetime(starts_at) < datetime(?)
        AND datetime(starts_at, '+' || duration_min || ' minutes') > datetime(?)
      ORDER BY starts_at
      LIMIT 1`,
    excludeBookingId ?? null,
    end.toISO()!,
    start.toISO()!,
  );
}

/* ------------------------------------------------------------------ */
/* Create                                                              */
/* ------------------------------------------------------------------ */

export interface CreateBookingInput {
  creator: User;
  startsAtIso: string;
  durationMin?: number;
  totalCostCents: number;
  minPlayers?: number;
  maxPlayers?: number;
  placeId?: number | null;
  customPlace?: string | null;
  court?: string | null;
  notes?: string | null;
  cancelLimitHours?: number | null;
  /** Whether the creator is also joining. Defaults to true. */
  joinAsPlayer?: boolean;
}

export type CreateBookingResult =
  | { ok: true; booking: Booking }
  | { ok: false; reason: 'overlap'; conflict: Booking }
  | { ok: false; reason: 'in_past' }
  | { ok: false; reason: 'invalid_players' }
  | { ok: false; reason: 'custom_place_not_allowed' }
  | { ok: false; reason: 'no_place' }
  | { ok: false; reason: 'cancel_limit_locked' };

export function createBooking(input: CreateBookingInput): CreateBookingResult {
  const settings = getSettings();

  const minPlayers = input.minPlayers ?? settings.defaultMinPlayers;
  const maxPlayers = input.maxPlayers ?? Math.max(settings.defaultMaxPlayers, minPlayers);
  if (minPlayers < 1 || maxPlayers < minPlayers) return { ok: false, reason: 'invalid_players' };

  if (!input.placeId && !input.customPlace) return { ok: false, reason: 'no_place' };
  if (!input.placeId && input.customPlace && !settings.allowCustomPlaces) {
    return { ok: false, reason: 'custom_place_not_allowed' };
  }

  if (input.startsAtIso <= nowIso()) return { ok: false, reason: 'in_past' };

  let cancelLimit = settings.defaultCancelLimitHours;
  if (input.cancelLimitHours != null && input.cancelLimitHours !== cancelLimit) {
    if (!settings.allowPerBookingCancelLimit) return { ok: false, reason: 'cancel_limit_locked' };
    cancelLimit = input.cancelLimitHours;
  }

  const durationMin = input.durationMin ?? settings.defaultDurationMin;

  return transaction<CreateBookingResult>(() => {
    const conflict = findOverlapping(input.startsAtIso, durationMin);
    if (conflict) return { ok: false, reason: 'overlap', conflict };

    const code = generateUniqueCode(
      (candidate) => one('SELECT 1 AS x FROM bookings WHERE code = ?', candidate) != null,
    );

    const { lastInsertRowid } = run(
      `INSERT INTO bookings (
         code, kind, creator_id, payer_id, place_id, custom_place, court,
         starts_at, duration_min, total_cost_cents, currency,
         min_players, max_players, cancel_limit_hours, notes, status, created_at
       ) VALUES (?, 'MANAGED', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'OPEN', ?)`,
      code,
      input.creator.id,
      input.creator.id,
      input.placeId ?? null,
      input.placeId ? null : (input.customPlace ?? null),
      input.court?.trim() || null,
      input.startsAtIso,
      durationMin,
      input.totalCostCents,
      settings.currency,
      minPlayers,
      maxPlayers,
      cancelLimit,
      input.notes?.trim() || null,
      nowIso(),
    );

    const booking = findBookingById(lastInsertRowid)!;

    // The person fronting the money is almost always playing.
    if (input.joinAsPlayer !== false) {
      addParticipant(booking, input.creator.id, 'CONFIRMED');
    }

    return { ok: true, booking };
  });
}

/* ------------------------------------------------------------------ */
/* External bookings (Playtomic and friends)                           */
/* ------------------------------------------------------------------ */

export interface CreateExternalBookingInput {
  creator: User;
  provider: string;
  url: string;
  startsAtIso: string;
  durationMin?: number;
  placeId?: number | null;
  customPlace?: string | null;
  court?: string | null;
  notes?: string | null;
}

export type CreateExternalBookingResult =
  | { ok: true; booking: Booking }
  | { ok: false; reason: 'overlap'; conflict: Booking }
  | { ok: false; reason: 'in_past' | 'bad_url' };

export function isHttpUrl(value: string): boolean {
  try {
    const url = new URL(value.trim());
    return url.protocol === 'https:' || url.protocol === 'http:';
  } catch {
    return false;
  }
}

/**
 * Records a reservation that lives on an external platform. The bot shows it on
 * the calendar with its link and blocks the time slot, but keeps no roster and
 * never touches the ledger — sign-ups and money stay on that platform.
 */
export function createExternalBooking(
  input: CreateExternalBookingInput,
): CreateExternalBookingResult {
  const settings = getSettings();
  const url = input.url.trim();

  if (!isHttpUrl(url)) return { ok: false, reason: 'bad_url' };
  if (input.startsAtIso <= nowIso()) return { ok: false, reason: 'in_past' };

  const durationMin = input.durationMin ?? settings.defaultDurationMin;

  return transaction<CreateExternalBookingResult>(() => {
    // Still guards the "no two games at once" rule: the group cannot be on a
    // Playtomic court and a self-organised one simultaneously.
    const conflict = findOverlapping(input.startsAtIso, durationMin);
    if (conflict) return { ok: false, reason: 'overlap', conflict };

    const code = generateUniqueCode(
      (candidate) => one('SELECT 1 AS x FROM bookings WHERE code = ?', candidate) != null,
    );

    const { lastInsertRowid } = run(
      `INSERT INTO bookings (
         code, kind, external_provider, external_url, creator_id, payer_id,
         place_id, custom_place, court, starts_at, duration_min,
         total_cost_cents, currency, min_players, max_players,
         cancel_limit_hours, notes, status, created_at
       ) VALUES (?, 'EXTERNAL', ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, 1, 1, 0, ?, 'OPEN', ?)`,
      code,
      input.provider,
      url,
      input.creator.id,
      input.creator.id,
      input.placeId ?? null,
      input.placeId ? null : (input.customPlace ?? null),
      input.court?.trim() || null,
      input.startsAtIso,
      durationMin,
      settings.currency,
      input.notes?.trim() || null,
      nowIso(),
    );

    return { ok: true, booking: findBookingById(lastInsertRowid)! };
  });
}

export function isExternal(booking: Booking): boolean {
  return booking.kind === 'EXTERNAL';
}

function nextSeq(bookingId: number): number {
  const row = one<{ n: number | null }>(
    'SELECT MAX(seq) AS n FROM participants WHERE booking_id = ?',
    bookingId,
  );
  return (row?.n ?? 0) + 1;
}

function addParticipant(booking: Booking, userId: number, status: ParticipantStatus): Participant {
  run(
    `INSERT INTO participants (booking_id, user_id, status, joined_at, seq, liable)
     VALUES (?, ?, ?, ?, ?, 0)`,
    booking.id,
    userId,
    status,
    nowIso(),
    nextSeq(booking.id),
  );
  return getParticipant(booking.id, userId)!;
}

/* ------------------------------------------------------------------ */
/* Cancel a whole booking                                             */
/* ------------------------------------------------------------------ */

export type CancelBookingResult =
  | { ok: true; booking: Booking; notifyUserIds: number[] }
  | { ok: false; reason: 'not_found' | 'not_allowed' | 'already_cancelled' | 'already_settled' };

export function cancelBooking(
  code: string,
  actor: User,
  actorIsAdmin: boolean,
): CancelBookingResult {
  const booking = findBookingByCode(code);
  if (!booking) return { ok: false, reason: 'not_found' };
  if (booking.status === 'CANCELLED') return { ok: false, reason: 'already_cancelled' };
  if (booking.status === 'SETTLED') return { ok: false, reason: 'already_settled' };
  if (booking.creator_id !== actor.id && !actorIsAdmin) return { ok: false, reason: 'not_allowed' };

  const roster = getRoster(booking.id);
  const notifyUserIds = [...roster.confirmed, ...roster.waitlist]
    .map((p) => p.user_id)
    .filter((id) => id !== actor.id);

  run(
    `UPDATE bookings SET status = 'CANCELLED', cancelled_at = ?, cancelled_by = ? WHERE id = ?`,
    nowIso(),
    actor.id,
    booking.id,
  );
  // Cancelling the court cancels everybody's obligation with it.
  run('DELETE FROM scheduled_jobs WHERE booking_id = ? AND done_at IS NULL', booking.id);

  return { ok: true, booking: findBookingById(booking.id)!, notifyUserIds };
}

/* ------------------------------------------------------------------ */
/* Join                                                                */
/* ------------------------------------------------------------------ */

export type JoinResult =
  | { ok: true; outcome: 'confirmed'; booking: Booking; position: number }
  | { ok: true; outcome: 'waitlisted'; booking: Booking; position: number }
  | { ok: true; outcome: 'rejoined'; booking: Booking; position: number }
  | {
      ok: false;
      reason:
        | 'not_found'
        | 'cancelled'
        | 'settled'
        | 'already_in'
        | 'already_waiting'
        | 'past'
        | 'external';
      booking?: Booking;
    };

export function joinBooking(code: string, user: User): JoinResult {
  return transaction<JoinResult>(() => {
    const booking = findBookingByCode(code);
    if (!booking) return { ok: false, reason: 'not_found' };
    // Sign-ups for an external booking happen on that platform, not here.
    if (isExternal(booking)) return { ok: false, reason: 'external', booking };
    if (booking.status === 'CANCELLED') return { ok: false, reason: 'cancelled', booking };
    if (booking.status === 'SETTLED') return { ok: false, reason: 'settled', booking };
    if (booking.starts_at <= nowIso()) return { ok: false, reason: 'past', booking };

    const existing = getParticipant(booking.id, user.id);
    if (existing?.status === 'CONFIRMED') return { ok: false, reason: 'already_in', booking };
    if (existing?.status === 'WAITLIST') return { ok: false, reason: 'already_waiting', booking };

    const roster = getRoster(booking.id);
    const hasRoom = roster.confirmed.length < booking.max_players;
    const status: ParticipantStatus = hasRoom ? 'CONFIRMED' : 'WAITLIST';

    if (existing) {
      // Re-joining after leaving: reuse the row but take a fresh queue position
      // so they cannot jump ahead of people who waited.
      run(
        `UPDATE participants
            SET status = ?, joined_at = ?, left_at = NULL, seq = ?, liable = 0, replaced_by = NULL
          WHERE id = ?`,
        status,
        nowIso(),
        nextSeq(booking.id),
        existing.id,
      );
    } else {
      addParticipant(booking, user.id, status);
    }

    if (status === 'CONFIRMED') {
      creditReplacement(booking, user.id);
      const position = getRoster(booking.id).confirmed.length;
      return {
        ok: true,
        outcome: existing ? 'rejoined' : 'confirmed',
        booking,
        position,
      };
    }

    const position = getRoster(booking.id).waitlist.findIndex((p) => p.user_id === user.id) + 1;
    return { ok: true, outcome: 'waitlisted', booking, position };
  });
}

/**
 * A late canceller is let off the hook when someone takes their slot. Credits
 * the longest-waiting unreplaced late leaver, one replacement each.
 * Note this only records the replacement — whether the debt is actually waived
 * is decided at settlement, because min_players must also be met.
 */
function creditReplacement(booking: Booking, joiningUserId: number): void {
  const candidate = one<Participant>(
    `SELECT * FROM participants
      WHERE booking_id = ? AND status = 'LEFT_LATE' AND replaced_by IS NULL
        AND user_id <> ?
      ORDER BY left_at
      LIMIT 1`,
    booking.id,
    joiningUserId,
  );
  if (!candidate) return;
  run('UPDATE participants SET replaced_by = ? WHERE id = ?', joiningUserId, candidate.id);
}

/* ------------------------------------------------------------------ */
/* Leave                                                               */
/* ------------------------------------------------------------------ */

export type LeaveResult =
  | { ok: true; outcome: 'left'; booking: Booking; promoted: Participant | null }
  | { ok: true; outcome: 'left_waitlist'; booking: Booking }
  | {
      ok: true;
      outcome: 'needs_late_confirmation';
      booking: Booking;
      shareEstimateCents: number;
    }
  | {
      ok: true;
      outcome: 'left_late';
      booking: Booking;
      promoted: Participant | null;
      liable: boolean;
    }
  | {
      ok: false;
      reason: 'not_found' | 'cancelled' | 'settled' | 'not_in' | 'external';
      booking?: Booking;
    };

/**
 * @param confirmLate set once the user has answered the "you may still owe for
 *        this" prompt. Without it, a late leave returns `needs_late_confirmation`
 *        and nothing is written.
 */
export function leaveBooking(code: string, user: User, confirmLate = false): LeaveResult {
  return transaction<LeaveResult>(() => {
    const booking = findBookingByCode(code);
    if (!booking) return { ok: false, reason: 'not_found' };
    if (isExternal(booking)) return { ok: false, reason: 'external', booking };
    if (booking.status === 'CANCELLED') return { ok: false, reason: 'cancelled', booking };
    if (booking.status === 'SETTLED') return { ok: false, reason: 'settled', booking };

    const participant = getParticipant(booking.id, user.id);
    if (!participant || participant.status === 'LEFT' || participant.status === 'LEFT_LATE') {
      return { ok: false, reason: 'not_in', booking };
    }

    // Leaving the waiting list never costs anything.
    if (participant.status === 'WAITLIST') {
      run(
        `UPDATE participants SET status = 'LEFT', left_at = ? WHERE id = ?`,
        nowIso(),
        participant.id,
      );
      return { ok: true, outcome: 'left_waitlist', booking };
    }

    const isLate = isPastCancellationDeadline(booking);

    if (isLate && !confirmLate) {
      return {
        ok: true,
        outcome: 'needs_late_confirmation',
        booking,
        shareEstimateCents: estimateShareCents(booking),
      };
    }

    run(
      `UPDATE participants SET status = ?, left_at = ?, liable = ? WHERE id = ?`,
      isLate ? 'LEFT_LATE' : 'LEFT',
      nowIso(),
      isLate ? 1 : 0,
      participant.id,
    );

    const promoted = promoteFromWaitlist(booking);

    if (!isLate) return { ok: true, outcome: 'left', booking, promoted };

    // If the waiting list immediately filled the slot, that counts as the
    // replacement, so record it now.
    if (promoted) creditReplacement(booking, promoted.user_id);

    return {
      ok: true,
      outcome: 'left_late',
      booking,
      promoted,
      liable: promoted == null,
    };
  });
}

/** Moves the first waiting player into a free slot. Returns them, or null. */
export function promoteFromWaitlist(booking: Booking): Participant | null {
  const roster = getRoster(booking.id);
  if (roster.confirmed.length >= booking.max_players) return null;

  const next = roster.waitlist[0];
  if (!next) return null;

  run(`UPDATE participants SET status = 'CONFIRMED' WHERE id = ?`, next.id);
  return getParticipant(booking.id, next.user_id)!;
}

/* ------------------------------------------------------------------ */
/* Cost splitting                                                      */
/* ------------------------------------------------------------------ */

/**
 * Everyone who pays for this booking: the players on the sheet, plus late
 * cancellers who were never replaced — or every late canceller if the group
 * failed to reach `min_players`, per the group rules.
 */
export function payingUserIds(booking: Booking): number[] {
  // Money for an external booking is handled entirely on that platform.
  if (isExternal(booking)) return [];

  const roster = getRoster(booking.id);
  const confirmedCount = roster.confirmed.length;
  const minMet = confirmedCount >= booking.min_players;

  const liableLate = roster.lateLeavers.filter((p) => p.replaced_by == null || !minMet);

  return [...roster.confirmed, ...liableLate].map((p) => p.user_id);
}

/** What one player would pay if the booking settled right now. */
export function estimateShareCents(booking: Booking): number {
  const count = payingUserIds(booking).length;
  return count > 0 ? Math.round(booking.total_cost_cents / count) : booking.total_cost_cents;
}

/* ------------------------------------------------------------------ */
/* Editing an existing booking                                         */
/* ------------------------------------------------------------------ */

export interface EditBookingInput {
  startsAtIso?: string;
  durationMin?: number;
  totalCostCents?: number;
  minPlayers?: number;
  maxPlayers?: number;
  placeId?: number | null;
  customPlace?: string | null;
  court?: string | null;
  notes?: string | null;
  cancelLimitHours?: number;
}

export type EditBookingResult =
  | {
      ok: true;
      booking: Booking;
      /** True when the start or duration moved, so players must be told. */
      scheduleChanged: boolean;
      previousStartsAt: string;
    }
  | { ok: false; reason: 'overlap'; conflict: Booking }
  | {
      ok: false;
      reason: 'not_found' | 'not_editable' | 'in_past' | 'invalid_players' | 'no_place';
    };

/**
 * Applies an admin's edits to an open booking.
 *
 * Moving a booking re-runs the double-booking check against every other open
 * booking, excluding itself — otherwise a booking would always collide with
 * where it already is. The cancellation deadline is derived from the start
 * time, so it follows the new schedule automatically.
 */
export function editBooking(id: number, input: EditBookingInput): EditBookingResult {
  return transaction<EditBookingResult>(() => {
    const booking = findBookingById(id);
    if (!booking) return { ok: false, reason: 'not_found' };
    // A cancelled or settled booking is history; editing it would rewrite
    // debts people have already been told about.
    if (booking.status !== 'OPEN') return { ok: false, reason: 'not_editable' };

    const external = isExternal(booking);
    const startsAtIso = input.startsAtIso ?? booking.starts_at;
    const durationMin = input.durationMin ?? booking.duration_min;

    const minPlayers = input.minPlayers ?? booking.min_players;
    const maxPlayers = input.maxPlayers ?? booking.max_players;
    if (!external && (minPlayers < 1 || maxPlayers < minPlayers)) {
      return { ok: false, reason: 'invalid_players' };
    }

    const placeId = input.placeId !== undefined ? input.placeId : booking.place_id;
    const customPlace = input.customPlace !== undefined ? input.customPlace : booking.custom_place;
    if (!placeId && !customPlace && !external) return { ok: false, reason: 'no_place' };

    const scheduleChanged =
      startsAtIso !== booking.starts_at || durationMin !== booking.duration_min;

    if (scheduleChanged) {
      // Refuse to move a live booking into the past: auto-settlement would fire
      // within hours and turn a mistyped year into real debts.
      if (startsAtIso <= nowIso()) return { ok: false, reason: 'in_past' };

      const conflict = findOverlapping(startsAtIso, durationMin, booking.id);
      if (conflict) return { ok: false, reason: 'overlap', conflict };
    }

    updateBooking(booking.id, {
      starts_at: startsAtIso,
      duration_min: durationMin,
      total_cost_cents: input.totalCostCents ?? booking.total_cost_cents,
      min_players: minPlayers,
      max_players: maxPlayers,
      place_id: placeId,
      custom_place: placeId ? null : customPlace,
      court: input.court !== undefined ? input.court : booking.court,
      notes: input.notes !== undefined ? input.notes : booking.notes,
      cancel_limit_hours: input.cancelLimitHours ?? booking.cancel_limit_hours,
    });

    // Shrinking the maximum can leave more players confirmed than seats; the
    // reverse frees seats the waiting list should immediately fill.
    const updated = findBookingById(booking.id)!;
    while (promoteFromWaitlist(updated) != null) {
      /* keep promoting until the court is full or the queue is empty */
    }

    return {
      ok: true,
      booking: findBookingById(booking.id)!,
      scheduleChanged,
      previousStartsAt: booking.starts_at,
    };
  });
}

/** Everyone who should hear that a booking changed. */
export function affectedUserIds(bookingId: number): number[] {
  const roster = getRoster(bookingId);
  return [...roster.confirmed, ...roster.waitlist].map((p) => p.user_id);
}

export function updateBooking(id: number, patch: Partial<Booking>): void {
  const allowed: (keyof Booking)[] = [
    'payer_id', 'place_id', 'custom_place', 'court', 'starts_at', 'duration_min',
    'total_cost_cents', 'min_players', 'max_players', 'cancel_limit_hours', 'notes', 'status',
  ];
  const fields = allowed.filter((k) => patch[k] !== undefined);
  if (fields.length === 0) return;

  const setClause = fields.map((k) => `${k} = ?`).join(', ');
  const values = fields.map((k) => patch[k] as string | number | null);
  run(`UPDATE bookings SET ${setClause} WHERE id = ?`, ...values, id);
}

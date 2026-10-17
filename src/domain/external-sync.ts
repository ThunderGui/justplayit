import { updateBooking, type Booking } from './bookings.js';
import { run } from '../db/index.js';
import { nowIso } from '../util/datetime.js';
import { providerFor } from '../providers/index.js';
import type { ExternalMatch } from '../providers/index.js';
import { logger } from '../util/logger.js';

/**
 * Pulls live data for an external booking (Playtomic etc.) and stores it on the
 * row. The roster, court, slots and status are cached in the booking's
 * external_* columns so the list and card render without a network call every
 * time; a periodic refresh keeps them current.
 *
 * Money is never synced — that stays on the platform, by design.
 */

export type SyncOutcome =
  | { ok: true; match: ExternalMatch; cancelled?: boolean }
  | { ok: false; reason: string; cancelled?: boolean };

/** The platform saying, in any of its words, that the match is off. */
function isCancelledStatus(status: string | null): boolean {
  return status != null && /cancel|terminat|abgesagt|annull/i.test(status);
}

function markCancelled(bookingId: number): void {
  run("UPDATE bookings SET status = 'CANCELLED' WHERE id = ? AND status = 'OPEN'", bookingId);
}

export async function syncExternalBooking(booking: Booking): Promise<SyncOutcome> {
  if (booking.kind !== 'EXTERNAL' || !booking.external_url) {
    return { ok: false, reason: 'not_external' };
  }

  const provider = providerFor(booking.external_url);
  if (!provider) return { ok: false, reason: 'no_provider' };

  const result = await provider.fetch(booking.external_url);

  if (!result.ok) {
    // A match that 404s is gone from the platform. Treat it as cancelled — but
    // only on the *second* consecutive miss, so a transient blip does not wipe
    // a real booking. The first miss just records the error.
    if (result.reason === 'not_found') {
      if (booking.external_sync_error === 'not_found') {
        markCancelled(booking.id);
        return { ok: false, reason: 'not_found', cancelled: true };
      }
      updateBooking(booking.id, { external_sync_error: 'not_found' });
      return { ok: false, reason: 'not_found' };
    }
    // Record the failure so the UI can show "could not refresh" rather than
    // silently serving stale data, but keep whatever was there before.
    updateBooking(booking.id, { external_sync_error: result.reason });
    return { ok: false, reason: result.reason };
  }

  const m = result.match;

  // The platform explicitly reports it cancelled/terminated — act immediately.
  if (isCancelledStatus(m.status)) {
    updateBooking(booking.id, { external_status: m.status, external_synced_at: nowIso(), external_sync_error: null });
    markCancelled(booking.id);
    return { ok: true, match: m, cancelled: true };
  }

  updateBooking(booking.id, {
    external_provider: m.provider,
    external_status: m.status,
    external_players: JSON.stringify(m.players),
    external_slots_total: m.slotsTotal,
    external_slots_free: m.slotsFree,
    external_synced_at: nowIso(),
    external_sync_error: null,
    // Fill venue/court/time from the platform when the user did not supply them.
    court: booking.court ?? m.court,
    custom_place: booking.place_id ? null : (booking.custom_place ?? m.venueName),
    starts_at: m.startsAtIso ?? booking.starts_at,
    duration_min: durationFrom(m) ?? booking.duration_min,
  });

  logger.info({ code: booking.code, provider: m.provider }, 'synced external booking');
  return { ok: true, match: m };
}

function durationFrom(m: ExternalMatch): number | null {
  if (!m.startsAtIso || !m.endsAtIso) return null;
  const mins = (Date.parse(m.endsAtIso) - Date.parse(m.startsAtIso)) / 60000;
  return mins > 0 && mins < 600 ? Math.round(mins) : null;
}

/** The cached player list, parsed back from storage. */
export function externalPlayers(booking: Booking): string[] {
  if (!booking.external_players) return [];
  try {
    const parsed = JSON.parse(booking.external_players) as unknown;
    return Array.isArray(parsed) ? parsed.filter((p): p is string => typeof p === 'string') : [];
  } catch {
    return [];
  }
}

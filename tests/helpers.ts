import { DateTime } from 'luxon';
import { closeDb, initTestDb } from '../src/db/index.js';
import { createBooking, type Booking } from '../src/domain/bookings.js';
import { createPlace } from '../src/domain/places.js';
import { invalidateSettings, setSettings, type Settings } from '../src/domain/settings.js';
import { upsertUser, type User } from '../src/domain/users.js';

export function freshDb(settings: Partial<Settings> = {}): void {
  closeDb();
  initTestDb();
  invalidateSettings();
  setSettings({ timezone: 'Europe/Berlin', currency: 'EUR', ...settings });
}

export function user(name: string): User {
  // Deterministic per-name JID so repeated calls return the same person.
  const digits = String(4915000000 + hash(name)).slice(0, 12);
  return upsertUser(`${digits}@s.whatsapp.net`, name);
}

function hash(s: string): number {
  let h = 0;
  for (const ch of s) h = (h * 31 + ch.charCodeAt(0)) % 1_000_000;
  return h;
}

export function inHours(hours: number): string {
  return DateTime.utc().plus({ hours }).toISO()!;
}

/** Creates an OPEN booking with sensible defaults; overrides win. */
export function booking(
  creator: User,
  overrides: Partial<{
    startsAtIso: string;
    totalCostCents: number;
    minPlayers: number;
    maxPlayers: number;
    cancelLimitHours: number;
    durationMin: number;
    joinAsPlayer: boolean;
  }> = {},
): Booking {
  const place = createPlace({ name: `Club ${Math.random().toString(36).slice(2, 8)}` });
  const maxPlayers = overrides.maxPlayers ?? 4;
  const result = createBooking({
    creator,
    placeId: place.id,
    startsAtIso: overrides.startsAtIso ?? inHours(72),
    totalCostCents: overrides.totalCostCents ?? 4000,
    // Keep min <= max when a test only overrides one of the two.
    minPlayers: overrides.minPlayers ?? Math.min(4, maxPlayers),
    maxPlayers,
    cancelLimitHours: overrides.cancelLimitHours ?? 24,
    durationMin: overrides.durationMin ?? 90,
    joinAsPlayer: overrides.joinAsPlayer ?? true,
  });
  if (!result.ok) throw new Error(`booking() failed: ${result.reason}`);
  return result.booking;
}

import { DateTime } from 'luxon';
import { closeDb, initTestDb } from '../src/db/index.js';
import { ensureGroup, ensureMember, updateGroup, type Sport } from '../src/domain/groups.js';
import { createBooking, type Booking } from '../src/domain/bookings.js';
import { createPlace } from '../src/domain/places.js';
import { invalidateSettings, setSettings, type Settings } from '../src/domain/settings.js';
import { upsertUser, type User } from '../src/domain/users.js';

/**
 * The group every helper works in unless a test says otherwise. Migration 4
 * creates group 1 from whatever this install was bound to, so tests inherit the
 * same shape a real upgrade produces.
 */
export const GROUP = 1;

export function freshDb(settings: Partial<Settings> = {}, sport: Sport = 'padel'): void {
  closeDb();
  initTestDb();
  invalidateSettings();
  if (sport !== 'padel') {
    updateGroup(GROUP, { sport });
    invalidateSettings(GROUP);
  }
  setSettings({ timezone: 'Europe/Berlin', currency: 'EUR', ...settings }, GROUP);
}

/** A second, independent group, for proving that nothing leaks between them. */
export function otherGroup(name = 'Other group', sport: Sport = 'padel'): number {
  const g = ensureGroup(`other-${name.replace(/\W/g, '')}@g.us`, name);
  updateGroup(g.id, { sport });
  invalidateSettings(g.id);
  return g.id;
}

export function user(name: string, groupId: number = GROUP): User {
  // Deterministic per-name JID so repeated calls return the same person.
  const digits = String(4915000000 + hash(name)).slice(0, 12);
  const u = upsertUser(`${digits}@s.whatsapp.net`, name);
  ensureMember(groupId, u.id);
  return u;
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
    groupId: number;
    startsAtIso: string;
    totalCostCents: number;
    minPlayers: number;
    maxPlayers: number;
    cancelLimitHours: number;
    durationMin: number;
    joinAsPlayer: boolean;
  }> = {},
): Booking {
  const groupId = overrides.groupId ?? GROUP;
  const place = createPlace({
    groupId,
    name: `Club ${Math.random().toString(36).slice(2, 8)}`,
  });
  const maxPlayers = overrides.maxPlayers ?? 4;
  const result = createBooking({
    groupId,
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

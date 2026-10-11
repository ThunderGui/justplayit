import { many, one, run } from '../db/index.js';
import { findGroupById } from './groups.js';

export type Lang = 'en' | 'de' | 'pt';

/**
 * Who is allowed to turn a "I paid you" claim into a ledger entry.
 *
 *  - receiver: only the person receiving the money may confirm. A sender's
 *              claim waits for them to approve it.
 *  - both:     either party may confirm on their own (the default).
 *  - dual:     neither party may confirm alone — whoever claims, the other one
 *              has to approve. The strictest setting, and the only one where a
 *              payment always carries two people's word.
 *  - anyone:   any group member may confirm (loosest).
 *
 * An admin can always confirm, in every mode.
 */
export type PaymentConfirmationMode = 'receiver' | 'both' | 'dual' | 'anyone';

export interface Settings {
  language: Lang;
  timezone: string;
  currency: string;
  commandPrefix: string;
  paymentConfirmationMode: PaymentConfirmationMode;
  allowCustomPlaces: boolean;
  defaultCancelLimitHours: number;
  allowPerBookingCancelLimit: boolean;
  requirePaymentProof: boolean;
  paymentDeadlineDays: number;
  defaultDurationMin: number;
  defaultMinPlayers: number;
  defaultMaxPlayers: number;
  /** Hours before start to nudge the group about unfilled slots. 0 disables. */
  reminderHoursBefore: number;
  /** Retention window for message-processing records, in days (GDPR). */
  dataRetentionDays: number;
  /** How many daily database snapshots to keep. 0 disables backups. */
  backupKeepDays: number;
}

export const DEFAULT_SETTINGS: Settings = {
  language: 'en',
  timezone: 'Europe/Berlin',
  currency: 'EUR',
  commandPrefix: '!',
  paymentConfirmationMode: 'both',
  allowCustomPlaces: true,
  defaultCancelLimitHours: 24,
  allowPerBookingCancelLimit: true,
  requirePaymentProof: false,
  paymentDeadlineDays: 7,
  defaultDurationMin: 90,
  defaultMinPlayers: 4,
  defaultMaxPlayers: 4,
  reminderHoursBefore: 26,
  dataRetentionDays: 90,
  backupKeepDays: 14,
};

/** Court sizes differ by sport; see domain/groups.ts for the canonical table. */
const SPORT_DEFAULTS: Record<string, { min: number; max: number }> = {
  padel: { min: 4, max: 4 },
  tennis: { min: 2, max: 4 },
  squash: { min: 2, max: 2 },
  badminton: { min: 2, max: 4 },
  other: { min: 2, max: 4 },
};

type Key = keyof Settings;

const SERIALISERS: { [K in Key]: (v: Settings[K]) => string } = {
  language: (v) => v,
  timezone: (v) => v,
  currency: (v) => v,
  commandPrefix: (v) => v,
  paymentConfirmationMode: (v) => v,
  allowCustomPlaces: (v) => (v ? '1' : '0'),
  defaultCancelLimitHours: (v) => String(v),
  allowPerBookingCancelLimit: (v) => (v ? '1' : '0'),
  requirePaymentProof: (v) => (v ? '1' : '0'),
  paymentDeadlineDays: (v) => String(v),
  defaultDurationMin: (v) => String(v),
  defaultMinPlayers: (v) => String(v),
  defaultMaxPlayers: (v) => String(v),
  reminderHoursBefore: (v) => String(v),
  dataRetentionDays: (v) => String(v),
  backupKeepDays: (v) => String(v),
};

function parseValue<K extends Key>(key: K, raw: string): Settings[K] {
  const fallback = DEFAULT_SETTINGS[key];
  if (typeof fallback === 'boolean') return (raw === '1' || raw === 'true') as Settings[K];
  if (typeof fallback === 'number') {
    const n = Number(raw);
    return (Number.isFinite(n) ? n : fallback) as Settings[K];
  }
  return raw as Settings[K];
}

/**
 * Settings are read on nearly every message, so they are cached per group and
 * invalidated on write. The admin UI runs in the same process, so invalidating
 * the one group that changed is enough.
 *
 * Every group gets its own row set, which is what keeps groups independent:
 * one can run in German with a 48h cancellation window while another runs in
 * Portuguese with 12h, and neither can see the other's settings.
 */
const cache = new Map<number, Settings>();

/** The group whose settings a bare call applies to. Set per message. */
export const DEFAULT_GROUP_ID = 1;

export function getSettings(groupId: number = DEFAULT_GROUP_ID): Settings {
  const cached = cache.get(groupId);
  if (cached) return cached;

  const rows = many<{ key: string; value: string }>(
    'SELECT key, value FROM settings WHERE group_id = ?',
    groupId,
  );

  const result = { ...DEFAULT_SETTINGS };

  // A tennis group should not have to hand-correct a padel-shaped roster, so
  // the sport supplies the default player counts before stored values apply.
  const sport = findGroupById(groupId)?.sport;
  if (sport) {
    const perSport = SPORT_DEFAULTS[sport];
    if (perSport) {
      result.defaultMinPlayers = perSport.min;
      result.defaultMaxPlayers = perSport.max;
    }
  }

  for (const { key, value } of rows) {
    if (key in DEFAULT_SETTINGS) {
      const k = key as Key;
      (result as Record<string, unknown>)[k] = parseValue(k, value);
    }
  }

  cache.set(groupId, result);
  return result;
}

export function getSetting<K extends Key>(key: K, groupId: number = DEFAULT_GROUP_ID): Settings[K] {
  return getSettings(groupId)[key];
}

export function setSetting<K extends Key>(
  key: K,
  value: Settings[K],
  groupId: number = DEFAULT_GROUP_ID,
): void {
  const serialised = (SERIALISERS[key] as (v: Settings[K]) => string)(value);
  run(
    `INSERT INTO settings (group_id, key, value, updated_at) VALUES (?, ?, ?, ?)
     ON CONFLICT(group_id, key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
    groupId,
    key,
    serialised,
    new Date().toISOString(),
  );
  invalidateSettings(groupId);
}

export function setSettings(patch: Partial<Settings>, groupId: number = DEFAULT_GROUP_ID): void {
  for (const [key, value] of Object.entries(patch)) {
    if (value === undefined) continue;
    setSetting(key as Key, value as never, groupId);
  }
}

export function invalidateSettings(groupId?: number): void {
  if (groupId === undefined) cache.clear();
  else cache.delete(groupId);
}

/** True once this group has an admin who can run privileged commands. */
export function isConfigured(groupId: number = DEFAULT_GROUP_ID): boolean {
  return (
    one('SELECT 1 AS x FROM group_members WHERE group_id = ? AND is_admin = 1', groupId) != null
  );
}

import { DateTime } from 'luxon';
import type { Lang } from '../domain/settings.js';

/** Weekday words we accept in each supported language, mapped to Luxon 1..7 (Mon..Sun). */
const WEEKDAYS: Record<string, number> = {
  mon: 1, monday: 1, montag: 1, mo: 1, seg: 1, segunda: 1, 'segunda-feira': 1,
  tue: 2, tues: 2, tuesday: 2, dienstag: 2, di: 2, ter: 2, terca: 2, 'terça': 2,
  wed: 3, weds: 3, wednesday: 3, mittwoch: 3, mi: 3, qua: 3, quarta: 3,
  thu: 4, thur: 4, thurs: 4, thursday: 4, donnerstag: 4, do: 4, qui: 4, quinta: 4,
  fri: 5, friday: 5, freitag: 5, fr: 5, sex: 5, sexta: 5,
  sat: 6, saturday: 6, samstag: 6, sa: 6, sab: 6, 'sábado': 6, sabado: 6,
  sun: 7, sunday: 7, sonntag: 7, so: 7, dom: 7, domingo: 7,
};

const TODAY_WORDS = new Set(['today', 'heute', 'hoje']);
const TOMORROW_WORDS = new Set(['tomorrow', 'morgen', 'amanha', 'amanhã']);

/**
 * Parses the date half of a booking. Accepts, in the group's timezone:
 *   2026-09-03 | 03/09 | 03/09/2026 | 3.9. | 3.9.2026 | today | tomorrow | friday
 *
 * Bare day/month dates roll forward to the next occurrence — nobody books a
 * court in the past, and "03/09" in December means next year.
 */
export function parseDate(input: string, timezone: string, now?: DateTime): DateTime | null {
  const ref = (now ?? DateTime.now()).setZone(timezone).startOf('day');
  const raw = input.trim().toLowerCase();
  if (!raw) return null;

  if (TODAY_WORDS.has(raw)) return ref;
  if (TOMORROW_WORDS.has(raw)) return ref.plus({ days: 1 });

  const weekday = WEEKDAYS[raw];
  if (weekday) {
    const delta = (weekday - ref.weekday + 7) % 7;
    // "friday" said on a Friday means the Friday a week out, not today.
    return ref.plus({ days: delta === 0 ? 7 : delta });
  }

  // ISO: 2026-09-03
  const iso = raw.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/);
  if (iso) {
    const dt = DateTime.fromObject(
      { year: +iso[1]!, month: +iso[2]!, day: +iso[3]! },
      { zone: timezone },
    );
    return dt.isValid ? dt : null;
  }

  // Day-first: 03/09, 3.9., 03-09-2026, 3/9/26
  const dayFirst = raw.match(/^(\d{1,2})[./-](\d{1,2})(?:[./-](\d{2}|\d{4}))?\.?$/);
  if (dayFirst) {
    const day = +dayFirst[1]!;
    const month = +dayFirst[2]!;
    const yearPart = dayFirst[3];

    let year: number;
    if (yearPart) {
      year = yearPart.length === 2 ? 2000 + +yearPart : +yearPart;
    } else {
      year = ref.year;
    }

    let dt = DateTime.fromObject({ year, month, day }, { zone: timezone });
    if (!dt.isValid) return null;
    // Roll a bare day/month forward rather than booking into the past.
    if (!yearPart && dt < ref) dt = dt.plus({ years: 1 });
    return dt;
  }

  return null;
}

/** Accepts 19:00 | 19.00 | 19h | 19h30 | 1900 | 7pm | 7:30pm */
export function parseTime(input: string): { hour: number; minute: number } | null {
  const raw = input.trim().toLowerCase().replace(/\s+/g, '');
  if (!raw) return null;

  const ampm = raw.match(/^(\d{1,2})(?::(\d{2}))?(am|pm)$/);
  if (ampm) {
    let hour = +ampm[1]!;
    const minute = ampm[2] ? +ampm[2] : 0;
    if (hour < 1 || hour > 12 || minute > 59) return null;
    if (ampm[3] === 'pm' && hour !== 12) hour += 12;
    if (ampm[3] === 'am' && hour === 12) hour = 0;
    return { hour, minute };
  }

  const sep = raw.match(/^(\d{1,2})[:.h](\d{2})?$/);
  if (sep) {
    const hour = +sep[1]!;
    const minute = sep[2] ? +sep[2] : 0;
    return hour <= 23 && minute <= 59 ? { hour, minute } : null;
  }

  const compact = raw.match(/^(\d{3,4})$/);
  if (compact) {
    const digits = compact[1]!.padStart(4, '0');
    const hour = +digits.slice(0, 2);
    const minute = +digits.slice(2);
    return hour <= 23 && minute <= 59 ? { hour, minute } : null;
  }

  const hourOnly = raw.match(/^(\d{1,2})$/);
  if (hourOnly) {
    const hour = +hourOnly[1]!;
    return hour <= 23 ? { hour, minute: 0 } : null;
  }

  return null;
}

export function parseDateTime(
  dateInput: string,
  timeInput: string,
  timezone: string,
  now?: DateTime,
): DateTime | null {
  const date = parseDate(dateInput, timezone, now);
  const time = parseTime(timeInput);
  if (!date || !time) return null;
  const dt = date.set({ hour: time.hour, minute: time.minute, second: 0, millisecond: 0 });
  return dt.isValid ? dt : null;
}

/** Parses "90", "90m", "1h", "1h30", "1.5h" into minutes. */
export function parseDuration(input: string): number | null {
  const raw = input.trim().toLowerCase().replace(/\s+/g, '');
  const hm = raw.match(/^(\d+)h(\d{1,2})?$/);
  if (hm) return +hm[1]! * 60 + (hm[2] ? +hm[2] : 0);

  const decimalHours = raw.match(/^(\d+(?:[.,]\d+)?)h$/);
  if (decimalHours) return Math.round(Number(decimalHours[1]!.replace(',', '.')) * 60);

  const minutes = raw.match(/^(\d+)(?:m|min)?$/);
  if (minutes) return +minutes[1]!;

  return null;
}

const LOCALES: Record<Lang, string> = { en: 'en-GB', de: 'de-DE', pt: 'pt-PT' };

export function formatDateTime(isoUtc: string, timezone: string, lang: Lang = 'en'): string {
  return DateTime.fromISO(isoUtc, { zone: 'utc' })
    .setZone(timezone)
    .setLocale(LOCALES[lang])
    .toFormat("ccc dd LLL, HH:mm");
}

export function formatDayHeading(isoUtc: string, timezone: string, lang: Lang = 'en'): string {
  return DateTime.fromISO(isoUtc, { zone: 'utc' })
    .setZone(timezone)
    .setLocale(LOCALES[lang])
    .toFormat('cccc dd LLLL');
}

/** Human-friendly "in 3h 20m" / "2d 4h" used by deadline messages. */
export function formatRelative(fromIso: string, toIso: string): string {
  const from = DateTime.fromISO(fromIso, { zone: 'utc' });
  const to = DateTime.fromISO(toIso, { zone: 'utc' });
  const diff = to.diff(from, ['days', 'hours', 'minutes']).toObject();
  const days = Math.floor(diff.days ?? 0);
  const hours = Math.floor(diff.hours ?? 0);
  const minutes = Math.floor(diff.minutes ?? 0);
  if (days > 0) return `${days}d ${hours}h`;
  if (hours > 0) return `${hours}h ${minutes}m`;
  return `${Math.max(minutes, 0)}m`;
}

export function nowIso(): string {
  return DateTime.utc().toISO()!;
}

export function toUtcIso(dt: DateTime): string {
  return dt.toUTC().toISO()!;
}

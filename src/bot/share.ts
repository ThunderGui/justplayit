import { DateTime } from 'luxon';

/**
 * Parses a match shared directly from the Playtomic or Padelcity app into a
 * WhatsApp group. The apps localise the words (month and weekday names, "min.")
 * but the *structure* is stable in every language: a link that names the
 * platform, and lines led by fixed emojis — 📅 date/time, 📍 venue, 🎾 court,
 * ✅ a confirmed player, ❓/⚪ a free slot. So we key off the link, the emojis
 * and the digits, never the words, which keeps it working for an international
 * group. The one localised thing we must read, the month, is matched against a
 * multi-language table, with a language-free fallback (next date with that
 * day-of-month) when the month word is unknown.
 *
 * This reads only the text the user posted in their own group. It never calls
 * any platform API — for Padelcity that is the only source of truth; Playtomic
 * shares are enriched separately by the real provider fetch.
 */

export type SharePlatform = 'Playtomic' | 'Padelcity';

export interface SharedMatch {
  platform: SharePlatform;
  url: string;
  venue: string | null;
  court: string | null;
  startsAtIso: string | null;
  durationMin: number | null;
  players: string[];
  slotsTotal: number | null;
  slotsFree: number | null;
}

const PLAYTOMIC_URL = /https?:\/\/\S*playtomic\.(?:com|io)\/\S+/i;
const PADELCITY_URL = /https?:\/\/\S*padelcity\.\S+/i;

/** Finds a Playtomic or Padelcity match link anywhere in a message. */
export function findShareLink(text: string): { platform: SharePlatform; url: string } | null {
  const pt = text.match(PLAYTOMIC_URL);
  if (pt) return { platform: 'Playtomic', url: stripTrailing(pt[0]) };
  const pc = text.match(PADELCITY_URL);
  if (pc) return { platform: 'Padelcity', url: stripTrailing(pc[0]) };
  return null;
}

function stripTrailing(url: string): string {
  return url.replace(/[)\].,;]+$/, '');
}

/** De-accents and lowercases, so "März", "Août", "março" all match plainly. */
function fold(s: string): string {
  return s
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '')
    .toLowerCase();
}

// Month tokens across the languages a padel group is likely to mix (en, de, pt,
// es, fr, it, nl), de-accented. Longest-first within a month does not matter —
// any token present picks that month. A date line is short and date-shaped, so
// a bare "mar"/"set"/"mai" is safe (the venue "…am Main" lives on the 📍 line).
const MONTHS: string[][] = [
  ['january', 'januar', 'janeiro', 'enero', 'janvier', 'gennaio', 'januari', 'jan'],
  ['february', 'februar', 'fevereiro', 'febrero', 'fevrier', 'febbraio', 'februari', 'feb', 'fev'],
  ['march', 'marz', 'marco', 'marzo', 'mars', 'maart', 'mar'],
  ['april', 'abril', 'avril', 'aprile', 'apr', 'abr', 'avr'],
  ['may', 'mai', 'maio', 'mayo', 'maggio', 'mei', 'mag'],
  ['june', 'juni', 'junho', 'junio', 'juin', 'giugno', 'jun'],
  ['july', 'juli', 'julho', 'julio', 'juillet', 'luglio', 'jul'],
  ['august', 'agosto', 'aout', 'augustus', 'aug', 'ago'],
  ['september', 'setembro', 'septiembre', 'septembre', 'settembre', 'sep', 'set', 'sept'],
  ['october', 'oktober', 'outubro', 'octubre', 'octobre', 'ottobre', 'oct', 'okt', 'out', 'ott'],
  ['november', 'novembro', 'noviembre', 'novembre', 'nov'],
  ['december', 'dezember', 'dezembro', 'diciembre', 'decembre', 'dicembre', 'dec', 'dez', 'dic'],
];

/** 1-12 if a known month word is present on the line, else null. */
function monthFrom(dateLine: string): number | null {
  const folded = fold(dateLine);
  for (let i = 0; i < MONTHS.length; i++) {
    for (const token of MONTHS[i]!) {
      if (new RegExp(`(^|[^a-z])${token}([^a-z]|$)`).test(folded)) return i + 1;
    }
  }
  return null;
}

/**
 * Resolves the 📅 line to an absolute start time in the group's timezone.
 * Reads the start time (HH:MM) and the day-of-month from digits, and the month
 * from the multi-language table; when the month word is unknown it falls back
 * to the next future date carrying that day-of-month. Returns null if there is
 * no usable time or day.
 */
function parseDate(dateLine: string, tz: string, now: DateTime): DateTime | null {
  // Handle both 24h ("16:00") and 12h ("7:30 pm") — the English app uses the latter.
  const time = dateLine.match(/(\d{1,2}):(\d{2})\s*(a\.?m\.?|p\.?m\.?)?/i);
  if (!time) return null;
  let hour = Number(time[1]);
  const minute = Number(time[2]);
  const meridiem = time[3]?.toLowerCase();
  if (meridiem?.startsWith('p') && hour < 12) hour += 12;
  if (meridiem?.startsWith('a') && hour === 12) hour = 0;
  if (hour > 23 || minute > 59) return null;

  // Day-of-month: the first 1–2 digit number once times and parentheticals (the
  // duration) are removed.
  const dayText = dateLine.replace(/\d{1,2}:\d{2}/g, ' ').replace(/\([^)]*\)/g, ' ');
  const dayMatch = dayText.match(/\b(\d{1,2})\b/);
  if (!dayMatch) return null;
  const day = Number(dayMatch[1]);
  if (day < 1 || day > 31) return null;

  const month = monthFrom(dateLine);
  const atTime = { hour, minute, second: 0, millisecond: 0 };

  if (month != null) {
    let dt = now.setZone(tz).set({ month, day, ...atTime });
    // Past by more than a few hours → it means next year.
    if (dt < now.minus({ hours: 6 })) dt = dt.plus({ years: 1 });
    return dt.isValid ? dt : null;
  }

  // No month word understood: walk forward to the next date with this day.
  let dt = now.setZone(tz).set({ day, ...atTime });
  for (let i = 0; i < 13 && (!dt.isValid || dt.day !== day || dt < now.minus({ hours: 6 })); i++) {
    dt = now.setZone(tz).plus({ months: i + 1 }).set({ day, ...atTime });
  }
  return dt.isValid && dt.day === day ? dt : null;
}

const CONFIRMED = /✅/u;
const FREE = /[❓⚪]/u;

/** Strips a leading status emoji and a trailing "(level)" to get a clean name. */
function playerName(line: string): string {
  return line
    .replace(/^[^\p{L}(]*?[✅]\s*/u, '')
    .replace(/\s*\([^)]*\)\s*$/u, '')
    .trim();
}

/**
 * Parses a shared match message. Returns null if it carries no recognisable
 * match link. Fields that are not present in the text come back null/empty.
 */
export function parseSharedMatch(
  text: string,
  tz: string,
  now: DateTime = DateTime.utc(),
): SharedMatch | null {
  const link = findShareLink(text);
  if (!link) return null;

  let venue: string | null = null;
  let court: string | null = null;
  let startsAtIso: string | null = null;
  let durationMin: number | null = null;
  const players: string[] = [];
  let freeSlots = 0;
  let filledSlots = 0;

  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;

    if (line.includes('📅')) {
      const dt = parseDate(line, tz, now);
      if (dt) startsAtIso = dt.toUTC().toISO();
      const dur = line.match(/\(\s*(\d{2,3})\s*m/i);
      if (dur) durationMin = Number(dur[1]);
      continue;
    }
    if (line.includes('📍') && !venue) {
      venue = line.replace(/^[^\p{L}]*📍\s*/u, '').trim() || null;
      continue;
    }
    if (line.includes('🎾') && !court) {
      court = line.replace(/^[^\p{L}]*🎾\s*/u, '').trim() || null;
      continue;
    }
    if (CONFIRMED.test(line)) {
      const name = playerName(line);
      if (name) players.push(name);
      filledSlots++;
      continue;
    }
    if (FREE.test(line)) {
      freeSlots++;
      continue;
    }
  }

  const slotsTotal = filledSlots + freeSlots > 0 ? filledSlots + freeSlots : null;
  const slotsFree = slotsTotal != null ? freeSlots : null;

  return {
    platform: link.platform,
    url: link.url,
    venue,
    court,
    startsAtIso,
    durationMin,
    players,
    slotsTotal,
    slotsFree,
  };
}

/** A stable id for a shared match, so re-shares with different tracking query
 *  params still deduplicate: the code/uuid in the link's path. */
export function matchKey(url: string): string {
  const m = url.match(/\/(?:t|match|matches)\/([A-Za-z0-9-]{6,})/i);
  if (m) return m[1]!;
  const path = (url.split('?')[0] ?? url).replace(/\/+$/, '');
  return path.split('/').pop() ?? url;
}

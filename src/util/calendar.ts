import { DateTime } from 'luxon';

export interface CalendarEvent {
  uid: string;
  title: string;
  startIsoUtc: string;
  durationMin: number;
  location?: string | null;
  description?: string | null;
  url?: string | null;
}

function stamp(iso: string): string {
  return DateTime.fromISO(iso, { zone: 'utc' }).toFormat("yyyyLLdd'T'HHmmss'Z'");
}

/**
 * A Google Calendar template link. Chosen as the default "add to calendar"
 * because it opens natively on Android and in any browser without the bot
 * needing a publicly reachable URL to serve an .ics file from.
 */
export function googleCalendarUrl(event: CalendarEvent): string {
  const end = DateTime.fromISO(event.startIsoUtc, { zone: 'utc' }).plus({
    minutes: event.durationMin,
  });

  const params = new URLSearchParams({
    action: 'TEMPLATE',
    text: event.title,
    dates: `${stamp(event.startIsoUtc)}/${stamp(end.toISO()!)}`,
  });
  if (event.description) params.set('details', event.description);
  if (event.location) params.set('location', event.location);

  return `https://calendar.google.com/calendar/render?${params.toString()}`;
}

/** RFC 5545 escaping: commas, semicolons, backslashes and newlines. */
function escapeIcs(value: string): string {
  return value
    .replace(/\\/g, '\\\\')
    .replace(/;/g, '\\;')
    .replace(/,/g, '\\,')
    .replace(/\r?\n/g, '\\n');
}

/** Folds long lines to the 75-octet limit that strict parsers enforce. */
function fold(line: string): string {
  if (line.length <= 75) return line;
  const parts: string[] = [line.slice(0, 75)];
  for (let i = 75; i < line.length; i += 74) parts.push(` ${line.slice(i, i + 74)}`);
  return parts.join('\r\n');
}

export function buildIcs(event: CalendarEvent): string {
  const end = DateTime.fromISO(event.startIsoUtc, { zone: 'utc' }).plus({
    minutes: event.durationMin,
  });

  const lines = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//Just Play It//EN',
    'CALSCALE:GREGORIAN',
    'METHOD:PUBLISH',
    'BEGIN:VEVENT',
    `UID:${event.uid}`,
    `DTSTAMP:${stamp(DateTime.utc().toISO()!)}`,
    `DTSTART:${stamp(event.startIsoUtc)}`,
    `DTEND:${stamp(end.toISO()!)}`,
    `SUMMARY:${escapeIcs(event.title)}`,
  ];

  if (event.location) lines.push(`LOCATION:${escapeIcs(event.location)}`);
  if (event.description) lines.push(`DESCRIPTION:${escapeIcs(event.description)}`);
  if (event.url) lines.push(`URL:${escapeIcs(event.url)}`);

  lines.push('END:VEVENT', 'END:VCALENDAR');

  return lines.map(fold).join('\r\n');
}

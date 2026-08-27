import { DateTime } from 'luxon';
import type { Booking } from '../domain/bookings.js';
import {
  cancellationDeadline,
  getRoster,
  isExternal,
  placeAddress,
  placeLabel,
} from '../domain/bookings.js';
import type { PairBalance } from '../domain/ledger.js';
import { getSettings } from '../domain/settings.js';
import { displayName, findUserById } from '../domain/users.js';
import type { Dict } from '../i18n/index.js';
import { googleCalendarUrl } from '../util/calendar.js';
import { formatDateTime, formatDayHeading } from '../util/datetime.js';
import { formatMoney } from '../util/money.js';

/**
 * WhatsApp markdown: *bold*, _italic_, ```mono```. Kept deliberately sparse —
 * these messages are read on a phone, in a busy group chat.
 */

export function bookingTitle(booking: Booking): string {
  return `Padel — ${placeLabel(booking)}`;
}

export function calendarLink(booking: Booking): string {
  // For an external booking the platform's own page is the more useful link.
  if (isExternal(booking) && booking.external_url) return booking.external_url;

  return googleCalendarUrl({
    uid: `justplayit-${booking.code}`,
    title: bookingTitle(booking),
    startIsoUtc: booking.starts_at,
    durationMin: booking.duration_min,
    location: placeAddress(booking),
    description: `Booking ${booking.code}`,
  });
}

/** The full detail card, used on create/join and on `show <id>`. */
export function bookingCard(booking: Booking, dict: Dict): string {
  const settings = getSettings();
  const tz = settings.timezone;
  const lang = settings.language;
  const L = dict.label;

  const lines: string[] = [];

  if (isExternal(booking)) {
    const provider = booking.external_provider ?? 'external';
    lines.push(`*${booking.code}* · ${placeLabel(booking)} · _${provider}_`);
    lines.push(`${L.when}: ${formatDateTime(booking.starts_at, tz, lang)}`);
    if (booking.court) lines.push(`${L.court}: ${booking.court}`);
    if (booking.notes) lines.push(`${L.notes}: ${booking.notes}`);
    lines.push(`${L.link}: ${booking.external_url}`);
    lines.push('');
    lines.push(dict.external.managedNote(provider));
    return lines.join('\n');
  }

  const roster = getRoster(booking.id);
  const confirmed = roster.confirmed;
  const free = booking.max_players - confirmed.length;

  lines.push(`*${booking.code}* · ${placeLabel(booking)}`);
  lines.push(`${L.when}: ${formatDateTime(booking.starts_at, tz, lang)}`);
  if (booking.court) lines.push(`${L.court}: ${booking.court}`);

  lines.push(
    `${L.cost}: ${formatMoney(booking.total_cost_cents, booking.currency)}` +
      ` (${L.perPlayer.toLowerCase()} ~${formatMoney(
        Math.round(booking.total_cost_cents / Math.max(confirmed.length, 1)),
        booking.currency,
      )})`,
  );

  lines.push(
    `${L.players}: ${confirmed.length}/${booking.max_players}` +
      (free > 0 ? ` — ${free} ${L.spotsLeft}` : ` — ${L.full}`),
  );

  lines.push(
    confirmed.length > 0
      ? confirmed.map((p) => `  • ${displayName(findUserById(p.user_id))}`).join('\n')
      : `  _${L.nobodyYet}_`,
  );

  if (roster.waitlist.length > 0) {
    lines.push(`${L.waitlist}:`);
    lines.push(
      roster.waitlist
        .map((p, i) => `  ${i + 1}. ${displayName(findUserById(p.user_id))}`)
        .join('\n'),
    );
  }

  lines.push(`${L.paidBy}: ${displayName(findUserById(booking.payer_id))}`);
  lines.push(
    `${L.freeCancelUntil}: ${formatDateTime(cancellationDeadline(booking), tz, lang)}`,
  );
  if (booking.notes) lines.push(`${L.notes}: ${booking.notes}`);

  lines.push('');
  lines.push(`${L.addToCalendar}: ${calendarLink(booking)}`);

  return lines.join('\n');
}

/** One compact line per booking, grouped under day headings. */
export function bookingList(bookings: Booking[], dict: Dict): string {
  const settings = getSettings();
  const tz = settings.timezone;
  const lang = settings.language;

  if (bookings.length === 0) return dict.booking.listEmpty;

  const out: string[] = [`*${dict.booking.listHeader}*`];
  let currentDay = '';

  for (const booking of bookings) {
    const day = formatDayHeading(booking.starts_at, tz, lang);
    if (day !== currentDay) {
      out.push('', `_${day}_`);
      currentDay = day;
    }

    const time = DateTime.fromISO(booking.starts_at, { zone: 'utc' })
      .setZone(tz)
      .toFormat('HH:mm');

    if (isExternal(booking)) {
      const provider = booking.external_provider ?? 'external';
      out.push(`*${booking.code}* ${time} · ${placeLabel(booking)} · _${provider}_`);
      out.push(`   ${booking.external_url}`);
      continue;
    }

    const roster = getRoster(booking.id);
    const count = roster.confirmed.length;
    const waiting = roster.waitlist.length > 0 ? ` (+${roster.waitlist.length} ⏳)` : '';
    const status = count >= booking.max_players ? dict.label.full : `${count}/${booking.max_players}`;

    out.push(
      `*${booking.code}* ${time} · ${placeLabel(booking)} · ${status}${waiting}` +
        ` · ${formatMoney(booking.total_cost_cents, booking.currency)}`,
    );
  }

  return out.join('\n');
}

export function balanceCard(balances: PairBalance[], dict: Dict, currency: string): string {
  if (balances.length === 0) return dict.payment.balanceAllClear;

  const owed = balances.filter((b) => b.cents > 0); // I owe them
  const owedToMe = balances.filter((b) => b.cents < 0); // they owe me

  const lines: string[] = [`*${dict.payment.balanceHeader}*`];

  if (owed.length > 0) {
    lines.push('');
    for (const b of owed) {
      lines.push(`  ${dict.payment.youOwe(nameOf(b.otherUserId), formatMoney(b.cents, currency))}`);
    }
    const total = owed.reduce((sum, b) => sum + b.cents, 0);
    if (owed.length > 1) lines.push(`  ${dict.payment.totalOwed(formatMoney(total, currency))}`);
  }

  if (owedToMe.length > 0) {
    lines.push('');
    for (const b of owedToMe) {
      lines.push(
        `  ${dict.payment.owesYou(nameOf(b.otherUserId), formatMoney(-b.cents, currency))}`,
      );
    }
    const total = owedToMe.reduce((sum, b) => sum - b.cents, 0);
    if (owedToMe.length > 1) {
      lines.push(`  ${dict.payment.totalOwedToYou(formatMoney(total, currency))}`);
    }
  }

  return lines.join('\n');
}

function nameOf(userId: number): string {
  return displayName(findUserById(userId));
}

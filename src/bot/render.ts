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

  // Dividing by the players confirmed so far reads "€40.00 each" on a brand new
  // booking, where the creator is the only one on the sheet — technically true,
  // useless in practice, and alarming to read. The figure people actually want
  // is the expected split: the minimum the group is planning for, or the real
  // headcount once it grows past that.
  const expectedPlayers = Math.max(confirmed.length, booking.min_players);
  lines.push(
    `${L.cost}: ${formatMoney(booking.total_cost_cents, booking.currency)} · ` +
      dict.payment.perPlayerEstimate(
        formatMoney(Math.round(booking.total_cost_cents / expectedPlayers), booking.currency),
        expectedPlayers,
      ),
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

  if (bookings.length === 0) return dict.booking.listEmpty(settings.commandPrefix);

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
      out.push(...venueLines(booking, dict));
      out.push(`   ${booking.external_url}`);
      if (booking.notes) out.push(`   ${dict.label.notes}: ${booking.notes}`);
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

    out.push(...venueLines(booking, dict));

    // Who is actually in. Comma-separated rather than bulleted, so a list of
    // several games stays scannable in a busy group chat.
    out.push(
      count > 0
        ? `   ${roster.confirmed.map((p) => displayName(findUserById(p.user_id))).join(', ')}`
        : `   _${dict.label.nobodyYet}_`,
    );

    if (booking.notes) out.push(`   ${dict.label.notes}: ${booking.notes}`);
  }

  return out.join('\n');
}

/**
 * Court and address for a list entry, as a single indented line. Returns
 * nothing when there is neither, so no empty line is emitted.
 *
 * The address is skipped when it is the same text as the venue name — which is
 * the case for a free-text place, where the two are literally one field — so
 * the line never repeats what the row above already says.
 */
function venueLines(booking: Booking, dict: Dict): string[] {
  const parts: string[] = [];

  if (booking.court) parts.push(`${dict.label.court} ${booking.court}`);

  const address = placeAddress(booking);
  if (address && address !== placeLabel(booking)) parts.push(address);

  return parts.length > 0 ? [`   ${parts.join(' · ')}`] : [];
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

import { DateTime } from 'luxon';
import { beforeEach, describe, expect, it } from 'vitest';
import { handleCommand, type CommandContext, type OutgoingMessage } from '../src/bot/commands.js';
import { parseMessage } from '../src/bot/parser.js';
import { findBookingById } from '../src/domain/bookings.js';
import { getSettings } from '../src/domain/settings.js';
import { findUserById } from '../src/domain/users.js';
import { t } from '../src/i18n/index.js';
import type { User } from '../src/domain/users.js';
import { GROUP, booking, freshDb, inHours, user } from './helpers.js';

function send(text: string, as: User, isAdmin = false): OutgoingMessage[] {
  const parsed = parseMessage(text, { prefix: '!', prefixOptional: true });
  if (parsed.kind !== 'command') throw new Error('not a command: ' + text);
  return handleCommand(parsed.command, {
    groupId: GROUP, user: as, isAdmin, chatId: 'g', isGroup: true,
    dict: t('en'), settings: getSettings(GROUP), mentionedUserIds: [],
  });
}
const textOf = (m: OutgoingMessage[]) => m.map((x) => x.text).join('\n');

beforeEach(() => freshDb());

describe('.edit (reschedule a booking)', () => {
  it('lets the creator move the time, announcing to the group', () => {
    const alice = user('Alice');
    const b = booking(alice, { startsAtIso: inHours(48) });
    const newDate = DateTime.utc().plus({ days: 3 }).setZone('Europe/Berlin').toFormat('yyyy-LL-dd');

    const out = send(`!edit ${b.code}\ndate: ${newDate}\ntime: 20:00`, alice);
    expect(out.some((m) => m.target === 'group')).toBe(true);
    expect(textOf(out).toLowerCase()).toContain('moved');
    const moved = DateTime.fromISO(findBookingById(b.id)!.starts_at, { zone: 'utc' }).setZone('Europe/Berlin');
    expect(moved.toFormat('HH:mm')).toBe('20:00');
  });

  it('allows a time-only change, keeping the date', () => {
    const alice = user('Alice');
    const b = booking(alice, { startsAtIso: inHours(48) });
    const origDate = DateTime.fromISO(b.starts_at, { zone: 'utc' }).setZone('Europe/Berlin').toFormat('yyyy-LL-dd');
    send(`!edit ${b.code}\ntime: 21:30`, alice);
    const moved = DateTime.fromISO(findBookingById(b.id)!.starts_at, { zone: 'utc' }).setZone('Europe/Berlin');
    expect(moved.toFormat('yyyy-LL-dd')).toBe(origDate);
    expect(moved.toFormat('HH:mm')).toBe('21:30');
  });

  it('refuses someone who is neither creator nor admin', () => {
    const alice = user('Alice');
    const b = booking(alice, { startsAtIso: inHours(48) });
    const out = send(`!edit ${b.code}\ntime: 20:00`, user('Bob'));
    expect(textOf(out).toLowerCase()).toContain('only the person');
  });

  it('updates cost without announcing a reschedule', () => {
    const alice = user('Alice');
    const b = booking(alice, { totalCostCents: 4000 });
    const out = send(`!edit ${b.code}\ncost: 52`, alice);
    expect(out.every((m) => m.target !== 'group')).toBe(true);
    expect(findBookingById(b.id)!.total_cost_cents).toBe(5200);
  });

  it('shows usage with no fields', () => {
    const alice = user('Alice');
    const b = booking(alice);
    expect(textOf(send(`!edit ${b.code}`, alice))).toContain('edit');
  });
});

describe('.payment (your own details)', () => {
  it('sets, shows, and clears the handle', () => {
    const alice = user('Alice');
    expect(textOf(send('!payment', alice))).toContain('no payment details');

    send('!payment paypal.me/alice', alice);
    expect(findUserById(alice.id)!.payment_handle).toBe('paypal.me/alice');
    expect(textOf(send('!payment', alice))).toContain('paypal.me/alice');

    send('!payment clear', alice);
    expect(findUserById(alice.id)!.payment_handle).toBeNull();
  });
});

import { DateTime } from 'luxon';
import { beforeEach, describe, expect, it } from 'vitest';
import { many, one, run } from '../src/db/index.js';
import {
  createExternalBooking,
  findBookingById,
  joinBooking,
  leaveBooking,
  updateBooking,
  type Booking,
} from '../src/domain/bookings.js';
import { balanceFor, settleBooking } from '../src/domain/ledger.js';
import { setSettings } from '../src/domain/settings.js';
import {
  runAutoSettlement,
  runFillReminders,
  runPaymentReminders,
  runRetentionPurge,
  type Notifier,
} from '../src/scheduler/jobs.js';
import { GROUP, booking, freshDb, inHours, user } from './helpers.js';

interface Sent {
  to: 'group' | number;
  text: string;
}

function recorder(): { notifier: Notifier; sent: Sent[] } {
  const sent: Sent[] = [];
  return {
    sent,
    notifier: {
      async sendToGroup(text) {
        sent.push({ to: 'group', text });
      },
      async sendToUser(userId, text) {
        sent.push({ to: userId, text });
      },
    },
  };
}

/**
 * Bookings cannot be created in the past through the normal path, so this
 * moves an existing one backwards the way real time would have.
 */
function moveToPast(b: Booking, hoursAgo: number): Booking {
  updateBooking(b.id, { starts_at: inHours(-hoursAgo) });
  return findBookingById(b.id)!;
}

beforeEach(() => freshDb());

describe('automatic settlement', () => {
  it('splits the cost once the game is over and announces it to the group', async () => {
    const alice = user('Alice');
    const bob = user('Bob');
    const carol = user('Carol');

    const b = booking(alice, { totalCostCents: 3000, minPlayers: 3, maxPlayers: 3 });
    joinBooking(b.code, bob);
    joinBooking(b.code, carol);
    moveToPast(b, 6); // played six hours ago, past the grace period

    const { notifier, sent } = recorder();
    expect(await runAutoSettlement(notifier)).toBe(1);

    expect(findBookingById(b.id)!.status).toBe('SETTLED');
    expect(balanceFor(bob.id, GROUP)).toEqual([{ otherUserId: alice.id, cents: 1000 }]);
    expect(balanceFor(carol.id, GROUP)).toEqual([{ otherUserId: alice.id, cents: 1000 }]);

    const announcement = sent.find((s) => s.to === 'group');
    expect(announcement?.text).toContain(b.code);
    expect(announcement?.text).toContain('€10.00');
  });

  it('leaves a game alone until the grace period has passed', async () => {
    const alice = user('Alice');
    const b = booking(alice, { totalCostCents: 3000 });
    moveToPast(b, 1); // finished, but only just

    const { notifier, sent } = recorder();
    expect(await runAutoSettlement(notifier)).toBe(0);
    expect(findBookingById(b.id)!.status).toBe('OPEN');
    expect(sent).toHaveLength(0);
  });

  it('never settles the same booking twice', async () => {
    const alice = user('Alice');
    const bob = user('Bob');
    const b = booking(alice, { totalCostCents: 2000, minPlayers: 2, maxPlayers: 2 });
    joinBooking(b.code, bob);
    moveToPast(b, 6);

    const { notifier } = recorder();
    expect(await runAutoSettlement(notifier)).toBe(1);
    // A second pass one minute later must not charge anybody again.
    expect(await runAutoSettlement(notifier)).toBe(0);

    expect(balanceFor(bob.id, GROUP)).toEqual([{ otherUserId: alice.id, cents: 1000 }]);
  });

  it('ignores Playtomic bookings entirely', async () => {
    const alice = user('Alice');
    const created = createExternalBooking({
      groupId: GROUP,
      creator: alice,
      provider: 'Playtomic',
      url: 'https://playtomic.io/m/1',
      startsAtIso: inHours(48),
    });
    if (!created.ok) throw new Error('setup failed');
    moveToPast(created.booking, 6);

    const { notifier, sent } = recorder();
    expect(await runAutoSettlement(notifier)).toBe(0);
    expect(findBookingById(created.booking.id)!.status).toBe('OPEN');
    expect(sent).toHaveLength(0);
  });

  it('closes an abandoned booking without inventing debts', async () => {
    const alice = user('Alice');
    // Nobody on the roster at all: the creator did not join.
    const b = booking(alice, { totalCostCents: 4000, joinAsPlayer: false });
    moveToPast(b, 6);

    const { notifier, sent } = recorder();
    await runAutoSettlement(notifier);

    expect(findBookingById(b.id)!.status).toBe('SETTLED');
    expect(many('SELECT * FROM ledger_entries')).toHaveLength(0);
    expect(sent).toHaveLength(0);
  });

  it('charges an unreplaced late canceller when the game settles itself', async () => {
    const alice = user('Alice');
    const bob = user('Bob');
    const dave = user('Dave');

    const b = booking(alice, { totalCostCents: 3000, minPlayers: 3, maxPlayers: 3, startsAtIso: inHours(5) });
    joinBooking(b.code, bob);
    joinBooking(b.code, dave);
    leaveBooking(b.code, dave, true); // late, nobody takes the spot

    moveToPast(findBookingById(b.id)!, 6);

    const { notifier, sent } = recorder();
    await runAutoSettlement(notifier);

    expect(balanceFor(dave.id, GROUP)).toEqual([{ otherUserId: alice.id, cents: 1000 }]);
    expect(sent.find((s) => s.to === 'group')?.text).toContain('late cancellation');
  });
});

describe('fill reminders', () => {
  it('nudges the group once when a game is close and short of players', async () => {
    setSettings({ reminderHoursBefore: 26 });
    const alice = user('Alice');
    const b = booking(alice, { minPlayers: 4, maxPlayers: 4, startsAtIso: inHours(20) });

    const { notifier, sent } = recorder();
    expect(await runFillReminders(notifier)).toBe(1);
    expect(sent[0]!.text).toContain(b.code);
    expect(sent[0]!.to).toBe('group');

    // Every later pass must stay quiet.
    expect(await runFillReminders(notifier)).toBe(0);
  });

  it('stays quiet when the game already has enough players', async () => {
    setSettings({ reminderHoursBefore: 26 });
    const alice = user('Alice');
    const b = booking(alice, { minPlayers: 2, maxPlayers: 4, startsAtIso: inHours(20) });
    joinBooking(b.code, user('Bob'));

    const { notifier } = recorder();
    expect(await runFillReminders(notifier)).toBe(0);
  });

  it('stays quiet when reminders are switched off', async () => {
    setSettings({ reminderHoursBefore: 0 });
    booking(user('Alice'), { minPlayers: 4, startsAtIso: inHours(20) });

    const { notifier } = recorder();
    expect(await runFillReminders(notifier)).toBe(0);
  });
});

describe('payment reminders', () => {
  it('reminds debtors privately, never in the group', async () => {
    setSettings({ paymentDeadlineDays: 7 });
    const alice = user('Alice');
    const bob = user('Bob');

    const b = booking(alice, { totalCostCents: 2000, minPlayers: 2, maxPlayers: 2 });
    joinBooking(b.code, bob);
    // The game was six days ago, so the 7-day deadline is tomorrow.
    updateBooking(b.id, { starts_at: DateTime.utc().minus({ days: 6 }).toISO()! });
    settleBooking(b.id);

    const { notifier, sent } = recorder();
    expect(await runPaymentReminders(notifier)).toBe(1);

    expect(sent).toHaveLength(1);
    expect(sent[0]!.to).toBe(bob.id); // private, not 'group'
    expect(sent[0]!.text).toContain('€10.00');

    expect(await runPaymentReminders(notifier)).toBe(0); // fires only once
  });

  it('says nothing to someone who has already paid', async () => {
    setSettings({ paymentDeadlineDays: 7, paymentConfirmationMode: 'anyone' });
    const alice = user('Alice');
    const bob = user('Bob');

    const b = booking(alice, { totalCostCents: 2000, minPlayers: 2, maxPlayers: 2 });
    joinBooking(b.code, bob);
    updateBooking(b.id, { starts_at: DateTime.utc().minus({ days: 6 }).toISO()! });
    settleBooking(b.id);

    // Bob settles up before the reminder runs.
    run(
      `INSERT INTO ledger_entries (group_id, kind, booking_id, from_user_id, to_user_id, amount_cents, currency, created_at)
       VALUES (?, 'PAYMENT', ?, ?, ?, 1000, 'EUR', ?)`,
      GROUP,
      b.id,
      bob.id,
      alice.id,
      DateTime.utc().toISO()!,
    );

    const { notifier, sent } = recorder();
    expect(await runPaymentReminders(notifier)).toBe(0);
    expect(sent).toHaveLength(0);
  });
});

describe('retention purge', () => {
  it('deletes message records past the retention window and keeps recent ones', () => {
    setSettings({ dataRetentionDays: 90 });

    run('INSERT INTO processed_messages (wa_message_id, processed_at) VALUES (?, ?)',
      'old', DateTime.utc().minus({ days: 120 }).toISO()!);
    run('INSERT INTO processed_messages (wa_message_id, processed_at) VALUES (?, ?)',
      'recent', DateTime.utc().minus({ days: 3 }).toISO()!);

    expect(runRetentionPurge().messages).toBe(1);
    expect(one('SELECT 1 AS x FROM processed_messages WHERE wa_message_id = ?', 'old')).toBeUndefined();
    expect(one('SELECT 1 AS x FROM processed_messages WHERE wa_message_id = ?', 'recent')).toBeDefined();
  });
});

import { beforeEach, describe, expect, it } from 'vitest';
import { many, one } from '../src/db/index.js';
import {
  createExternalBooking,
  joinBooking,
  listUpcoming,
  listAllBookings,
} from '../src/domain/bookings.js';
import { balanceFor, overallBalances, settleBooking, simplifyDebts } from '../src/domain/ledger.js';
import { claimPayment } from '../src/domain/payments.js';
import { createPlace, listPlaces, resolvePlace } from '../src/domain/places.js';
import { getSettings, setSettings } from '../src/domain/settings.js';
import { pendingReminders, recordReminder } from '../src/domain/reminders.js';
import { GROUP, booking, freshDb, inHours, otherGroup, user } from './helpers.js';

/** Every table that carries a group_id must never hold an unscoped row. */
const SCOPED_TABLES = [
  'places',
  'bookings',
  'ledger_entries',
  'payment_claims',
  'reports',
  'payment_reminders',
  'settings',
];

beforeEach(() => freshDb());

describe('nothing is ever written unscoped', () => {
  it('leaves no NULL group_id behind after a full lifecycle', () => {
    // group_id is nullable in SQLite (adding a NOT NULL column to a populated
    // table is not possible), so a forgotten column in an INSERT would fail
    // silently. This is the net that catches it.
    const alice = user('Alice');
    const bob = user('Bob');

    const b = booking(alice, { totalCostCents: 2000, minPlayers: 2, maxPlayers: 2 });
    joinBooking(b.code, bob);
    settleBooking(b.id);
    claimPayment({
      groupId: GROUP,
      claimant: bob,
      claimantIsAdmin: false,
      fromUserId: bob.id,
      toUserId: alice.id,
      amountCents: 500,
    });
    recordReminder(alice.id, bob.id, 500, GROUP);
    createExternalBooking({
      groupId: GROUP,
      creator: alice,
      provider: 'Playtomic',
      url: 'https://playtomic.io/m/1',
      startsAtIso: inHours(200),
    });

    for (const table of SCOPED_TABLES) {
      const unscoped = one<{ n: number }>(`SELECT COUNT(*) AS n FROM ${table} WHERE group_id IS NULL`)!.n;
      expect(unscoped, `${table} has unscoped rows`).toBe(0);
    }
  });
});

describe('two groups cannot see each other', () => {
  it('keeps bookings apart', () => {
    const g2 = otherGroup('Tennis Tuesday');
    const alice = user('Alice');
    const alice2 = user('Alice', g2);

    booking(alice, { startsAtIso: inHours(24) });
    booking(alice2, { groupId: g2, startsAtIso: inHours(24) }); // same time, other group

    expect(listUpcoming(GROUP)).toHaveLength(1);
    expect(listUpcoming(g2)).toHaveLength(1);
    expect(listAllBookings(GROUP)).toHaveLength(1);
  });

  it('allows two groups to play at the same time', () => {
    // The no-double-booking rule protects one set of players from being on two
    // courts at once. Different groups are different people.
    const g2 = otherGroup('Second group');
    const alice = user('Alice');
    const bob = user('Bob', g2);
    const at = inHours(48);

    const first = booking(alice, { startsAtIso: at });
    expect(first.group_id).toBe(GROUP);

    const second = booking(bob, { groupId: g2, startsAtIso: at });
    expect(second.group_id).toBe(g2);
  });

  it('never nets a debt in one group against the other', () => {
    const g2 = otherGroup('Second group');
    const me = user('Guilherme');
    const x = user('X');
    user('Guilherme', g2);
    user('X', g2);

    // X owes me €8 in group 1.
    const mine = booking(me, { totalCostCents: 1600, minPlayers: 2, maxPlayers: 2 });
    joinBooking(mine.code, x);
    settleBooking(mine.id);

    // I owe X €10 in group 2 — a different world, so no offsetting.
    const theirs = booking(x, {
      groupId: g2,
      totalCostCents: 2000,
      minPlayers: 2,
      maxPlayers: 2,
      startsAtIso: inHours(200),
    });
    joinBooking(theirs.code, me);
    settleBooking(theirs.id);

    expect(balanceFor(me.id, GROUP)).toEqual([{ otherUserId: x.id, cents: -800 }]);
    expect(balanceFor(me.id, g2)).toEqual([{ otherUserId: x.id, cents: 1000 }]);
    // Netting them would have shown a single €2 — the very thing that must not happen.
  });

  it('keeps places apart, including the same name in both', () => {
    const g2 = otherGroup('Second group');
    createPlace({ groupId: GROUP, name: 'Ocean Club' });
    createPlace({ groupId: g2, name: 'Ocean Club' }); // same name, different group

    expect(listPlaces(GROUP)).toHaveLength(1);
    expect(listPlaces(g2)).toHaveLength(1);
    expect(resolvePlace('Ocean', GROUP).place?.group_id).toBe(GROUP);
    expect(resolvePlace('Ocean', g2).place?.group_id).toBe(g2);
  });

  it('keeps settings apart', () => {
    const g2 = otherGroup('Second group');
    setSettings({ language: 'de', defaultCancelLimitHours: 48 }, GROUP);
    setSettings({ language: 'pt', defaultCancelLimitHours: 12 }, g2);

    expect(getSettings(GROUP).language).toBe('de');
    expect(getSettings(GROUP).defaultCancelLimitHours).toBe(48);
    expect(getSettings(g2).language).toBe('pt');
    expect(getSettings(g2).defaultCancelLimitHours).toBe(12);
  });

  it('keeps the group-wide balance view and reminders apart', () => {
    const g2 = otherGroup('Second group');
    const alice = user('Alice');
    const bob = user('Bob');
    const b = booking(alice, { totalCostCents: 2000, minPlayers: 2, maxPlayers: 2 });
    joinBooking(b.code, bob);
    settleBooking(b.id);

    expect(overallBalances(GROUP)).toHaveLength(2);
    expect(overallBalances(g2)).toHaveLength(0);
    expect(simplifyDebts(g2)).toEqual([]);
    expect(pendingReminders(alice.id, GROUP).due).toHaveLength(1);
    expect(pendingReminders(alice.id, g2).due).toHaveLength(0);
  });
});

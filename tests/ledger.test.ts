import { beforeEach, describe, expect, it } from 'vitest';
import { joinBooking, leaveBooking } from '../src/domain/bookings.js';
import { balanceFor, settleBooking, simplifyDebts } from '../src/domain/ledger.js';
import { claimPayment } from '../src/domain/payments.js';
import { setSettings } from '../src/domain/settings.js';
import { booking, freshDb, inHours, user } from './helpers.js';

beforeEach(() => freshDb());

describe('settlement', () => {
  it('charges every player except the payer, who fronted the court', () => {
    const alice = user('Alice');
    const bob = user('Bob');
    const carol = user('Carol');
    const dave = user('Dave');

    const b = booking(alice, { totalCostCents: 4000 }); // Alice pays, and plays
    joinBooking(b.code, bob);
    joinBooking(b.code, carol);
    joinBooking(b.code, dave);

    const result = settleBooking(b.id);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    // €40 across 4 players = €10 each.
    expect(result.lines).toHaveLength(4);
    expect(result.lines.every((l) => l.amountCents === 1000)).toBe(true);

    // Alice is owed €10 by each of the other three.
    expect(balanceFor(bob.id)).toEqual([{ otherUserId: alice.id, cents: 1000 }]);
    expect(balanceFor(alice.id)).toEqual(
      expect.arrayContaining([
        { otherUserId: bob.id, cents: -1000 },
        { otherUserId: carol.id, cents: -1000 },
        { otherUserId: dave.id, cents: -1000 },
      ]),
    );
  });

  it('splits an indivisible total without losing or inventing cents', () => {
    const alice = user('Alice');
    const bob = user('Bob');
    const carol = user('Carol');

    const b = booking(alice, { totalCostCents: 4000, minPlayers: 3, maxPlayers: 3 });
    joinBooking(b.code, bob);
    joinBooking(b.code, carol);

    const result = settleBooking(b.id);
    if (!result.ok) throw new Error('expected settlement');

    const total = result.lines.reduce((sum, l) => sum + l.amountCents, 0);
    expect(total).toBe(4000); // 1334 + 1333 + 1333
    expect(result.lines.map((l) => l.amountCents).sort()).toEqual([1333, 1333, 1334]);
  });

  it('refuses to settle twice', () => {
    const alice = user('Alice');
    const b = booking(alice);
    expect(settleBooking(b.id).ok).toBe(true);

    const second = settleBooking(b.id);
    expect(second.ok).toBe(false);
    if (!second.ok) expect(second.reason).toBe('already_settled');
  });
});

describe('balance netting', () => {
  it('nets debts in both directions into a single figure', () => {
    // The exact scenario from the design document:
    //   Guilherme books, X owes him €8.
    //   X books next week, Guilherme owes X €10.
    //   The answer must be "Guilherme owes X €2", not two open debts.
    const me = user('Guilherme');
    const x = user('X');

    const mine = booking(me, { totalCostCents: 1600, minPlayers: 2, maxPlayers: 2 });
    joinBooking(mine.code, x);
    settleBooking(mine.id); // X owes me €8

    const theirs = booking(x, {
      totalCostCents: 2000,
      minPlayers: 2,
      maxPlayers: 2,
      startsAtIso: inHours(200),
    });
    joinBooking(theirs.code, me);
    settleBooking(theirs.id); // I owe X €10

    expect(balanceFor(me.id)).toEqual([{ otherUserId: x.id, cents: 200 }]);
    expect(balanceFor(x.id)).toEqual([{ otherUserId: me.id, cents: -200 }]);
  });

  it('drops the pair entirely once the debts cancel out', () => {
    const me = user('Guilherme');
    const x = user('X');

    const mine = booking(me, { totalCostCents: 2000, minPlayers: 2, maxPlayers: 2 });
    joinBooking(mine.code, x);
    settleBooking(mine.id);

    const theirs = booking(x, {
      totalCostCents: 2000,
      minPlayers: 2,
      maxPlayers: 2,
      startsAtIso: inHours(200),
    });
    joinBooking(theirs.code, me);
    settleBooking(theirs.id);

    expect(balanceFor(me.id)).toEqual([]);
    expect(balanceFor(x.id)).toEqual([]);
  });

  it('reduces the balance when a payment is confirmed', () => {
    setSettings({ paymentConfirmationMode: 'anyone' });
    const alice = user('Alice');
    const bob = user('Bob');

    const b = booking(alice, { totalCostCents: 2000, minPlayers: 2, maxPlayers: 2 });
    joinBooking(b.code, bob);
    settleBooking(b.id); // Bob owes Alice €10

    const result = claimPayment({
      claimant: bob,
      claimantIsAdmin: false,
      fromUserId: bob.id,
      toUserId: alice.id,
      amountCents: 600,
    });
    expect(result.ok && result.status).toBe('APPROVED');
    expect(balanceFor(bob.id)).toEqual([{ otherUserId: alice.id, cents: 400 }]);
  });
});

describe('simplifyDebts', () => {
  it('collapses a circular debt into no transfers at all', () => {
    // A owes B, B owes C, C owes A — all €10. Nobody needs to pay anything.
    const a = user('A');
    const b = user('B');
    const c = user('C');

    for (const [payer, debtor] of [
      [b, a],
      [c, b],
      [a, c],
    ] as const) {
      const bk = booking(payer, {
        totalCostCents: 2000,
        minPlayers: 2,
        maxPlayers: 2,
        startsAtIso: inHours(50 + payer.id * 7),
      });
      joinBooking(bk.code, debtor);
      settleBooking(bk.id);
    }

    expect(simplifyDebts()).toEqual([]);
  });

  it('routes a chain of debts into one direct transfer', () => {
    // A owes B €10, B owes C €10  =>  A should just pay C €10.
    const a = user('A');
    const b = user('B');
    const c = user('C');

    const first = booking(b, { totalCostCents: 2000, minPlayers: 2, maxPlayers: 2 });
    joinBooking(first.code, a);
    settleBooking(first.id);

    const second = booking(c, {
      totalCostCents: 2000,
      minPlayers: 2,
      maxPlayers: 2,
      startsAtIso: inHours(200),
    });
    joinBooking(second.code, b);
    settleBooking(second.id);

    expect(simplifyDebts()).toEqual([{ fromUserId: a.id, toUserId: c.id, cents: 1000 }]);
  });
});

describe('late cancellation liability', () => {
  it('lets a replaced player off the hook when the group still reaches min', () => {
    const alice = user('Alice');
    const bob = user('Bob');
    const carol = user('Carol');
    const dave = user('Dave');
    const erin = user('Erin');

    // Starts in 5h, so the 24h cancellation window has already closed.
    const b = booking(alice, { totalCostCents: 4000, startsAtIso: inHours(5) });
    joinBooking(b.code, bob);
    joinBooking(b.code, carol);
    joinBooking(b.code, dave);

    const leave = leaveBooking(b.code, dave, true);
    expect(leave.ok && leave.outcome).toBe('left_late');

    joinBooking(b.code, erin); // Erin takes Dave's slot

    const result = settleBooking(b.id);
    if (!result.ok) throw new Error('expected settlement');

    // Four players on court, Dave released entirely.
    expect(result.lines).toHaveLength(4);
    expect(result.lines.find((l) => l.userId === dave.id)).toBeUndefined();
    expect(balanceFor(dave.id)).toEqual([]);
  });

  it('keeps an unreplaced late canceller liable for a full share', () => {
    const alice = user('Alice');
    const bob = user('Bob');
    const carol = user('Carol');
    const dave = user('Dave');

    const b = booking(alice, { totalCostCents: 4000, startsAtIso: inHours(5) });
    joinBooking(b.code, bob);
    joinBooking(b.code, carol);
    joinBooking(b.code, dave);

    leaveBooking(b.code, dave, true); // nobody replaces him

    const result = settleBooking(b.id);
    if (!result.ok) throw new Error('expected settlement');

    // Dave still pays: 3 on court + Dave = 4 shares of €10.
    expect(result.lines).toHaveLength(4);
    expect(result.lines.find((l) => l.userId === dave.id)).toEqual({
      userId: dave.id,
      amountCents: 1000,
      lateCancellation: true,
    });
    expect(balanceFor(dave.id)).toEqual([{ otherUserId: alice.id, cents: 1000 }]);
  });

  it('charges a replaced late canceller anyway when min players is not reached', () => {
    // The design's rule: payment is due if there is no replacement OR if the
    // minimum paying count is missed. Here Erin replaces Dave, but two other
    // players had already dropped out early, so the group is under min.
    const alice = user('Alice');
    const bob = user('Bob');
    const dave = user('Dave');
    const erin = user('Erin');

    const b = booking(alice, {
      totalCostCents: 4000,
      minPlayers: 4,
      maxPlayers: 4,
      startsAtIso: inHours(5),
    });
    joinBooking(b.code, bob);
    joinBooking(b.code, dave);

    leaveBooking(b.code, dave, true);
    joinBooking(b.code, erin); // replacement found, but only 3 on court

    const result = settleBooking(b.id);
    if (!result.ok) throw new Error('expected settlement');

    expect(result.lines).toHaveLength(4); // Alice, Bob, Erin + Dave
    expect(result.lines.find((l) => l.userId === dave.id)?.lateCancellation).toBe(true);
    expect(balanceFor(dave.id)).toEqual([{ otherUserId: alice.id, cents: 1000 }]);
  });

  it('asks for a second confirmation before recording a late leave', () => {
    const alice = user('Alice');
    const bob = user('Bob');

    const b = booking(alice, { totalCostCents: 4000, startsAtIso: inHours(5) });
    joinBooking(b.code, bob);

    const first = leaveBooking(b.code, bob); // no confirmation flag
    expect(first.ok && first.outcome).toBe('needs_late_confirmation');

    // Nothing was written: Bob is still on the roster.
    const stillIn = leaveBooking(b.code, bob);
    expect(stillIn.ok && stillIn.outcome).toBe('needs_late_confirmation');
  });

  it('charges nothing for leaving before the deadline', () => {
    const alice = user('Alice');
    const bob = user('Bob');

    const b = booking(alice, { totalCostCents: 4000, startsAtIso: inHours(72) });
    joinBooking(b.code, bob);

    const leave = leaveBooking(b.code, bob);
    expect(leave.ok && leave.outcome).toBe('left');

    const result = settleBooking(b.id);
    if (!result.ok) throw new Error('expected settlement');
    expect(result.lines).toHaveLength(1); // Alice alone
    expect(balanceFor(bob.id)).toEqual([]);
  });
});

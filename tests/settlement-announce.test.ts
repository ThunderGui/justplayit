import { beforeEach, describe, expect, it } from 'vitest';
import { many } from '../src/db/index.js';
import { findBookingById, joinBooking, leaveBooking, updateBooking } from '../src/domain/bookings.js';
import { balanceFor } from '../src/domain/ledger.js';
import {
  runAutoSettlement,
  runSettlementAnnouncements,
  type Notifier,
} from '../src/scheduler/jobs.js';
import { GROUP, booking, freshDb, inHours, user } from './helpers.js';

interface Sent { to: 'group' | number; text: string }

/** A notifier that can be made to fail, standing in for a dropped socket. */
function flakyNotifier() {
  const sent: Sent[] = [];
  const state = { failing: false };
  const guard = () => {
    if (state.failing) throw new Error('Connection Closed');
  };
  const notifier: Notifier = {
    async sendToGroup(_groupId, text) { guard(); sent.push({ to: 'group', text }); },
    async sendToUser(userId, text) { guard(); sent.push({ to: userId, text }); },
  };
  return { notifier, sent, state };
}

const announcedJobs = () =>
  many<{ booking_id: number }>(
    `SELECT booking_id FROM scheduled_jobs WHERE kind = 'SETTLEMENT_ANNOUNCED'`,
  );

beforeEach(() => freshDb());

/** A played game, three hours past its end, ready to settle. */
function playedGame() {
  const alice = user('Alice');
  const bob = user('Bob');
  const carol = user('Carol');
  const b = booking(alice, { totalCostCents: 3000, minPlayers: 3, maxPlayers: 3 });
  joinBooking(b.code, bob);
  joinBooking(b.code, carol);
  updateBooking(b.id, { starts_at: inHours(-6) });
  return { alice, bob, carol, booking: findBookingById(b.id)! };
}

describe('a settlement that could not be announced', () => {
  it('still records the debts when the connection is down', async () => {
    const { alice, bob } = playedGame();
    const { notifier, sent, state } = flakyNotifier();

    state.failing = true;
    await runAutoSettlement(notifier);

    // The money is real even though nothing could be sent.
    expect(balanceFor(bob.id, GROUP)).toEqual([{ otherUserId: alice.id, cents: 1000 }]);
    expect(sent).toHaveLength(0);
    // Crucially, it is NOT marked as announced.
    expect(announcedJobs()).toHaveLength(0);
  });

  it('announces it on a later pass once the connection is back', async () => {
    const { booking: b } = playedGame();
    const { notifier, sent, state } = flakyNotifier();

    state.failing = true;
    await runAutoSettlement(notifier);
    expect(sent).toHaveLength(0);

    // The socket comes back; the next tick delivers the message that was lost.
    state.failing = false;
    expect(await runSettlementAnnouncements(notifier)).toBe(1);

    const announcement = sent.find((s) => s.to === 'group');
    expect(announcement?.text).toContain(b.code);
    expect(announcement?.text).toContain('€10.00');
    expect(announcedJobs().map((j) => j.booking_id)).toEqual([b.id]);
  });

  it('rebuilds the split correctly from the ledger, payer included', async () => {
    const { alice } = playedGame();
    const { notifier, sent, state } = flakyNotifier();

    state.failing = true;
    await runAutoSettlement(notifier);
    state.failing = false;
    await runSettlementAnnouncements(notifier);

    const text = sent.find((s) => s.to === 'group')!.text;
    // Three players at €10; the payer's own share is not a charge but must
    // still appear in the split, or the message would not add up to €30.
    expect(text.match(/€10\.00/g)).toHaveLength(3);
    expect(text).toContain('Alice');
    void alice;
  });

  it('does not announce the same settlement twice', async () => {
    playedGame();
    const { notifier, sent } = flakyNotifier();

    await runAutoSettlement(notifier);
    const first = sent.length;
    expect(first).toBeGreaterThan(0);

    await runSettlementAnnouncements(notifier);
    await runSettlementAnnouncements(notifier);
    expect(sent).toHaveLength(first);
  });

  it('marks a late canceller in a re-announced split', async () => {
    const alice = user('Alice');
    const bob = user('Bob');
    const dave = user('Dave');
    const b = booking(alice, { totalCostCents: 3000, minPlayers: 3, maxPlayers: 3, startsAtIso: inHours(5) });
    joinBooking(b.code, bob);
    joinBooking(b.code, dave);
    leaveBooking(b.code, dave, true); // late, unreplaced
    updateBooking(b.id, { starts_at: inHours(-6) });

    const { notifier, sent, state } = flakyNotifier();
    state.failing = true;
    await runAutoSettlement(notifier);
    state.failing = false;
    await runSettlementAnnouncements(notifier);

    expect(sent.find((s) => s.to === 'group')!.text).toContain('late cancellation');
  });

  it('closes out a game nobody played without announcing anything', async () => {
    const b = booking(user('Alice'), { joinAsPlayer: false });
    updateBooking(b.id, { starts_at: inHours(-6) });

    const { notifier, sent } = flakyNotifier();
    await runAutoSettlement(notifier);

    expect(findBookingById(b.id)!.status).toBe('SETTLED');
    expect(sent).toHaveLength(0);
    // Recorded as handled, so it is not retried forever.
    expect(announcedJobs()).toHaveLength(1);
  });
});

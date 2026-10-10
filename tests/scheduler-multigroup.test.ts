import { beforeEach, describe, expect, it } from 'vitest';
import { joinBooking, updateBooking, findBookingById } from '../src/domain/bookings.js';
import { setSettings } from '../src/domain/settings.js';
import {
  runAutoSettlement,
  runFillReminders,
  type Notifier,
} from '../src/scheduler/jobs.js';
import { GROUP, booking, freshDb, inHours, otherGroup, user } from './helpers.js';

interface Sent { groupId: number; text: string }

function recorder() {
  const sent: Sent[] = [];
  const notifier: Notifier = {
    async sendToGroup(groupId, text) { sent.push({ groupId, text }); },
    async sendToUser() {},
  };
  return { notifier, sent };
}

beforeEach(() => freshDb());

describe('scheduler targets each group separately', () => {
  it('announces each group\'s settlement to that group only', async () => {
    const g2 = otherGroup('Second');
    // Group 1 game, played and due.
    const a = user('Alice'); const b = user('Bob');
    const b1 = booking(a, { totalCostCents: 2000, minPlayers: 2, maxPlayers: 2 });
    joinBooking(b1.code, b);
    updateBooking(b1.id, { starts_at: inHours(-6) });
    // Group 2 game, played and due.
    const c = user('Carol', g2); const d = user('Dave', g2);
    const b2 = booking(c, { groupId: g2, totalCostCents: 2000, minPlayers: 2, maxPlayers: 2 });
    joinBooking(b2.code, d);
    updateBooking(b2.id, { starts_at: inHours(-6) });

    const { notifier, sent } = recorder();
    await runAutoSettlement(notifier);

    const g1msg = sent.find((s) => s.groupId === GROUP);
    const g2msg = sent.find((s) => s.groupId === g2);
    expect(g1msg?.text).toContain(b1.code);
    expect(g2msg?.text).toContain(b2.code);
    // Neither group's settlement leaked into the other's chat.
    expect(g1msg?.text).not.toContain(b2.code);
    expect(g2msg?.text).not.toContain(b1.code);
  });

  it('respects each group\'s own reminder setting', async () => {
    const g2 = otherGroup('Second');
    setSettings({ reminderHoursBefore: 26 }, GROUP);
    setSettings({ reminderHoursBefore: 0 }, g2); // reminders off for group 2

    const b1 = booking(user('Alice'), { minPlayers: 4, maxPlayers: 4, startsAtIso: inHours(20) });
    booking(user('Carol', g2), { groupId: g2, minPlayers: 4, maxPlayers: 4, startsAtIso: inHours(20) });

    const { notifier, sent } = recorder();
    await runFillReminders(notifier);

    // Only group 1 is nudged; group 2 opted out.
    expect(sent.map((s) => s.groupId)).toEqual([GROUP]);
    expect(sent[0]!.text).toContain(b1.code);
  });
});

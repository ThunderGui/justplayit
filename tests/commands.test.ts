import { beforeEach, describe, expect, it } from 'vitest';
import { handleCommand, type CommandContext, type OutgoingMessage } from '../src/bot/commands.js';
import { parseMessage, type ParsedCommand } from '../src/bot/parser.js';
import { findBookingByCode, getRoster, joinBooking } from '../src/domain/bookings.js';
import { balanceFor, settleBooking } from '../src/domain/ledger.js';
import { createPlace } from '../src/domain/places.js';
import { getSettings, setSettings } from '../src/domain/settings.js';
import { t } from '../src/i18n/index.js';
import type { User } from '../src/domain/users.js';
import { GROUP, booking, freshDb, inHours, user } from './helpers.js';

const GROUP_JID = 'group-123@g.us';

beforeEach(() => {
  freshDb();
  createPlace({ groupId: GROUP, name: 'Padel Base', address: 'Musterstr. 1' });
});

function ctx(as: User, opts: Partial<CommandContext> = {}): CommandContext {
  const settings = getSettings();
  return {
    groupId: GROUP,
    user: as,
    isAdmin: as.is_admin === 1,
    chatId: GROUP_JID,
    isGroup: true,
    dict: t(settings.language),
    settings,
    mentionedUserIds: [],
    ...opts,
  };
}

/** Parses and runs a command the way the WhatsApp adapter would. */
function send(text: string, as: User, opts: Partial<CommandContext> = {}): OutgoingMessage[] {
  const parsed = parseMessage(text, { prefix: '!', prefixOptional: opts.isGroup === false });
  if (parsed.kind !== 'command') throw new Error(`not a command: ${text} (${parsed.kind})`);
  return handleCommand(parsed.command as ParsedCommand, ctx(as, opts));
}

const textOf = (messages: OutgoingMessage[]) => messages.map((m) => m.text).join('\n---\n');

describe('booking via chat', () => {
  it('creates a booking from a multi-line message and announces it to the group', () => {
    const alice = user('Alice');
    const out = send(
      ['!book', 'place: Padel Base', 'date: tomorrow', 'time: 19:00', 'cost: 40', 'max: 4'].join('\n'),
      alice,
    );

    expect(out).toHaveLength(1);
    expect(out[0]!.target).toBe('group');
    expect(out[0]!.text).toContain('Padel Base');
    expect(out[0]!.text).toContain('€40.00');

    // The creator is on the roster without having to join separately.
    const code = out[0]!.text.match(/\*([A-Z0-9]{4})\*/)?.[1];
    expect(code).toBeTruthy();
    expect(getRoster(findBookingByCode(code!)!.id).confirmed).toHaveLength(1);
  });

  it('lists what is still missing instead of failing silently', () => {
    const out = send('!book\nplace: Padel Base\ndate: tomorrow', user('Alice'));
    expect(out[0]!.text).toContain('time');
    expect(out[0]!.text).toContain('cost');
  });

  it('refuses a second booking at the same time and names the clash', () => {
    const alice = user('Alice');
    send(['!book', 'place: Padel Base', 'date: tomorrow', 'time: 19:00', 'cost: 40'].join('\n'), alice);

    const out = send(
      ['!book', 'place: Padel Base', 'date: tomorrow', 'time: 19:30', 'cost: 40'].join('\n'),
      user('Bob'),
    );
    expect(out[0]!.text.toLowerCase()).toContain('same time');
  });
});

describe('Playtomic bookings via chat', () => {
  it('adds an external booking and shows only the link', () => {
    const out = send(
      ['!playtomic', 'url: https://playtomic.io/tenant/match/abc', 'date: tomorrow', 'time: 19:00'].join('\n'),
      user('Alice'),
    );

    expect(out[0]!.target).toBe('group');
    expect(out[0]!.text).toContain('Playtomic');
    expect(out[0]!.text).toContain('https://playtomic.io/tenant/match/abc');
    // No cost or player count: that is all managed on the platform.
    expect(out[0]!.text).not.toContain('€');
  });

  it('points a would-be joiner at the platform instead of tracking a roster', () => {
    const alice = user('Alice');
    const out = send(
      ['!playtomic', 'url: https://playtomic.io/m/1', 'date: tomorrow', 'time: 19:00'].join('\n'),
      alice,
    );
    const code = out[0]!.text.match(/\*([A-Z0-9]{4})\*/)![1]!;

    const join = send(`!join ${code}`, user('Bob'));
    expect(join[0]!.text).toContain('Playtomic');
  });

  it('shows external and managed bookings together in the list', () => {
    const alice = user('Alice');
    send(['!book', 'place: Padel Base', 'date: tomorrow', 'time: 19:00', 'cost: 40'].join('\n'), alice);
    send(['!playtomic', 'url: https://playtomic.io/m/1', 'date: tomorrow', 'time: 21:00'].join('\n'), alice);

    const out = send('!list', user('Bob'));
    expect(out[0]!.text).toContain('Padel Base');
    expect(out[0]!.text).toContain('playtomic.io');
  });
});

describe('join and leave', () => {
  it('announces a join to the group and sends the calendar link privately', () => {
    const alice = user('Alice');
    const bob = user('Bob');
    const b = booking(alice);

    const out = send(`!join ${b.code}`, bob);
    expect(out[0]!.target).toBe('group');
    expect(out[0]!.text).toContain('Bob');
    expect(out[1]!.target).toBe('dm');
    expect(out[1]!.text).toContain('calendar.google.com');
  });

  it('waitlists past the maximum and promotes on a leave', () => {
    const alice = user('Alice');
    const bob = user('Bob');
    const carol = user('Carol');
    const b = booking(alice, { maxPlayers: 2 });

    joinBooking(b.code, bob);
    const waitlisted = send(`!join ${b.code}`, carol);
    expect(waitlisted[0]!.text).toContain('waiting list');

    const left = send(`!leave ${b.code}`, bob);
    const combined = textOf(left);
    expect(combined).toContain('Bob');
    expect(combined).toContain('Carol'); // promoted
  });

  it('needs a second YES before a late leave is recorded', () => {
    const alice = user('Alice');
    const bob = user('Bob');
    const b = booking(alice, { startsAtIso: inHours(5) }); // inside the 24h window
    joinBooking(b.code, bob);

    const warning = send(`!leave ${b.code}`, bob);
    expect(warning[0]!.target).toBe('origin'); // asked privately, not shouted
    expect(warning[0]!.text).toContain('⚠️');
    expect(getRoster(b.id).confirmed).toHaveLength(2); // nothing changed yet

    const confirmed = send('!yes', bob);
    expect(textOf(confirmed)).toContain('Bob');
    expect(getRoster(b.id).confirmed).toHaveLength(1);
  });

  it('changes nothing when the late leave is declined', () => {
    const alice = user('Alice');
    const bob = user('Bob');
    const b = booking(alice, { startsAtIso: inHours(5) });
    joinBooking(b.code, bob);

    send(`!leave ${b.code}`, bob);
    const declined = send('!no', bob);
    expect(declined[0]!.text.toLowerCase()).toContain('cancelled');
    expect(getRoster(b.id).confirmed).toHaveLength(2);
  });

  it('does not let a stale YES answer an unrelated prompt', () => {
    const out = send('!yes', user('Alice'));
    expect(out[0]!.text.toLowerCase()).toContain('nothing');
  });
});

describe('balance privacy', () => {
  it('always answers privately, even when asked in the group', () => {
    const alice = user('Alice');
    const bob = user('Bob');
    const b = booking(alice, { totalCostCents: 2000, minPlayers: 2, maxPlayers: 2 });
    joinBooking(b.code, bob);
    settleBooking(b.id);

    const out = send('!balance', bob, { isGroup: true });

    const dm = out.find((m) => m.target === 'dm');
    const group = out.find((m) => m.target === 'group' || m.target === 'origin');

    expect(dm?.text).toContain('€10.00');
    // The group acknowledgement must not leak the figure.
    expect(group?.text).not.toContain('€10.00');
  });

  it('gives an admin the group-wide view as well', () => {
    const alice = user('Alice'); // first user created is the admin
    const bob = user('Bob');
    const b = booking(alice, { totalCostCents: 2000, minPlayers: 2, maxPlayers: 2 });
    joinBooking(b.code, bob);
    settleBooking(b.id);

    const out = send('!balance', alice);
    expect(textOf(out)).toContain('Group balance');
  });
});

describe('payments', () => {
  it('records a payment immediately when the receiver confirms it', () => {
    setSettings({ paymentConfirmationMode: 'receiver' });
    const alice = user('Alice');
    const bob = user('Bob');
    const b = booking(alice, { totalCostCents: 2000, minPlayers: 2, maxPlayers: 2 });
    joinBooking(b.code, bob);
    settleBooking(b.id);

    // Alice received the money, so under 'receiver' mode her word is enough.
    // She records that Bob paid her by confirming from Bob's side is not allowed,
    // so Bob's own claim must go to Alice for approval instead.
    const claim = send('!confirm Alice', bob, { isGroup: false, chatId: 'dm-bob' });
    expect(textOf(claim)).toContain('Waiting for them to confirm');

    const code = claim[0]!.text.match(/\*([A-Z0-9]{4})\*/)![1]!;
    const approved = send(`!approve ${code}`, alice, { isGroup: false, chatId: 'dm-alice' });
    expect(textOf(approved)).toContain('confirmed');
  });

  it('lets either party confirm under the "both" policy', () => {
    setSettings({ paymentConfirmationMode: 'both' });
    const alice = user('Alice');
    const bob = user('Bob');
    const b = booking(alice, { totalCostCents: 2000, minPlayers: 2, maxPlayers: 2 });
    joinBooking(b.code, bob);
    settleBooking(b.id);

    const out = send('!confirm Alice', bob, { isGroup: false, chatId: 'dm-bob' });
    expect(textOf(out)).toContain('Payment recorded');
    expect(textOf(out)).toContain('square');
  });

  it('demands proof when the admin requires it', () => {
    setSettings({ paymentConfirmationMode: 'both', requirePaymentProof: true });
    const alice = user('Alice');
    const bob = user('Bob');
    const b = booking(alice, { totalCostCents: 2000, minPlayers: 2, maxPlayers: 2 });
    joinBooking(b.code, bob);
    settleBooking(b.id);

    const without = send('!confirm Alice', bob, { isGroup: false });
    expect(textOf(without)).toContain('proof');

    const with_ = send('!confirm Alice', bob, { isGroup: false, attachmentPath: '/tmp/proof.jpg' });
    expect(textOf(with_)).toContain('Payment recorded');
  });

  it('answers a confirm in the channel it was asked in', () => {
    setSettings({ paymentConfirmationMode: 'both' });
    const alice = user('Alice');
    const bob = user('Bob');
    const b = booking(alice, { totalCostCents: 2000, minPlayers: 2, maxPlayers: 2 });
    joinBooking(b.code, bob);
    settleBooking(b.id);

    const inGroup = send('!confirm Alice', bob, { isGroup: true });
    expect(inGroup[0]!.target).toBe('origin');
  });
});

describe('help', () => {
  it('explains the commands and the rules', () => {
    const out = send('!help', user('Alice'));
    const text = out[0]!.text;
    expect(text).toContain('!book');
    expect(text).toContain('!playtomic');
    expect(text).toContain('!balance');
    expect(text).toContain('Rules');
  });
});

describe('dual confirmation policy', () => {
  /**
   * Sets up a €10 debt from Bob to Alice, with both of them ordinary members —
   * the first user created becomes admin, and an admin bypasses every
   * confirmation policy, which would defeat the point of these tests.
   */
  function debtBobOwesAlice() {
    user('Zed the admin');
    const alice = user('Alice');
    const bob = user('Bob');
    const b = booking(alice, { totalCostCents: 2000, minPlayers: 2, maxPlayers: 2 });
    joinBooking(b.code, bob);
    settleBooking(b.id);
    return { alice, bob };
  }

  it('lets neither party clear a debt on their own', () => {
    setSettings({ paymentConfirmationMode: 'dual' });
    const { alice, bob } = debtBobOwesAlice();

    // The sender says they paid: still needs Alice's word.
    const out = send('!confirm Alice', bob, { isGroup: false, chatId: 'dm-bob' });
    expect(textOf(out)).toContain('Waiting for them to confirm');
    expect(balanceFor(bob.id, GROUP)).toEqual([{ otherUserId: alice.id, cents: 1000 }]);

    const code = out[0]!.text.match(/\*([A-Z0-9]{4})\*/)![1]!;

    // Bob cannot approve his own claim.
    const selfApprove = send(`!approve ${code}`, bob, { isGroup: false, chatId: 'dm-bob' });
    expect(textOf(selfApprove)).toContain('Only the person receiving');
    expect(balanceFor(bob.id, GROUP)).toEqual([{ otherUserId: alice.id, cents: 1000 }]);

    // Alice signs off and only now is it real.
    const approved = send(`!approve ${code}`, alice, { isGroup: false, chatId: 'dm-alice' });
    expect(textOf(approved)).toContain('confirmed');
    expect(balanceFor(bob.id, GROUP)).toEqual([]);
  });

  it('routes approval to the sender when the receiver files the claim', () => {
    setSettings({ paymentConfirmationMode: 'dual' });
    const { alice, bob } = debtBobOwesAlice();

    // Alice records that Bob paid her; under dual it is Bob who must confirm.
    const out = send('!confirm Bob', alice, { isGroup: false, chatId: 'dm-alice' });
    const dm = out.find((m) => m.target === 'dm');
    expect(dm?.userId).toBe(bob.id);
    expect(dm?.text).toContain('recorded that you paid them');

    const code = out[0]!.text.match(/\*([A-Z0-9]{4})\*/)![1]!;
    const approved = send(`!approve ${code}`, bob, { isGroup: false, chatId: 'dm-bob' });
    expect(textOf(approved)).toContain('confirmed');
    expect(balanceFor(bob.id, GROUP)).toEqual([]);
  });

  it('still lets an admin confirm directly', () => {
    setSettings({ paymentConfirmationMode: 'dual' });
    const alice = user('Alice'); // first user created is the admin
    const bob = user('Bob');
    const b = booking(alice, { totalCostCents: 2000, minPlayers: 2, maxPlayers: 2 });
    joinBooking(b.code, bob);
    settleBooking(b.id);

    const out = send('!confirm Bob', alice, { isGroup: false });
    expect(textOf(out)).toContain('Payment recorded');
    expect(balanceFor(bob.id, GROUP)).toEqual([]);
  });

  it('rejecting leaves the debt standing', () => {
    setSettings({ paymentConfirmationMode: 'dual' });
    const { alice, bob } = debtBobOwesAlice();

    const out = send('!confirm Alice', bob, { isGroup: false, chatId: 'dm-bob' });
    const code = out[0]!.text.match(/\*([A-Z0-9]{4})\*/)![1]!;

    send(`!reject ${code}`, alice, { isGroup: false, chatId: 'dm-alice' });
    expect(balanceFor(bob.id, GROUP)).toEqual([{ otherUserId: alice.id, cents: 1000 }]);
  });
});

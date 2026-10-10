import { beforeEach, describe, expect, it } from 'vitest';
import { handleCommand, type CommandContext, type OutgoingMessage } from '../src/bot/commands.js';
import { parseMessage } from '../src/bot/parser.js';
import { joinBooking } from '../src/domain/bookings.js';
import { settleBooking } from '../src/domain/ledger.js';
import { REMINDER_COOLDOWN_HOURS, pendingReminders } from '../src/domain/reminders.js';
import { getSettings, setSettings } from '../src/domain/settings.js';
import { setPaymentHandle, upsertUser, type User } from '../src/domain/users.js';
import { t } from '../src/i18n/index.js';
import { run } from '../src/db/index.js';
import { DateTime } from 'luxon';
import { GROUP, booking, freshDb, inHours, user } from './helpers.js';

function send(text: string, as: User, opts: Partial<CommandContext> = {}): OutgoingMessage[] {
  const settings = getSettings();
  const parsed = parseMessage(text, { prefix: settings.commandPrefix, prefixOptional: true });
  if (parsed.kind !== 'command') throw new Error(`not a command: ${text}`);
  return handleCommand(parsed.command, {
    groupId: GROUP,
    user: as,
    isAdmin: as.is_admin === 1,
    chatId: 'dm',
    isGroup: false,
    dict: t(settings.language),
    settings,
    mentionedUserIds: [],
    ...opts,
  });
}

/** Alice is owed €10 by Bob and €10 by Carol. */
function owedByTwo() {
  const alice = user('Alice');
  const bob = user('Bob');
  const carol = user('Carol');
  const b = booking(alice, { totalCostCents: 3000, minPlayers: 3, maxPlayers: 3 });
  joinBooking(b.code, bob);
  joinBooking(b.code, carol);
  settleBooking(b.id);
  return { alice, bob, carol };
}

beforeEach(() => freshDb());

describe('remind', () => {
  it('privately nudges everyone who owes the sender', () => {
    const { alice, bob, carol } = owedByTwo();
    const out = send('!remind', alice);

    const dms = out.filter((m) => m.target === 'dm');
    const toBob = dms.find((m) => m.userId === bob.id);
    const toCarol = dms.find((m) => m.userId === carol.id);

    expect(toBob?.text).toContain('€10.00');
    expect(toBob?.text).toContain('Alice');
    expect(toCarol?.text).toContain('€10.00');

    // Nothing is ever posted to the group: who has not paid stays private.
    expect(out.some((m) => m.target === 'group')).toBe(false);
  });

  it('reports back to the sender privately, with the total', () => {
    const { alice } = owedByTwo();
    const summary = send('!remind', alice).filter((m) => m.userId === alice.id).pop();
    expect(summary?.text).toContain('2');
    expect(summary?.text).toContain('€20.00');
  });

  it('answers privately and only acknowledges in the group', () => {
    const { alice } = owedByTwo();
    const out = send('!remind', alice, { isGroup: true, chatId: 'group' });

    const groupMsgs = out.filter((m) => m.target === 'origin' || m.target === 'group');
    expect(groupMsgs).toHaveLength(1);
    // The acknowledgement must not leak names or figures.
    expect(groupMsgs[0]!.text).not.toContain('€');
    expect(groupMsgs[0]!.text).not.toContain('Bob');
  });

  it('includes the sender payment details when they have set them', () => {
    const { alice, bob } = owedByTwo();
    setPaymentHandle(alice.id, 'paypal.me/alice');

    const toBob = send('!remind', alice).find((m) => m.userId === bob.id);
    expect(toBob?.text).toContain('paypal.me/alice');
  });

  it('will not nudge the same person twice in a day', () => {
    const { alice, bob } = owedByTwo();
    send('!remind', alice);

    const second = send('!remind', alice);
    expect(second.some((m) => m.userId === bob.id)).toBe(false);
    expect(second.find((m) => m.userId === alice.id)?.text.toLowerCase()).toContain('reminded');
  });

  it('allows another nudge once the cooldown has passed', () => {
    const { alice, bob } = owedByTwo();
    send('!remind', alice);

    // Backdate the reminders past the cooldown.
    run(
      'UPDATE payment_reminders SET sent_at = ?',
      DateTime.utc().minus({ hours: REMINDER_COOLDOWN_HOURS + 1 }).toISO()!,
    );

    expect(send('!remind', alice).some((m) => m.userId === bob.id)).toBe(true);
  });

  it('says so when nobody owes anything', () => {
    const alice = user('Alice');
    const out = send('!remind', alice);
    expect(out[0]!.text.toLowerCase()).toContain('nobody owes you');
  });

  it('can target one person by name', () => {
    const { alice, bob, carol } = owedByTwo();
    const out = send('!remind Bob', alice);

    expect(out.some((m) => m.userId === bob.id)).toBe(true);
    expect(out.some((m) => m.userId === carol.id)).toBe(false);
  });

  it('never reminds someone the sender actually owes', () => {
    // Bob is owed by Alice, so Bob running remind must not nudge Alice's debtors
    // or Alice herself the wrong way round.
    const alice = user('Alice');
    const bob = user('Bob');
    const b = booking(alice, { totalCostCents: 2000, minPlayers: 2, maxPlayers: 2 });
    joinBooking(b.code, bob);
    settleBooking(b.id); // Bob owes Alice

    const out = send('!remind', bob);
    expect(out[0]!.text.toLowerCase()).toContain('nobody owes you');
    expect(pendingReminders(bob.id, GROUP).due).toHaveLength(0);
  });

  it('skips a person whose data was erased', () => {
    const { alice, bob } = owedByTwo();
    run(`UPDATE users SET anonymised_at = ?, wa_id = 'deleted:' || id WHERE id = ?`, inHours(-1), bob.id);

    const out = send('!remind', alice);
    expect(out.some((m) => m.userId === bob.id)).toBe(false);
  });

  it('works in every language', () => {
    for (const lang of ['en', 'de', 'pt'] as const) {
      freshDb();
      setSettings({ language: lang });
      const { alice, bob } = owedByTwo();
      const toBob = send('!remind', alice).find((m) => m.userId === bob.id);
      expect(toBob?.text).toContain('€10.00');
      expect(toBob?.text).toContain('Alice');
    }
  });
});

describe('the balance points at remind when there is money to collect', () => {
  it('mentions the command when someone owes you', () => {
    const { alice } = owedByTwo();
    const balance = send('!balance', alice)[0]!.text;

    expect(balance).toContain('owes you');
    expect(balance).toContain('!remind');
  });

  it('uses the configured prefix in the hint', () => {
    setSettings({ commandPrefix: '.' });
    const { alice } = owedByTwo();
    expect(send('.balance', alice)[0]!.text).toContain('.remind');
  });

  it('stays quiet when you only owe money', () => {
    // Bob owes Alice, so Bob's balance has nothing to chase.
    const alice = user('Alice');
    const bob = user('Bob');
    const b = booking(alice, { totalCostCents: 2000, minPlayers: 2, maxPlayers: 2 });
    joinBooking(b.code, bob);
    settleBooking(b.id);

    const balance = send('!balance', bob)[0]!.text;
    expect(balance).toContain('You owe');
    expect(balance).not.toContain('remind');
  });

  it('stays quiet when everything is settled', () => {
    const alice = user('Alice');
    expect(send('!balance', alice)[0]!.text).not.toContain('remind');
  });
});

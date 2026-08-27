import { beforeEach, describe, expect, it } from 'vitest';
import { handleCommand, type CommandContext, type OutgoingMessage } from '../src/bot/commands.js';
import { parseMessage } from '../src/bot/parser.js';
import { joinBooking } from '../src/domain/bookings.js';
import { balanceFor, settleBooking } from '../src/domain/ledger.js';
import { getSettings, setSettings } from '../src/domain/settings.js';
import { anonymiseUser, displayName, upsertUser, type User } from '../src/domain/users.js';
import { t } from '../src/i18n/index.js';
import { booking, freshDb } from './helpers.js';

/** Two different people who both call themselves "Daniel G". */
function twoDaniels() {
  const me = upsertUser('4915100000001@s.whatsapp.net', 'Guilherme');
  const a = upsertUser('4915100000002@s.whatsapp.net', 'Daniel G');
  const b = upsertUser('5511900000003@s.whatsapp.net', 'Daniel G');
  return { me, a, b };
}

function send(text: string, as: User, opts: Partial<CommandContext> = {}): OutgoingMessage[] {
  const parsed = parseMessage(text, { prefix: '!', prefixOptional: true });
  if (parsed.kind !== 'command') throw new Error(`not a command: ${text}`);
  return handleCommand(parsed.command, {
    user: as,
    isAdmin: as.is_admin === 1,
    chatId: 'dm',
    isGroup: false,
    dict: t('en'),
    settings: getSettings(),
    mentionedUserIds: [],
    ...opts,
  });
}

const textOf = (m: OutgoingMessage[]) => m.map((x) => x.text).join('\n');

beforeEach(() => freshDb());

describe('people who share a name', () => {
  it('stay separate identities with separate debts', () => {
    const { me, a, b } = twoDaniels();
    const bk = booking(me, { totalCostCents: 3000, minPlayers: 3, maxPlayers: 3 });
    joinBooking(bk.code, a);
    joinBooking(bk.code, b);
    settleBooking(bk.id);

    expect(a.id).not.toBe(b.id);
    expect(balanceFor(a.id)).toEqual([{ otherUserId: me.id, cents: 1000 }]);
    expect(balanceFor(b.id)).toEqual([{ otherUserId: me.id, cents: 1000 }]);
  });

  it('are shown apart once the name collides', () => {
    const { a, b } = twoDaniels();
    expect(displayName(a)).not.toBe(displayName(b));
    expect(displayName(a)).toContain('Daniel G');
    expect(displayName(a)).toContain('0002');
    expect(displayName(b)).toContain('0003');
  });

  it('leaves a unique name completely alone', () => {
    const { me } = twoDaniels();
    expect(displayName(me)).toBe('Guilherme');
  });

  it('gains a suffix the moment a second person takes the same name', () => {
    const first = upsertUser('4915100000009@s.whatsapp.net', 'Rafa');
    expect(displayName(first)).toBe('Rafa');

    upsertUser('4915100000010@s.whatsapp.net', 'Rafa');
    // The cache must notice the new arrival, not keep serving the old answer.
    expect(displayName(first)).toContain('(');
  });

  it('goes back to the plain name when the other person is erased', () => {
    const { a, b } = twoDaniels();
    expect(displayName(a)).toContain('(');

    anonymiseUser(b.id);
    expect(displayName(a)).toBe('Daniel G');
  });

  it('shows two distinguishable lines on a balance', () => {
    const { me, a, b } = twoDaniels();
    const bk = booking(me, { totalCostCents: 3000, minPlayers: 3, maxPlayers: 3 });
    joinBooking(bk.code, a);
    joinBooking(bk.code, b);
    settleBooking(bk.id);

    // First message is the personal balance card; an admin also gets the
    // group-wide overview after it, which names everyone again.
    const lines = send('!balance', me)[0]!
      .text.split('\n')
      .filter((l) => l.includes('Daniel G'));
    expect(lines).toHaveLength(2);
    expect(lines[0]).not.toBe(lines[1]);
  });
});

describe('paying one of two same-named people', () => {
  beforeEach(() => setSettings({ paymentConfirmationMode: 'both' }));

  function debtToBoth() {
    const { me, a, b } = twoDaniels();
    for (const [payer, other] of [[a, b], [b, a]] as const) {
      const bk = booking(payer, { totalCostCents: 2000, minPlayers: 2, maxPlayers: 2 });
      joinBooking(bk.code, me);
      settleBooking(bk.id);
      void other;
    }
    return { me, a, b };
  }

  it('refuses rather than guessing when the name is ambiguous', () => {
    const { me, a, b } = debtToBoth();
    const out = textOf(send('!confirm Daniel G', me));

    expect(out).toContain('Several people match');
    expect(out).toContain('@'); // tells them how to resolve it
    // Nothing was paid off by guessing.
    expect(balanceFor(me.id)).toHaveLength(2);
    void a;
    void b;
  });

  it('accepts the exact label the bot printed', () => {
    const { me, a } = debtToBoth();
    const out = textOf(send(`!confirm ${displayName(a)}`, me));

    expect(out).toContain('Payment recorded');
    expect(balanceFor(me.id).find((x) => x.otherUserId === a.id)).toBeUndefined();
  });

  it('still resolves an @-mention without any name text', () => {
    const { me, b } = debtToBoth();
    const out = textOf(send('!confirm', me, { mentionedUserIds: [b.id] }));

    expect(out).toContain('Payment recorded');
    expect(balanceFor(me.id).find((x) => x.otherUserId === b.id)).toBeUndefined();
  });

  it('does not mistake a bare amount for a phone fragment', () => {
    const me = upsertUser('4915100000001@s.whatsapp.net', 'Guilherme');
    const solo = upsertUser('4915100000004@s.whatsapp.net', 'Solo');
    const bk = booking(solo, { totalCostCents: 2000, minPlayers: 2, maxPlayers: 2 });
    joinBooking(bk.code, me);
    settleBooking(bk.id);

    // "10" is ten euros, not part of a number.
    const out = textOf(send('!confirm Solo 10', me));
    expect(out).toContain('Payment recorded');
    expect(out).toContain('€10.00');
  });
});

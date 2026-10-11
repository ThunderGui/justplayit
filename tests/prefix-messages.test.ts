import { beforeEach, describe, expect, it } from 'vitest';
import { handleCommand, type CommandContext, type OutgoingMessage } from '../src/bot/commands.js';
import { parseMessage } from '../src/bot/parser.js';
import { joinBooking } from '../src/domain/bookings.js';
import { getSettings, setSettings } from '../src/domain/settings.js';
import { SUPPORTED_LANGUAGES, t } from '../src/i18n/index.js';
import type { User } from '../src/domain/users.js';
import { GROUP, booking, freshDb, inHours, user } from './helpers.js';

/**
 * Any message that tells someone what to type must use the configured prefix.
 * The group had "." configured while these messages said "Reply YES", which is
 * silently wrong: a bare YES in a group is not a command and is ignored.
 */
describe('messages that name a command carry the prefix', () => {
  it.each(SUPPORTED_LANGUAGES)('in %s', (lang) => {
    const dict = t(lang);
    const p = '#'; // deliberately not the default

    expect(dict.common.confirmYesNo(p)).toContain(`${p}yes`);
    expect(dict.common.confirmYesNo(p)).toContain(`${p}no`);
    expect(dict.booking.listEmpty(p)).toContain(`${p}book`);
    expect(dict.misc.privacyNotice(p)).toContain(`${p}forgetme`);
  });

  it.each(SUPPORTED_LANGUAGES)('never says a bare YES in %s', (lang) => {
    // The exact wording that prompted this fix.
    expect(t(lang).common.confirmYesNo('.')).not.toMatch(/\bYES\b/);
  });
});

describe('the live prompts use the configured prefix', () => {
  beforeEach(() => {
    freshDb();
    setSettings({ commandPrefix: '.' });
  });

  function send(text: string, as: User, opts: Partial<CommandContext> = {}): OutgoingMessage[] {
    const settings = getSettings();
    const parsed = parseMessage(text, { prefix: settings.commandPrefix, prefixOptional: true });
    if (parsed.kind !== 'command') throw new Error(`not a command: ${text}`);
    return handleCommand(parsed.command, {
      groupId: GROUP,
      user: as,
      isAdmin: as.is_admin === 1,
      chatId: 'group',
      isGroup: true,
      dict: t(settings.language),
      settings,
      mentionedUserIds: [],
      ...opts,
    });
  }

  it('tells a late leaver to reply .yes, not YES', () => {
    const alice = user('Alice');
    const bob = user('Bob');
    const b = booking(alice, { startsAtIso: inHours(5) }); // inside the cancel window
    joinBooking(b.code, bob);

    const text = send(`.leave ${b.code}`, bob)[0]!.text;
    expect(text).toContain('.yes');
    expect(text).toContain('.no');
    expect(text).not.toMatch(/\bYES\b/);
  });

  it('answers .yes typed with the configured prefix', () => {
    const alice = user('Alice');
    const bob = user('Bob');
    const b = booking(alice, { startsAtIso: inHours(5) });
    joinBooking(b.code, bob);

    send(`.leave ${b.code}`, bob);
    // Exactly what the prompt told them to send.
    const out = send('.yes', bob).map((m) => m.text).join('\n');
    expect(out).toContain('Bob');
  });

  it('points at .book when nothing is scheduled', () => {
    expect(send('.list', user('Alice'))[0]!.text).toContain('.book');
  });
});

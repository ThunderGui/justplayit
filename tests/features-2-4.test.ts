import { beforeEach, describe, expect, it } from 'vitest';
import { handleCommand, type CommandContext, type OutgoingMessage } from '../src/bot/commands.js';
import { parseMessage } from '../src/bot/parser.js';
import { bookingTitle } from '../src/bot/render.js';
import { updateGroup } from '../src/domain/groups.js';
import { getSettings } from '../src/domain/settings.js';
import { t } from '../src/i18n/index.js';
import type { User } from '../src/domain/users.js';
import { GROUP, booking, freshDb, user } from './helpers.js';

function send(text: string, as: User, opts: Partial<CommandContext> = {}): OutgoingMessage[] {
  const settings = getSettings(GROUP);
  const parsed = parseMessage(text, { prefix: settings.commandPrefix, prefixOptional: opts.isGroup === false });
  if (parsed.kind !== 'command') throw new Error('not a command');
  return handleCommand(parsed.command, {
    groupId: GROUP, user: as, isAdmin: as.is_admin === 1, chatId: 'group',
    isGroup: true, dict: t(settings.language), settings, mentionedUserIds: [], ...opts,
  });
}

describe('feature 2: admin help goes private', () => {
  beforeEach(() => freshDb());

  it('sends an admin the help privately, acknowledging in the group', () => {
    const admin = user('Admin'); // first user is admin
    const out = send('!help', admin, { isGroup: true });
    expect(out.find((m) => m.target === 'dm')?.userId).toBe(admin.id);
    expect(out.find((m) => m.target === 'dm')?.text).toContain('Admin'); // admin section
    const ack = out.find((m) => m.target === 'origin');
    expect(ack?.text).not.toContain('settle'); // the command list did not leak to the group
  });

  it('gives a normal member help in the group', () => {
    user('Admin');
    const bob = user('Bob');
    const out = send('!help', bob, { isGroup: true });
    expect(out).toHaveLength(1);
    expect(out[0]!.target).toBe('origin');
  });
});

describe('feature 4: sport-aware calendar titles', () => {
  beforeEach(() => freshDb());

  it('titles a padel booking "Padel —"', () => {
    const b = booking(user('Alice'));
    expect(bookingTitle(b)).toMatch(/^Padel — /);
  });

  it('titles a tennis group\'s booking "Tennis —"', () => {
    updateGroup(GROUP, { sport: 'tennis' });
    const b = booking(user('Alice'));
    expect(bookingTitle(b)).toMatch(/^Tennis — /);
  });
});

describe('feature 4: tennis roster defaults', () => {
  it('defaults a tennis group to 2 min / 4 max players', () => {
    freshDb({}, 'tennis');
    const s = getSettings(GROUP);
    expect(s.defaultMinPlayers).toBe(2);
    expect(s.defaultMaxPlayers).toBe(4);
  });

  it('keeps padel at 4 / 4', () => {
    freshDb({}, 'padel');
    const s = getSettings(GROUP);
    expect(s.defaultMinPlayers).toBe(4);
    expect(s.defaultMaxPlayers).toBe(4);
  });
});

import { beforeEach, describe, expect, it } from 'vitest';
import { handleCommand, type CommandContext, type OutgoingMessage } from '../src/bot/commands.js';
import { parseMessage } from '../src/bot/parser.js';
import { ensureMember, updateGroup } from '../src/domain/groups.js';
import { getSettings } from '../src/domain/settings.js';
import { t } from '../src/i18n/index.js';
import type { User } from '../src/domain/users.js';
import { GROUP, booking, freshDb, inHours, otherGroup, user } from './helpers.js';

function run(text: string, as: User, isGroup: boolean): OutgoingMessage[] {
  const p = parseMessage(text, { prefix: '!', prefixOptional: !isGroup });
  if (p.kind !== 'command') throw new Error('not a command: ' + text);
  return handleCommand(p.command, {
    groupId: GROUP, user: as, isAdmin: false, chatId: isGroup ? 'g' : 'dm', isGroup,
    dict: t('en'), settings: getSettings(GROUP), mentionedUserIds: [],
  });
}

beforeEach(() => freshDb());

describe('parser recognises list-all forms', () => {
  it.each(['!listall', '!list all', '!lsa', '!list-all'])('%s → listall', (text) => {
    const p = parseMessage(text, { prefix: '!', prefixOptional: true });
    expect(p.kind === 'command' && p.command.name).toBe('listall');
  });
  it('plain !list stays list', () => {
    const p = parseMessage('!list', { prefix: '!', prefixOptional: true });
    expect(p.kind === 'command' && p.command.name).toBe('list');
  });
});

describe('.listall — games across all the user\'s groups', () => {
  function setup() {
    updateGroup(GROUP, { name: 'Padel FFM' });
    const gui = user('Gui'); // member of GROUP (padel)
    const tennis = otherGroup('Tennis FFM', 'tennis');
    ensureMember(tennis, gui.id); // also a member here
    const notMine = otherGroup('Strangers', 'padel'); // gui is NOT a member

    booking(user('Gui'), { groupId: GROUP, startsAtIso: inHours(48) }); // padel, later
    booking(user('T', tennis), { groupId: tennis, startsAtIso: inHours(12) }); // tennis, sooner
    booking(user('S', notMine), { groupId: notMine, startsAtIso: inHours(24) }); // not the user's group
    return { gui, tennis, notMine };
  }

  it('DMs the list, tagged by group + sport, sorted by time, only the user\'s groups', () => {
    const { gui } = setup();
    const out = run('!listall', gui, true);

    const dm = out.find((m) => m.target === 'dm');
    expect(dm?.userId).toBe(gui.id);
    const text = dm!.text;
    expect(text).toContain('Group: Padel FFM');   // GROUP's name (freshDb leaves default; see below)
    expect(text).toContain('Group: Tennis FFM');
    expect(text).toContain('Sport: Tennis');
    expect(text).toContain('Sport: Padel');
    expect(text).not.toContain('Strangers');       // a group the user isn't in is excluded

    // ordered by time: the tennis game (inHours 12) appears before the padel one (48)
    expect(text.indexOf('Tennis FFM')).toBeLessThan(text.indexOf('Padel FFM'));
  });

  it('also leaves a notice in the group when used there', () => {
    const { gui } = setup();
    const out = run('!listall', gui, true);
    const notice = out.find((m) => m.target !== 'dm');
    expect(notice).toBeDefined();
    expect(notice!.text.toLowerCase()).toContain('private');
  });

  it('in a DM, sends only the list — no group notice', () => {
    const { gui } = setup();
    const out = run('listall', gui, false);
    expect(out.filter((m) => m.target === 'dm')).toHaveLength(1);
    expect(out.filter((m) => m.target !== 'dm')).toHaveLength(0);
  });

  it('handles a user with no upcoming games', () => {
    const solo = user('Solo');
    const out = run('listall', solo, false);
    expect(out[0]!.target).toBe('dm');
    expect(out[0]!.text.toLowerCase()).toContain('no upcoming games');
  });
});

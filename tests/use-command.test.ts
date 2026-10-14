import { beforeEach, describe, expect, it } from 'vitest';
import { handleCommand, type CommandContext, type OutgoingMessage } from '../src/bot/commands.js';
import { parseMessage } from '../src/bot/parser.js';
import { run } from '../src/db/index.js';
import { ensureMember, getDmGroup, updateGroup } from '../src/domain/groups.js';
import { getSettings } from '../src/domain/settings.js';
import { t } from '../src/i18n/index.js';
import type { User } from '../src/domain/users.js';
import { GROUP, freshDb, otherGroup, user } from './helpers.js';

let g2: number;
function twoGroupAdmin(): User {
  updateGroup(GROUP, { name: 'Padel FFM' });
  g2 = otherGroup('Tennis FFM');
  const u = user('Admin'); // member of GROUP
  ensureMember(g2, u.id); // also a member of g2
  return u;
}

function dm(text: string, as: User): OutgoingMessage[] {
  const p = parseMessage(text, { prefix: '!', prefixOptional: true });
  if (p.kind !== 'command') throw new Error('not a command: ' + text);
  const ctx: CommandContext = {
    groupId: GROUP, user: as, isAdmin: true, chatId: 'dm', isGroup: false,
    dict: t('en'), settings: getSettings(GROUP), mentionedUserIds: [],
  };
  return handleCommand(p.command, ctx);
}
const textOf = (m: OutgoingMessage[]) => m.map((x) => x.text).join('\n');

beforeEach(() => freshDb());

describe('.use — pick a group in a private chat', () => {
  it('sets the group and remembers it', () => {
    const u = twoGroupAdmin();
    expect(textOf(dm('!use Tennis', u))).toContain('Tennis FFM');
    expect(getDmGroup(u.id)?.id).toBe(g2);
  });

  it('bare .use shows the current selection', () => {
    const u = twoGroupAdmin();
    dm('!use Tennis', u);
    expect(textOf(dm('!use', u))).toContain('Tennis FFM');
  });

  it('.use none clears it', () => {
    const u = twoGroupAdmin();
    dm('!use Tennis', u);
    expect(textOf(dm('!use none', u))).toMatch(/Cleared/i);
    expect(getDmGroup(u.id)).toBeUndefined();
  });

  it('rejects a group the admin is not in', () => {
    const u = twoGroupAdmin();
    expect(textOf(dm('!use Nowhere', u))).toContain('do not see a group');
    expect(getDmGroup(u.id)).toBeUndefined();
  });

  it('says so when the person is only in one group', () => {
    updateGroup(GROUP, { name: 'Padel FFM' });
    const solo = user('Solo'); // only in GROUP
    expect(textOf(dm('!use whatever', solo))).toContain('only in one group');
  });

  it('refuses in a group chat', () => {
    const u = twoGroupAdmin();
    const p = parseMessage('!use Tennis', { prefix: '!', prefixOptional: false });
    if (p.kind !== 'command') throw new Error('nope');
    const out = handleCommand(p.command, {
      groupId: GROUP, user: u, isAdmin: true, chatId: 'g', isGroup: true,
      dict: t('en'), settings: getSettings(GROUP), mentionedUserIds: [],
    });
    expect(textOf(out)).toContain('private chat');
  });

  it('forgets a selection once the admin leaves that group (membership gone)', () => {
    const u = twoGroupAdmin();
    dm('!use Tennis', u);
    // simulate losing membership of g2
    run('DELETE FROM group_members WHERE group_id = ? AND user_id = ?', g2, u.id);
    expect(getDmGroup(u.id)).toBeUndefined();
  });
});

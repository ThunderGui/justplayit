import { beforeEach, describe, expect, it } from 'vitest';
import { handleCommand, type CommandContext, type OutgoingMessage } from '../src/bot/commands.js';
import { parseMessage } from '../src/bot/parser.js';
import { listPlaces } from '../src/domain/places.js';
import { getSettings } from '../src/domain/settings.js';
import { t } from '../src/i18n/index.js';
import type { User } from '../src/domain/users.js';
import { GROUP, freshDb, user } from './helpers.js';

function send(text: string, as: User, isAdmin = false): OutgoingMessage[] {
  const parsed = parseMessage(text, { prefix: '!', prefixOptional: true });
  if (parsed.kind !== 'command') throw new Error('not a command: ' + text);
  return handleCommand(parsed.command, {
    groupId: GROUP, user: as, isAdmin, chatId: 'g', isGroup: true,
    dict: t('en'), settings: getSettings(GROUP), mentionedUserIds: [],
  });
}
const textOf = (m: OutgoingMessage[]) => m.map((x) => x.text).join('\n');

beforeEach(() => freshDb());

describe('managing places from chat', () => {
  it('lets an admin add a place with an address', () => {
    const out = send('!place add Gibson Beach Club | Mainzer Landstr. 23', user('Admin'), true);
    expect(textOf(out)).toContain('Added place: Gibson Beach Club');
    const places = listPlaces(GROUP);
    expect(places).toHaveLength(1);
    expect(places[0]!.name).toBe('Gibson Beach Club');
    expect(places[0]!.address).toBe('Mainzer Landstr. 23');
  });

  it('refuses a non-admin trying to add', () => {
    const out = send('!place add Secret Court', user('Bob'), false);
    expect(textOf(out).toLowerCase()).toContain('only an admin');
    expect(listPlaces(GROUP)).toHaveLength(0);
  });

  it('lists places for anyone', () => {
    send('!place add Ocean Club', user('Admin'), true);
    const out = send('!places', user('Bob'), false);
    expect(textOf(out)).toContain('Ocean Club');
  });

  it('rejects a duplicate name', () => {
    send('!place add Ocean Club', user('Admin'), true);
    const out = send('!place add ocean club', user('Admin'), true);
    expect(textOf(out)).toContain('already a place');
    expect(listPlaces(GROUP)).toHaveLength(1);
  });

  it('removes a place by name', () => {
    send('!place add Ocean Club', user('Admin'), true);
    const out = send('!place remove Ocean', user('Admin'), true);
    expect(textOf(out)).toMatch(/Removed place|Hid place/);
    expect(listPlaces(GROUP)).toHaveLength(0);
  });

  it('says so when removing an unknown place', () => {
    const out = send('!place remove Nowhere', user('Admin'), true);
    expect(textOf(out)).toContain('no place called');
  });

  it('shows usage for an unknown subcommand', () => {
    expect(textOf(send('!place frobnicate', user('Admin'), true))).toContain('place add');
  });
});

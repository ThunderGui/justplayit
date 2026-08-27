import { describe, expect, it } from 'vitest';
import { field, parseFields, parseMessage } from '../src/bot/parser.js';

const group = { prefix: '!', prefixOptional: false };
const dm = { prefix: '!', prefixOptional: true };

describe('command parsing', () => {
  it('ignores ordinary group chatter', () => {
    expect(parseMessage('anyone up for a game later?', group).kind).toBe('not_a_command');
    expect(parseMessage('', group).kind).toBe('not_a_command');
  });

  it('requires the prefix in a group but not in a direct chat', () => {
    expect(parseMessage('list', group).kind).toBe('not_a_command');
    const direct = parseMessage('list', dm);
    expect(direct.kind).toBe('command');
    if (direct.kind === 'command') expect(direct.name ?? direct.command.name).toBe('list');
  });

  it('understands the wording from the design document', () => {
    for (const [input, expected] of [
      ['!include booking', 'book'],
      ['!exclude booking A7K2', 'cancel'],
      ['!list', 'list'],
      ['!join A7K2', 'join'],
      ['!leave A7K2', 'leave'],
      ['!balance', 'balance'],
      ['!confirm', 'confirm'],
      ['!help', 'help'],
    ] as const) {
      const result = parseMessage(input, group);
      expect(result.kind).toBe('command');
      if (result.kind === 'command') expect(result.command.name).toBe(expected);
    }
  });

  it('prefers the longer multi-word alias over its first word', () => {
    // "include booking" and "include" both exist; the longer one must win.
    const result = parseMessage('!include booking\nplace: Padel Base', group);
    expect(result.kind).toBe('command');
    if (result.kind === 'command') {
      expect(result.command.name).toBe('book');
      expect(field(result.command.fields, 'place')).toBe('Padel Base');
    }
  });

  it('reports an unknown command only when the prefix was used', () => {
    const prefixed = parseMessage('!frobnicate', group);
    expect(prefixed.kind).toBe('unknown_command');

    // In a DM, unrecognised text is conversation, not a typo worth correcting.
    expect(parseMessage('good morning', dm).kind).toBe('not_a_command');
  });

  it('keeps arguments and the raw remainder', () => {
    const result = parseMessage('!report the balance is wrong for A7K2', group);
    expect(result.kind).toBe('command');
    if (result.kind === 'command') {
      expect(result.command.name).toBe('report');
      expect(result.command.rest).toBe('the balance is wrong for A7K2');
      expect(result.command.args[0]).toBe('the');
    }
  });
});

describe('field parsing', () => {
  it('reads a multi-line booking the way someone would type it on a phone', () => {
    const fields = parseFields(
      ['place: Padel Base', 'date: 03/09', 'time: 19:00', 'cost: 40', 'max: 4'].join('\n'),
    );
    expect(field(fields, 'place')).toBe('Padel Base');
    expect(field(fields, 'date')).toBe('03/09');
    expect(field(fields, 'time')).toBe('19:00');
    expect(field(fields, 'cost')).toBe('40');
    expect(field(fields, 'max')).toBe('4');
  });

  it('keeps colons inside a value', () => {
    const fields = parseFields('time: 19:00\nurl: https://playtomic.io/match/1');
    expect(field(fields, 'time')).toBe('19:00');
    expect(field(fields, 'url')).toBe('https://playtomic.io/match/1');
  });

  it('accepts inline key=value pairs', () => {
    const fields = parseFields('place="Padel Base" cost=40 max=4');
    expect(field(fields, 'place')).toBe('Padel Base');
    expect(field(fields, 'cost')).toBe('40');
  });

  it('accepts synonyms for the same field', () => {
    expect(field(parseFields('price: 40'), 'cost')).toBe('40');
    expect(field(parseFields('kosten: 40'), 'cost')).toBe('40');
    expect(field(parseFields('custo: 40'), 'cost')).toBe('40');
    expect(field(parseFields('club: Base'), 'place')).toBe('Base');
    expect(field(parseFields('link: https://x.io'), 'url')).toBe('https://x.io');
  });

  it('ignores lines that are not fields', () => {
    const fields = parseFields('place: Base\njust some free text\ncost: 40');
    expect(fields.size).toBe(2);
  });
});

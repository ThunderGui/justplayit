/**
 * Command grammar. Per the design, command words stay English in every language
 * so there is exactly one syntax to document and support.
 */

export type CommandName =
  | 'help'
  | 'list'
  | 'listall'
  | 'show'
  | 'book'
  | 'external'
  | 'cancel'
  | 'join'
  | 'leave'
  | 'confirm'
  | 'approve'
  | 'reject'
  | 'balance'
  | 'remind'
  | 'settle'
  | 'places'
  | 'edit'
  | 'payment'
  | 'use'
  | 'report'
  | 'privacy'
  | 'forgetme'
  | 'yes'
  | 'no';

/**
 * Aliases include the wording from the original design ("include booking",
 * "exclude booking") plus the short forms people reach for in a hurry.
 * Multi-word aliases are matched before single words.
 */
const ALIASES: Record<string, CommandName> = {
  help: 'help', h: 'help', commands: 'help', ajuda: 'help', hilfe: 'help',

  list: 'list', calendar: 'list', bookings: 'list', games: 'list', ls: 'list',

  listall: 'listall', 'list all': 'listall', 'list-all': 'listall', 'all games': 'listall', lsa: 'listall',

  show: 'show', info: 'show', details: 'show',

  book: 'book', new: 'book', create: 'book', add: 'book',
  'include booking': 'book', include: 'book', 'add booking': 'book',

  playtomic: 'external', external: 'external', link: 'external',
  'add playtomic': 'external', 'include playtomic': 'external',

  cancel: 'cancel', delete: 'cancel', remove: 'cancel', del: 'cancel',
  'exclude booking': 'cancel', exclude: 'cancel', 'delete booking': 'cancel',

  join: 'join', in: 'join', me: 'join', '+1': 'join',
  leave: 'leave', out: 'leave', '-1': 'leave',

  confirm: 'confirm', paid: 'confirm', pay: 'confirm',
  approve: 'approve', ok: 'approve', accept: 'approve',
  reject: 'reject', deny: 'reject', dispute: 'reject',

  balance: 'balance', owe: 'balance', debts: 'balance', saldo: 'balance',

  remind: 'remind', nudge: 'remind', chase: 'remind', 'remind all': 'remind',

  settle: 'settle', close: 'settle',

  places: 'places', place: 'places', venues: 'places', venue: 'places', clubs: 'places', club: 'places',

  edit: 'edit', reschedule: 'edit', change: 'edit', modify: 'edit', move: 'edit',

  payment: 'payment', paydetails: 'payment', handle: 'payment', iban: 'payment', paypal: 'payment',

  use: 'use', switch: 'use', 'use group': 'use',

  report: 'report', bug: 'report', suggest: 'report', feedback: 'report',

  privacy: 'privacy', gdpr: 'privacy', datenschutz: 'privacy',
  forgetme: 'forgetme', 'forget me': 'forgetme', 'delete me': 'forgetme',

  yes: 'yes', y: 'yes', ja: 'yes', sim: 'yes', confirmar: 'yes',
  no: 'no', n: 'no', nein: 'no', nao: 'no', 'não': 'no',
};

const MULTI_WORD_ALIASES = Object.keys(ALIASES)
  .filter((a) => a.includes(' '))
  .sort((a, b) => b.length - a.length);

import type { ExternalMatch } from '../providers/types.js';

export interface ParsedCommand {
  name: CommandName;
  /** What the user actually typed, for error messages. */
  raw: string;
  /** Whitespace-separated tokens after the command word. */
  args: string[];
  /** Everything after the command word, untouched. */
  rest: string;
  /** `key: value` / `key=value` pairs, one per line or inline. */
  fields: Map<string, string>;
  /** Set by the dispatcher when an external link was fetched up front. */
  prefetchedMatch?: ExternalMatch | null;
}

export interface ParseOptions {
  prefix: string;
  /** In a direct chat the prefix is optional — there is nothing else to address. */
  prefixOptional: boolean;
}

export type ParseOutcome =
  | { kind: 'command'; command: ParsedCommand }
  | { kind: 'not_a_command' }
  | { kind: 'unknown_command'; raw: string };

export function parseMessage(text: string, options: ParseOptions): ParseOutcome {
  const trimmed = text.trim();
  if (!trimmed) return { kind: 'not_a_command' };

  let body = trimmed;
  const hasPrefix = body.startsWith(options.prefix);

  if (hasPrefix) {
    body = body.slice(options.prefix.length).trim();
  } else if (!options.prefixOptional) {
    return { kind: 'not_a_command' };
  }
  if (!body) return { kind: 'not_a_command' };

  const lower = body.toLowerCase();

  // Longest multi-word alias first, so "include booking" beats "include".
  let matchedAlias = MULTI_WORD_ALIASES.find(
    (alias) => lower === alias || lower.startsWith(`${alias} `) || lower.startsWith(`${alias}\n`),
  );

  if (!matchedAlias) {
    const firstWord = lower.split(/\s+/)[0]!;
    if (firstWord in ALIASES) matchedAlias = firstWord;
  }

  if (!matchedAlias) {
    // Without a prefix, unrecognised text is just conversation, not a typo.
    if (!hasPrefix) return { kind: 'not_a_command' };
    return { kind: 'unknown_command', raw: body.split(/\s+/)[0] ?? body };
  }

  const rest = body.slice(matchedAlias.length).trim();

  return {
    kind: 'command',
    command: {
      name: ALIASES[matchedAlias]!,
      raw: matchedAlias,
      args: rest ? rest.split(/\s+/) : [],
      rest,
      fields: parseFields(rest),
    },
  };
}

/**
 * Reads `key: value` pairs. Line-oriented first (the natural way to type a
 * booking on a phone), falling back to inline `key=value` tokens.
 *
 * A value may contain colons — "time: 19:00" keeps "19:00" intact — because
 * only the first separator splits the line.
 */
export function parseFields(input: string): Map<string, string> {
  const fields = new Map<string, string>();
  if (!input) return fields;

  const INLINE_PAIR = /([a-zA-Z][\w-]*)=("[^"]*"|\S+)/g;

  for (const line of input.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;

    // Decide which form this line uses before parsing it. Two or more `key=`
    // pairs means the inline form; otherwise the whole remainder of the line is
    // one value, so "notes: bring balls, 2 cans" survives intact.
    const inlinePairs = [...trimmed.matchAll(INLINE_PAIR)];
    if (inlinePairs.length >= 2) {
      for (const pair of inlinePairs) {
        fields.set(pair[1]!.toLowerCase(), pair[2]!.replace(/^"|"$/g, ''));
      }
      continue;
    }

    const match = trimmed.match(/^([a-zA-Z][\w-]*)\s*[:=]\s*(.+)$/);
    if (match) {
      fields.set(match[1]!.toLowerCase(), match[2]!.trim().replace(/^"|"$/g, ''));
    }
  }

  return fields;
}

/**
 * Field name synonyms, so `cost`, `price` and `total` all mean the same thing
 * and users do not have to memorise one spelling.
 */
const FIELD_SYNONYMS: Record<string, string[]> = {
  place: ['place', 'club', 'location', 'where', 'ort', 'local'],
  date: ['date', 'day', 'datum', 'data'],
  time: ['time', 'at', 'hour', 'uhr', 'hora'],
  cost: ['cost', 'price', 'total', 'amount', 'preis', 'kosten', 'custo', 'preco', 'preço'],
  min: ['min', 'minplayers', 'minimum', 'min-players'],
  max: ['max', 'maxplayers', 'maximum', 'max-players', 'players', 'spots'],
  court: ['court', 'platz', 'campo', 'quadra'],
  notes: ['notes', 'note', 'info', 'notiz', 'notas', 'obs'],
  cancel: ['cancel', 'limit', 'cancellimit', 'cancel-limit', 'deadline', 'frist'],
  duration: ['duration', 'length', 'dauer', 'duracao', 'duração'],
  url: ['url', 'link', 'reservation', 'booking'],
  provider: ['provider', 'platform', 'site'],
};

export function field(fields: Map<string, string>, canonical: string): string | undefined {
  for (const name of FIELD_SYNONYMS[canonical] ?? [canonical]) {
    const value = fields.get(name);
    if (value !== undefined && value !== '') return value;
  }
  return undefined;
}

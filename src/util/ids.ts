import { randomInt } from 'node:crypto';

/**
 * Booking codes get typed by hand on a phone keyboard, so the alphabet drops
 * every glyph pair people confuse: 0/O, 1/I/L, 5/S, 8/B, U/V.
 */
const ALPHABET = '234679ACDEFGHJKMNPQRTWXY';

export function randomCode(length = 4): string {
  let out = '';
  for (let i = 0; i < length; i++) out += ALPHABET[randomInt(ALPHABET.length)];
  return out;
}

/** Users type `a7k2`, `#A7K2` or `A7 K2`; all of them should resolve. */
export function normaliseCode(input: string): string {
  return input.trim().toUpperCase().replace(/[^A-Z0-9]/g, '');
}

/**
 * Generates a code not already taken, widening the code space if a short
 * namespace fills up rather than looping forever.
 */
export function generateUniqueCode(exists: (code: string) => boolean): string {
  for (let length = 4; length <= 8; length++) {
    for (let attempt = 0; attempt < 200; attempt++) {
      const code = randomCode(length);
      if (!exists(code)) return code;
    }
  }
  throw new Error('Unable to allocate a unique booking code');
}

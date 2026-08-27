/**
 * All money is integer cents. Nothing in this codebase should hold a float euro.
 */

/**
 * Both `.` and `,` are read as the decimal separator, and nothing is treated as
 * a thousands separator: "1.200" is indistinguishable from a mistyped "40.999",
 * and silently guessing turns a typo into a four-figure debt. Ambiguous input is
 * rejected so the user retypes it. Amounts with no separator are unaffected,
 * so "1200" still works for the rare expensive booking.
 */
export function parseMoneyToCents(input: string): number | null {
  const normalised = input
    .trim()
    .replace(/[€$£\s]/g, '')
    .replace(',', '.');

  if (!/^\d+(\.\d{1,2})?$/.test(normalised)) return null;

  const cents = Math.round(Number(normalised) * 100);
  return Number.isFinite(cents) ? cents : null;
}

export function formatMoney(cents: number, currency = 'EUR'): string {
  const symbol = currency === 'EUR' ? '€' : currency === 'USD' ? '$' : currency === 'GBP' ? '£' : '';
  const value = (Math.abs(cents) / 100).toFixed(2);
  const sign = cents < 0 ? '-' : '';
  return symbol ? `${sign}${symbol}${value}` : `${sign}${value} ${currency}`;
}

/**
 * Splits a total into `n` shares without losing or inventing cents.
 * The remainder is spread one cent at a time over the first shares, so
 * 40.00 across 3 players is 13.34 / 13.33 / 13.33 rather than 3 × 13.33.
 */
export function splitCents(total: number, n: number): number[] {
  if (n <= 0) return [];
  const base = Math.floor(total / n);
  const remainder = total - base * n;
  return Array.from({ length: n }, (_, i) => base + (i < remainder ? 1 : 0));
}

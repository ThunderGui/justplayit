/**
 * External booking providers (Playtomic, Padelcity, …).
 *
 * A provider turns a shared match link into the same facts the bot shows for
 * its own bookings — venue, court, time, who is in, how many slots are open —
 * except the money, which stays on the platform. The bot never books or pays
 * through a provider; it only reads, so a group can see a Playtomic game on the
 * same calendar as its self-organised ones.
 */

export interface ExternalMatch {
  /** Stable id on the provider, extracted from the link. */
  providerMatchId: string;
  provider: string;
  url: string;
  venueName: string | null;
  address: string | null;
  court: string | null;
  startsAtIso: string | null;
  endsAtIso: string | null;
  timezone: string | null;
  sport: string | null;
  /** Free-text status as the provider words it, e.g. "PENDING", "PLAYED". */
  status: string | null;
  /** Confirmed player display names, in roster order. */
  players: string[];
  slotsTotal: number | null;
  slotsFree: number | null;
  priceLabel: string | null;
}

export type FetchResult =
  | { ok: true; match: ExternalMatch }
  | { ok: false; reason: 'not_a_match_url' | 'auth_failed' | 'not_found' | 'unavailable'; detail?: string };

export interface Provider {
  /** Stable key stored on the booking, e.g. "playtomic". */
  readonly key: string;
  /** Human label shown to users, e.g. "Playtomic". */
  readonly label: string;
  /** True if this provider recognises the given URL as one of its match links. */
  matches(url: string): boolean;
  /** Pulls the canonical match id out of a link, or null if it is not one. */
  extractId(url: string): string | null;
  /** Reads the live match, or explains why it could not. */
  fetch(url: string): Promise<FetchResult>;
}

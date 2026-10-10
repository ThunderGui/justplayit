import { logger } from '../util/logger.js';
import type { ExternalMatch, FetchResult, Provider } from './types.js';

/**
 * Playtomic adapter.
 *
 * The official mobile backend is api.app.playtomic.io. It speaks plain JSON
 * over HTTPS behind CloudFront — no Cloudflare, no TLS-fingerprint gate, and
 * crucially no Firebase App Check on reads, so a server can call it with just a
 * player token. (The guides that target api.playtomic.io are out of date; that
 * host no longer resolves.)
 *
 * The bot logs in once with a dedicated throwaway Playtomic account, caches the
 * one-hour token, and refreshes it. Credentials come from config, never a
 * group's data. This reads matches; it never books or pays.
 */

const BASE = 'https://api.app.playtomic.io';
const USER_AGENT = 'JustPlayItBot/1.0';

/** app.playtomic.com/t/<code> short links and /matches/<uuid> deep links. */
const MATCH_URL = /playtomic\.(?:com|io)\/[^?#]*?matches?\/([A-Za-z0-9-]{6,})/i;
const SHORT_URL = /playtomic\.(?:com|io)\/t\/([A-Za-z0-9]+)/;

export interface PlaytomicCredentials {
  email: string;
  password: string;
}

interface TokenState {
  accessToken: string;
  refreshToken: string;
  /** Epoch ms at which the access token should be treated as stale. */
  expiresAtMs: number;
}

export class PlaytomicProvider implements Provider {
  readonly key = 'playtomic';
  readonly label = 'Playtomic';

  private token: TokenState | null = null;
  // One in-flight login shared by concurrent fetches, so a burst of links does
  // not trigger a burst of logins.
  private loginInFlight: Promise<TokenState | null> | null = null;

  constructor(
    private readonly creds: PlaytomicCredentials | null,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  /** Whether the bot has been given an account to read with. */
  get configured(): boolean {
    return this.creds != null && this.creds.email.length > 0;
  }

  matches(url: string): boolean {
    return MATCH_URL.test(url) || SHORT_URL.test(url);
  }

  extractId(url: string): string | null {
    return url.match(MATCH_URL)?.[1] ?? null;
  }

  async fetch(url: string): Promise<FetchResult> {
    if (!this.configured) return { ok: false, reason: 'unavailable', detail: 'no_credentials' };

    const id = await this.resolveId(url);
    if (!id) return { ok: false, reason: 'not_a_match_url' };

    const token = await this.ensureToken();
    if (!token) return { ok: false, reason: 'auth_failed' };

    const res = await this.call(`/v1/matches/${encodeURIComponent(id)}`, token.accessToken);

    // A stale token (someone logged the account in elsewhere, say) reads as 401;
    // drop it and try one fresh login before giving up.
    if (res.status === 401) {
      this.token = null;
      const retry = await this.ensureToken();
      if (!retry) return { ok: false, reason: 'auth_failed' };
      const res2 = await this.call(`/v1/matches/${encodeURIComponent(id)}`, retry.accessToken);
      return this.toResult(res2, id, url);
    }

    return this.toResult(res, id, url);
  }

  /** Short links need one redirect hop to reveal the match UUID. */
  private async resolveId(url: string): Promise<string | null> {
    const direct = this.extractId(url);
    if (direct) return direct;
    if (!SHORT_URL.test(url)) return null;

    try {
      const res = await this.fetchImpl(url, { method: 'HEAD', redirect: 'follow' });
      return this.extractId(res.url);
    } catch (err) {
      logger.error({ err }, 'playtomic short-link resolve failed');
      return null;
    }
  }

  private async call(path: string, accessToken: string): Promise<Response> {
    return this.fetchImpl(`${BASE}${path}`, {
      headers: {
        Authorization: `Bearer ${accessToken}`,
        Accept: 'application/json',
        'User-Agent': USER_AGENT,
      },
    });
  }

  private async toResult(res: Response, id: string, url: string): Promise<FetchResult> {
    if (res.status === 404) return { ok: false, reason: 'not_found' };
    if (res.status === 401 || res.status === 403) return { ok: false, reason: 'auth_failed' };
    if (!res.ok) return { ok: false, reason: 'unavailable', detail: `http_${res.status}` };

    try {
      const raw = (await res.json()) as PlaytomicMatch;
      return { ok: true, match: normalise(raw, id, url) };
    } catch (err) {
      logger.error({ err }, 'playtomic response parse failed');
      return { ok: false, reason: 'unavailable', detail: 'bad_json' };
    }
  }

  private async ensureToken(): Promise<TokenState | null> {
    // A minute of headroom so a token never expires mid-request.
    if (this.token && this.token.expiresAtMs - Date.now() > 60_000) return this.token;
    if (this.loginInFlight) return this.loginInFlight;

    this.loginInFlight = this.login().finally(() => {
      this.loginInFlight = null;
    });
    return this.loginInFlight;
  }

  private async login(): Promise<TokenState | null> {
    if (!this.creds) return null;
    try {
      const res = await this.fetchImpl(`${BASE}/v3/auth/login`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Accept: 'application/json',
          'User-Agent': USER_AGENT,
        },
        body: JSON.stringify({
          email: this.creds.email,
          password: this.creds.password,
          requested_user_roles: ['ROLE_CUSTOMER'],
        }),
      });

      if (!res.ok) {
        logger.error({ status: res.status }, 'playtomic login failed');
        return null;
      }

      const body = (await res.json()) as {
        access_token: string;
        refresh_token: string;
        access_token_expiration?: string;
      };

      this.token = {
        accessToken: body.access_token,
        refreshToken: body.refresh_token,
        expiresAtMs: body.access_token_expiration
          ? Date.parse(body.access_token_expiration)
          : Date.now() + 60 * 60 * 1000, // tokens last an hour
      };
      logger.info('playtomic authenticated');
      return this.token;
    } catch (err) {
      logger.error({ err }, 'playtomic login threw');
      return null;
    }
  }
}

/* ------------------------------------------------------------------ */
/* Response shape (only the fields we read)                            */
/* ------------------------------------------------------------------ */

interface PlaytomicPlayer {
  name?: string | null;
}
interface PlaytomicTeam {
  players?: PlaytomicPlayer[] | null;
  min_players?: number | null;
  max_players?: number | null;
}
interface PlaytomicMatch {
  start_date?: string | null;
  end_date?: string | null;
  sport_id?: string | null;
  status?: string | null;
  game_status?: string | null;
  resource_name?: string | null;
  price?: string | null;
  teams?: PlaytomicTeam[] | null;
  location_info?: {
    name?: string | null;
    address?: { street?: string | null; city?: string | null; timezone?: string | null } | null;
  } | null;
}

/** Translates the provider's shape into the bot's neutral ExternalMatch. */
export function normalise(raw: PlaytomicMatch, id: string, url: string): ExternalMatch {
  const teams = raw.teams ?? [];
  const players = teams
    .flatMap((t) => t.players ?? [])
    .map((p) => (p.name ?? '').trim())
    .filter((n) => n.length > 0);

  // Slots: each team's capacity summed, minus who is already in.
  const slotsTotal = teams.reduce((sum, t) => sum + (t.max_players ?? 0), 0) || null;
  const slotsFree = slotsTotal != null ? Math.max(0, slotsTotal - players.length) : null;

  const addr = raw.location_info?.address;
  const addressParts = [addr?.street, addr?.city].filter(Boolean) as string[];

  return {
    providerMatchId: id,
    provider: 'Playtomic',
    url,
    venueName: (raw.location_info?.name ?? '').trim() || null,
    address: addressParts.length > 0 ? addressParts.join(', ') : null,
    court: (raw.resource_name ?? '').trim() || null,
    startsAtIso: raw.start_date ?? null,
    endsAtIso: raw.end_date ?? null,
    timezone: addr?.timezone ?? null,
    sport: raw.sport_id ?? null,
    status: raw.game_status ?? raw.status ?? null,
    players,
    slotsTotal,
    slotsFree,
    priceLabel: raw.price ?? null,
  };
}

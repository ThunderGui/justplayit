import { logger } from '../util/logger.js';
import { DateTime } from 'luxon';
import type { ExternalMatch, FetchResult, Provider } from './types.js';

/**
 * Padelcity adapter.
 *
 * Reads a match the way the official app does, with the operator's permission:
 * a Keycloak password-grant login (confidential client `padel-city-internal`)
 * for a Bearer token, then GET /matches/{uuid} on the core API. The API wants
 * only the Bearer token and the x-app-* headers — no API key, no captcha on the
 * read path. Credentials (incl. the client secret) come from config, never a
 * group's data. This reads matches; it never books or pays.
 */

const AUTH_URL =
  'https://auth.padelcity.de/auth/realms/padel_city/protocol/openid-connect/token';
const API = 'https://api.prod.cluster.padelcity.de';
const CLIENT_ID = 'padel-city-internal';

// The app identifies itself with these. If the API's force-update check ever
// starts rejecting the version, bump PADELCITY_APP_VERSION / PADELCITY_APP_BUILD
// in the env — no code change needed. Defaults are the last known-good build.
const DEFAULT_APP_VERSION = '1.43.0';
const DEFAULT_APP_BUILD = '2390';

const UUID = /([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i;
// Shared links look like padelcity.go.link/playtab/play/match/<uuid>; the API
// path is /matches/<uuid>. Either way the uuid is in the path.
const MATCH_URL = /padelcity\.[^\s]*\/(?:playtab\/play\/)?match(?:es)?\/[0-9a-f-]{36}/i;

const TIMEOUT_MS = 10_000;

export interface PadelcityCredentials {
  email: string;
  password: string;
  clientSecret: string;
  appVersion?: string;
  appBuild?: string;
}

interface TokenState {
  accessToken: string;
  expiresAtMs: number;
}

export class PadelcityProvider implements Provider {
  readonly key = 'padelcity';
  readonly label = 'Padelcity';

  private token: TokenState | null = null;
  private loginInFlight: Promise<TokenState | null> | null = null;

  constructor(
    private readonly creds: PadelcityCredentials | null,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  get configured(): boolean {
    return this.creds != null && this.creds.email.length > 0 && this.creds.clientSecret.length > 0;
  }

  private get appHeaders(): Record<string, string> {
    return {
      Accept: 'application/json',
      'x-app-version': this.creds?.appVersion || DEFAULT_APP_VERSION,
      'x-app-build': this.creds?.appBuild || DEFAULT_APP_BUILD,
      'x-app-os': 'android',
      'User-Agent': 'JustPlayItBot/1.0',
    };
  }

  matches(url: string): boolean {
    return MATCH_URL.test(url);
  }

  extractId(url: string): string | null {
    return url.match(UUID)?.[1] ?? null;
  }

  async fetch(url: string): Promise<FetchResult> {
    if (!this.configured) return { ok: false, reason: 'unavailable', detail: 'no_credentials' };

    const id = this.extractId(url);
    if (!id) return { ok: false, reason: 'not_a_match_url' };

    const token = await this.ensureToken();
    if (!token) return { ok: false, reason: 'auth_failed' };

    const res = await this.call(`/matches/${encodeURIComponent(id)}`, token.accessToken);

    // A stale token reads as 401; drop it and try one fresh login.
    if (res.status === 401) {
      this.token = null;
      const retry = await this.ensureToken();
      if (!retry) return { ok: false, reason: 'auth_failed' };
      return this.toResult(await this.call(`/matches/${encodeURIComponent(id)}`, retry.accessToken), id, url);
    }
    return this.toResult(res, id, url);
  }

  private async call(path: string, accessToken: string): Promise<Response> {
    return this.fetchImpl(`${API}${path}`, {
      headers: { Authorization: `Bearer ${accessToken}`, ...this.appHeaders },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  }

  private async toResult(res: Response, id: string, url: string): Promise<FetchResult> {
    if (res.status === 404) return { ok: false, reason: 'not_found' };
    if (res.status === 401 || res.status === 403) return { ok: false, reason: 'auth_failed' };
    if (!res.ok) return { ok: false, reason: 'unavailable', detail: `http_${res.status}` };
    try {
      const raw = (await res.json()) as PadelcityMatch;
      return { ok: true, match: normalise(raw, id, url) };
    } catch (err) {
      logger.error({ err }, 'padelcity response parse failed');
      return { ok: false, reason: 'unavailable', detail: 'bad_json' };
    }
  }

  private async ensureToken(): Promise<TokenState | null> {
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
      const body = new URLSearchParams({
        grant_type: 'password',
        client_id: CLIENT_ID,
        client_secret: this.creds.clientSecret,
        username: this.creds.email,
        password: this.creds.password,
      });
      const res = await this.fetchImpl(AUTH_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded', ...this.appHeaders },
        body: body.toString(),
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
      if (!res.ok) {
        logger.error({ status: res.status }, 'padelcity login failed');
        return null;
      }
      const data = (await res.json()) as { access_token: string; expires_in?: number };
      this.token = {
        accessToken: data.access_token,
        expiresAtMs: Date.now() + (data.expires_in ?? 300) * 1000,
      };
      logger.info('padelcity authenticated');
      return this.token;
    } catch (err) {
      logger.error({ err }, 'padelcity login threw');
      return null;
    }
  }
}

function money(fee: PadelcityFee | null | undefined): string | null {
  if (!fee) return null;
  const cents = Number(fee.amount);
  if (!Number.isFinite(cents)) return null;
  return `${fee.symbol ?? ''}${(cents / 100).toFixed(2)}`;
}

function address(club: PadelcityMatch['club']): string | null {
  const a = club?.address;
  if (!a) return null;
  const line1 = [a.streetName, a.buildingNumber].filter(Boolean).join(' ').trim();
  const line2 = [a.postalCode, a.localityName].filter(Boolean).join(' ').trim();
  const parts = [line1, line2].filter((p) => p.length > 0);
  return parts.length > 0 ? parts.join(', ') : null;
}

function normalise(raw: PadelcityMatch, id: string, url: string): ExternalMatch {
  const slots = raw.slots ?? [];
  const players = slots
    .filter((s) => s.playerContext)
    .map((s) =>
      // The API sometimes has stray spaces inside the name fields, so trim each
      // part before joining rather than ending up with "Jörg  Heid".
      [s.playerContext!.firstName, s.playerContext!.lastName]
        .map((part) => (part ?? '').trim())
        .filter((part) => part.length > 0)
        .join(' '),
    )
    .filter((n) => n.length > 0);
  const slotsTotal = slots.length;
  const slotsFree = slots.filter((s) => !s.playerContext).length;

  const startsAt = raw.matchPeriod?.startsAt
    ? (DateTime.fromISO(raw.matchPeriod.startsAt).toUTC().toISO() ?? null)
    : null;
  const endsAt = raw.matchPeriod?.endsAt
    ? (DateTime.fromISO(raw.matchPeriod.endsAt).toUTC().toISO() ?? null)
    : null;

  return {
    providerMatchId: id,
    provider: 'Padelcity',
    url,
    venueName: raw.club?.name ?? null,
    address: address(raw.club),
    court: raw.court?.name ?? null,
    startsAtIso: startsAt,
    endsAtIso: endsAt,
    timezone: null,
    sport: raw.court?.sportType ?? raw.sportType ?? null,
    status: raw.cancelledAt ? 'CANCELLED' : raw.terminatedAt ? 'TERMINATED' : (raw.phase ?? raw.kind ?? null),
    players,
    slotsTotal: slotsTotal > 0 ? slotsTotal : null,
    slotsFree: slotsTotal > 0 ? slotsFree : null,
    priceLabel: money(raw.slotFee),
  };
}

/* ---- Response shape (only the fields we read) ---- */
interface PadelcityFee {
  amount: string;
  currency: string;
  symbol: string;
}
interface PadelcityMatch {
  kind?: string;
  phase?: string;
  cancelledAt?: string | null;
  terminatedAt?: string | null;
  sportType?: string;
  matchPeriod?: { startsAt?: string; endsAt?: string; durationInSeconds?: number };
  court?: { name?: string; locationType?: string; courtType?: string; sportType?: string };
  club?: {
    name?: string;
    address?: { streetName?: string; buildingNumber?: string; postalCode?: string; localityName?: string };
  };
  slots?: Array<{
    index?: number;
    player?: string | null;
    playerContext?: { firstName?: string; lastName?: string; performanceClass?: number; isHost?: boolean } | null;
  }>;
  slotFee?: PadelcityFee;
}

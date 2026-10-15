import crypto from 'node:crypto';
import cookieParser from 'cookie-parser';
import { DateTime } from 'luxon';
import express, { type NextFunction, type Request, type Response } from 'express';
import type { Server } from 'node:http';
import { config } from '../config.js';
import { adminPasswordWeakness } from '../util/password.js';
import { many, run } from '../db/index.js';
import { createBackup, listBackups, pruneBackups } from '../domain/backup.js';
import {
  affectedUserIds,
  cancelBooking,
  editBooking,
  findBookingById,
  findBookingByCode,
  placeAddress,
  placeLabel,
} from '../domain/bookings.js';
import { settleBooking } from '../domain/ledger.js';
import { approveClaim, findClaimByCode, rejectClaim } from '../domain/payments.js';
import { createPlace, deletePlace } from '../domain/places.js';
import { findGroupById, listGroups as listAllGroups, updateGroup, SPORTS, type Sport } from '../domain/groups.js';
import { getSettings, setSettings, invalidateSettings, type Lang, type PaymentConfirmationMode, type Settings } from '../domain/settings.js';
import { anonymiseUser, findUserById, listAdmins, setAdmin, setPaymentHandle } from '../domain/users.js';
import {
  addConsoleUser,
  deleteConsoleUser,
  listConsoleUsers,
  setConsolePasswordById,
  verifyConsoleUser,
} from '../domain/console-users.js';
import { t } from '../i18n/index.js';
import { buildIcs } from '../util/calendar.js';
import { bookingTitle } from '../bot/render.js';
import { formatDateTime } from '../util/datetime.js';
import { parseMoneyToCents } from '../util/money.js';
import { logger } from '../util/logger.js';
import { layout } from './layout.js';
import {
  backupsPage,
  bookingEditPage,
  bookingsPage,
  dashboardPage,
  loginPage,
  moneyPage,
  peoplePage,
  placesPage,
  reportsPage,
  groupsPage,
  settingsPage,
  accessPage,
} from './pages.js';

const SESSION_COOKIE = 'jpi_session';
const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;

export interface WebDeps {
  /** Live WhatsApp state, so the dashboard can show it. */
  isConnected(): boolean;
  listGroups(): Promise<{ id: string; subject: string }[]>;
  /** Announces admin changes that affect players, e.g. a moved booking. */
  notifyGroup(groupId: number, text: string, mentionUserIds?: number[]): Promise<void>;
}

/**
 * A signed, expiring token. Deliberately stateless: with one admin password and
 * a single-process deployment there is nothing worth keeping a session store for.
 */
function sign(payload: string, secret: string): string {
  return crypto.createHmac('sha256', secret).update(payload).digest('base64url');
}

function issueToken(secret: string, subject = 'admin'): string {
  const expires = Date.now() + SESSION_TTL_MS;
  // base64url so a username containing a dot cannot break the dotted token.
  const payload = `${Buffer.from(subject).toString('base64url')}.${expires}`;
  return `${payload}.${sign(payload, secret)}`;
}

/** Returns the logged-in subject (username, or 'owner') if the token is valid. */
function tokenSubject(token: string | undefined, secret: string): string | null {
  if (!token) return null;
  const parts = token.split('.');
  if (parts.length !== 3) return null;

  const [subjectB64, expiresRaw, signature] = parts as [string, string, string];
  const payload = `${subjectB64}.${expiresRaw}`;

  const expected = sign(payload, secret);
  const a = Buffer.from(signature);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;

  const expires = Number(expiresRaw);
  if (!Number.isFinite(expires) || expires <= Date.now()) return null;

  try {
    return Buffer.from(subjectB64, 'base64url').toString() || null;
  } catch {
    return null;
  }
}

function verifyToken(token: string | undefined, secret: string): boolean {
  return tokenSubject(token, secret) != null;
}

export function createWebApp(deps: WebDeps) {
  const app = express();

  // Generated per boot when unset: sessions simply do not survive a restart.
  const secret = config.web.sessionSecret || crypto.randomBytes(32).toString('hex');
  const password = config.web.adminPassword;

  const pwWeakness = adminPasswordWeakness(password);
  if (config.web.enabled && pwWeakness) {
    logger.warn(
      `SECURITY: the owner (ADMIN_PASSWORD) login ${pwWeakness}. It is a full-admin login and ` +
        'reachable from the internet once the console is tunnelled — set a long, unique password.',
    );
  }

  // Light brute-force guard — the console is reachable from the internet once a
  // tunnel is set up, so cap failed logins per client for a spell.
  const loginFails = new Map<string, { count: number; until: number }>();
  const LOGIN_MAX = 6;
  const LOGIN_LOCK_MS = 15 * 60 * 1000;
  const loginThrottled = (ip: string): boolean => {
    const e = loginFails.get(ip);
    return e != null && e.count >= LOGIN_MAX && Date.now() < e.until;
  };
  const noteLoginFail = (ip: string): void => {
    const e = loginFails.get(ip) ?? { count: 0, until: 0 };
    e.count += 1;
    e.until = Date.now() + LOGIN_LOCK_MS;
    loginFails.set(ip, e);
  };
  const clearLoginFails = (ip: string): void => void loginFails.delete(ip);
  const samePassword = (a: string, b: string): boolean => {
    const ha = crypto.createHash('sha256').update(a).digest();
    const hb = crypto.createHash('sha256').update(b).digest();
    return crypto.timingSafeEqual(ha, hb);
  };

  app.disable('x-powered-by');
  app.use(express.urlencoded({ extended: false, limit: '256kb' }));
  app.use(cookieParser());

  /**
   * Which group the console is acting on. A query parameter rather than session
   * state, so a link to a page is a link to that group's page.
   */
  const groupIdFrom = (req: Request): number => {
    // A GET carries the group in ?g=; a POSTed form carries it in the body so
    // the action lands in the group the page was showing, not the first one.
    const raw = Number.parseInt(String(req.query.g ?? req.body?.g ?? ''), 10);
    if (Number.isFinite(raw) && findGroupById(raw)) return raw;
    return listAllGroups()[0]?.id ?? 1;
  };

  /** Renders a page, injecting the group switcher so every page carries it. */
  const sendFor = (res: Response, req: Request, body: string, options: Parameters<typeof layout>[1]) =>
    res.type('html').send(
      layout(body, {
        ...options,
        currentGroupId: groupIdFrom(req),
        isOwner: tokenSubject(req.cookies?.[SESSION_COOKIE], secret) === 'owner',
        groups: listAllGroups(true).map((gr) => ({
          id: gr.id,
          label: gr.name ?? `Group ${gr.id}`,
        })),
      }),
    );

  // Pages without a group context (login) still use the bare renderer.
  const send = (res: Response, body: string, options: Parameters<typeof layout>[1]) =>
    res.type('html').send(layout(body, options));

  const flashFrom = (req: Request) => {
    const ok = typeof req.query.ok === 'string' ? req.query.ok : null;
    const err = typeof req.query.err === 'string' ? req.query.err : null;
    if (ok) return { kind: 'ok' as const, text: ok };
    if (err) return { kind: 'err' as const, text: err };
    return null;
  };

  /* ---- calendar files are public: the link goes to players ---- */
  app.get('/c/:code.ics', (req, res) => {
    const booking = findBookingByCode(String(req.params.code ?? ''));
    if (!booking) return res.status(404).type('text').send('Not found');

    const ics = buildIcs({
      uid: `justplayit-${booking.code}@justplayit`,
      title: bookingTitle(booking),
      startIsoUtc: booking.starts_at,
      durationMin: booking.duration_min,
      location: placeAddress(booking),
      description: `Booking ${booking.code}`,
      url: booking.external_url,
    });

    res.type('text/calendar; charset=utf-8')
      .set('Content-Disposition', `attachment; filename="${booking.code}.ics"`)
      .send(ics);
  });

  app.get('/healthz', (_req, res) => {
    res.json({ ok: true, whatsapp: deps.isConnected() });
  });

  /* ---- auth ---- */

  app.get('/login', (req, res) => {
    if (verifyToken(req.cookies?.[SESSION_COOKIE], secret)) return res.redirect('/');
    send(res, loginPage(typeof req.query.err === 'string' ? req.query.err : undefined), {
      title: 'Sign in',
      bare: true,
    });
  });

  app.post('/login', (req, res) => {
    const ip = req.ip ?? 'unknown';
    if (loginThrottled(ip)) {
      return res.redirect('/login?err=' + encodeURIComponent('Too many attempts — wait a few minutes.'));
    }

    const username = String(req.body?.username ?? '').trim();
    const supplied = String(req.body?.password ?? '');

    let authedAs: string | null = null;
    if (username && verifyConsoleUser(username, supplied)) {
      authedAs = username;
    } else if (password && supplied.length > 0 && samePassword(supplied, password)) {
      authedAs = username || 'owner'; // env ADMIN_PASSWORD stays valid as the owner login
    }

    if (!authedAs) {
      noteLoginFail(ip);
      logger.warn({ ip }, 'failed console login');
      return res.redirect('/login?err=' + encodeURIComponent('Wrong username or password.'));
    }
    clearLoginFails(ip);

    res.cookie(SESSION_COOKIE, issueToken(secret, authedAs), {
      httpOnly: true,
      sameSite: 'lax',
      maxAge: SESSION_TTL_MS,
      // Plain HTTP on the LAN by default; set only behind a TLS-terminating proxy.
      secure: config.isProduction && process.env.TRUST_PROXY === '1',
    });
    res.redirect('/');
  });

  app.post('/logout', (_req, res) => {
    res.clearCookie(SESSION_COOKIE);
    res.redirect('/login');
  });

  /* ---- everything below requires a session ---- */

  app.use((req: Request, res: Response, next: NextFunction) => {
    if (verifyToken(req.cookies?.[SESSION_COOKIE], secret)) return next();
    res.redirect('/login');
  });

  app.get('/', async (req, res) => {
    const owner = tokenSubject(req.cookies?.[SESSION_COOKIE], secret) === 'owner';
    sendFor(res, req, dashboardPage(deps.isConnected(), groupIdFrom(req), { isOwner: owner, passwordWeakness: owner ? pwWeakness : null }), {
      title: 'Dashboard',
      active: '/',
      flash: flashFrom(req),
    });
  });

  app.get('/bookings', (req, res) => {
    sendFor(res, req, bookingsPage(groupIdFrom(req)), { title: 'Bookings', active: '/bookings', flash: flashFrom(req) });
  });

  app.post('/bookings/:id/cancel', (req, res) => {
    const booking = findBookingById(Number(req.params.id));
    const admin = listAdmins()[0];
    if (!booking || !admin) return res.redirect('/bookings?err=Booking+not+found');

    const result = cancelBooking(booking.code, admin, true);
    res.redirect(
      result.ok
        ? `/bookings?ok=${encodeURIComponent(`Booking ${booking.code} cancelled.`)}`
        : `/bookings?err=${encodeURIComponent(result.reason)}`,
    );
  });

  app.get('/bookings/:id/edit', (req, res) => {
    const booking = findBookingById(Number(req.params.id));
    if (!booking) return res.redirect('/bookings?err=Booking+not+found');
    if (booking.status !== 'OPEN') {
      return res.redirect(
        '/bookings?err=' + encodeURIComponent('Only an open booking can be edited.'),
      );
    }

    sendFor(res, req, bookingEditPage(booking), {
      title: `Edit ${booking.code}`,
      active: '/bookings',
      flash: flashFrom(req),
    });
  });

  app.post('/bookings/:id/edit', async (req, res) => {
    const booking = findBookingById(Number(req.params.id));
    if (!booking) return res.redirect('/bookings?err=Booking+not+found');

    const settings = getSettings();
    const body = req.body ?? {};
    const fail = (msg: string) =>
      res.redirect(`/bookings/${booking.id}/edit?err=${encodeURIComponent(msg)}`);

    // The form supplies wall-clock date and time; the database stores UTC.
    const startsAt = DateTime.fromISO(`${String(body.date ?? '')}T${String(body.time ?? '')}`, {
      zone: settings.timezone,
    });
    if (!startsAt.isValid) return fail('That date and time could not be read.');

    const external = booking.kind === 'EXTERNAL';

    let totalCostCents: number | undefined;
    if (!external) {
      const parsed = parseMoneyToCents(String(body.cost ?? ''));
      if (parsed == null) return fail('That cost could not be read. Use a plain number like 40.');
      totalCostCents = parsed;
    }

    const num = (name: string, fallback: number) => {
      const value = Number.parseInt(String(body[name] ?? ''), 10);
      return Number.isFinite(value) ? value : fallback;
    };

    const placeIdRaw = String(body.placeId ?? '').trim();
    const placeId = placeIdRaw ? Number(placeIdRaw) : null;
    const customPlace = String(body.customPlace ?? '').trim() || null;

    const result = editBooking(booking.id, {
      startsAtIso: startsAt.toUTC().toISO()!,
      durationMin: num('durationMin', booking.duration_min),
      totalCostCents,
      minPlayers: external ? undefined : num('minPlayers', booking.min_players),
      maxPlayers: external ? undefined : num('maxPlayers', booking.max_players),
      cancelLimitHours: external ? undefined : num('cancelLimitHours', booking.cancel_limit_hours),
      placeId,
      customPlace,
      court: String(body.court ?? '').trim() || null,
      notes: String(body.notes ?? '').trim() || null,
    });

    if (!result.ok) {
      switch (result.reason) {
        case 'overlap':
          return fail(
            `That clashes with booking ${result.conflict.code} at ` +
              formatDateTime(result.conflict.starts_at, settings.timezone, settings.language),
          );
        case 'in_past':
          return fail('A booking cannot be moved into the past — cancel it instead.');
        case 'invalid_players':
          return fail('Maximum players cannot be below the minimum.');
        case 'no_place':
          return fail('Pick a place, or type a one-off location.');
        case 'not_editable':
          return fail('Only an open booking can be edited.');
        default:
          return fail('That booking no longer exists.');
      }
    }

    // A moved game is a change to a commitment other people already made, so
    // the group hears about it rather than discovering it on the day.
    if (result.scheduleChanged) {
      const dict = t(settings.language);
      await deps
        .notifyGroup(
          result.booking.group_id,
          dict.booking.rescheduled(
            result.booking.code,
            formatDateTime(result.previousStartsAt, settings.timezone, settings.language),
            formatDateTime(result.booking.starts_at, settings.timezone, settings.language),
          ),
          affectedUserIds(result.booking.id),
        )
        .catch((err) => logger.error({ err }, 'could not announce the new schedule'));
    }

    res.redirect(
      `/bookings?ok=${encodeURIComponent(
        result.scheduleChanged
          ? `${result.booking.code} updated — the group has been told about the new time.`
          : `${result.booking.code} updated.`,
      )}`,
    );
  });

  app.post('/bookings/:id/settle', (req, res) => {
    const result = settleBooking(Number(req.params.id));
    res.redirect(
      result.ok
        ? `/bookings?ok=${encodeURIComponent(`Settled ${result.booking.code}.`)}`
        : `/bookings?err=${encodeURIComponent(result.reason)}`,
    );
  });

  app.get('/places', (req, res) => {
    sendFor(res, req, placesPage(groupIdFrom(req)), { title: 'Places', active: '/places', flash: flashFrom(req) });
  });

  app.post('/places', (req, res) => {
    const groupId = groupIdFrom(req);
    const name = String(req.body?.name ?? '').trim();
    if (!name) return res.redirect(`/places?g=${groupId}&err=A+name+is+required`);
    try {
      createPlace({ groupId, name, address: String(req.body?.address ?? '') });
      res.redirect(`/places?g=${groupId}&ok=${encodeURIComponent(`${name} added.`)}`);
    } catch {
      res.redirect(`/places?g=${groupId}&err=` + encodeURIComponent('A place with that name already exists.'));
    }
  });

  app.post('/places/:id/delete', (req, res) => {
    const groupId = groupIdFrom(req);
    const outcome = deletePlace(Number(req.params.id));
    res.redirect(
      `/places?g=${groupId}&ok=${encodeURIComponent(
        outcome === 'deactivated'
          ? 'Place hidden — it is still used by existing bookings.'
          : 'Place removed.',
      )}`,
    );
  });

  app.get('/people', (req, res) => {
    sendFor(res, req, peoplePage(groupIdFrom(req)), { title: 'People', active: '/people', flash: flashFrom(req) });
  });

  app.post('/people/:id/admin', (req, res) => {
    const userId = Number(req.params.id);
    const makeAdmin = String(req.body?.value ?? '') === '1';

    // Refuse to remove the last admin, which would lock everyone out.
    if (!makeAdmin && listAdmins().length <= 1) {
      return res.redirect('/people?err=' + encodeURIComponent('There must be at least one admin.'));
    }

    setAdmin(userId, makeAdmin);
    res.redirect('/people?ok=' + encodeURIComponent('Updated.'));
  });

  app.post('/people/:id/handle', (req, res) => {
    const handle = String(req.body?.handle ?? '').trim();
    setPaymentHandle(Number(req.params.id), handle || null);
    res.redirect(`/people?g=${groupIdFrom(req)}&ok=` + encodeURIComponent('Payment details saved.'));
  });

  app.post('/people/:id/forget', (req, res) => {
    const userId = Number(req.params.id);
    if (findUserById(userId)?.is_admin && listAdmins().length <= 1) {
      return res.redirect(
        `/people?g=${groupIdFrom(req)}&err=` + encodeURIComponent('Cannot erase the only admin.'),
      );
    }
    anonymiseUser(userId);
    res.redirect(`/people?g=${groupIdFrom(req)}&ok=` + encodeURIComponent('Personal data erased.'));
  });

  app.get('/money', (req, res) => {
    sendFor(res, req, moneyPage(groupIdFrom(req)), { title: 'Money', active: '/money', flash: flashFrom(req) });
  });

  app.post('/claims/:id/:action', (req, res) => {
    const claim = many<{ code: string }>(
      'SELECT code FROM payment_claims WHERE id = ?',
      Number(req.params.id),
    )[0];
    const admin = listAdmins()[0];
    if (!claim || !admin) return res.redirect('/?err=Not+found');

    const found = findClaimByCode(claim.code);
    if (!found) return res.redirect('/?err=Not+found');

    const result =
      req.params.action === 'approve'
        ? approveClaim(found.code, admin, true)
        : rejectClaim(found.code, admin, true);

    res.redirect(result.ok ? '/?ok=' + encodeURIComponent('Payment updated.') : '/?err=Failed');
  });

  app.get('/backups', (req, res) => {
    sendFor(res, req, backupsPage(listBackups()), {
      title: 'Backups',
      active: '/settings',
      flash: flashFrom(req),
    });
  });

  app.post('/backups', (_req, res) => {
    const file = createBackup();
    if (!file) return res.redirect('/backups?err=' + encodeURIComponent('Snapshot failed.'));
    pruneBackups(Math.max(getSettings().backupKeepDays, 1));
    res.redirect('/backups?ok=' + encodeURIComponent(`Snapshot ${file.name} written.`));
  });

  app.get('/backups/:name', (req, res) => {
    // Resolve against the known list rather than joining user input onto a
    // path, so a crafted name cannot escape the backup directory.
    const file = listBackups().find((f) => f.name === String(req.params.name ?? ''));
    if (!file) return res.status(404).type('text').send('Not found');

    res.download(file.path, file.name, (err) => {
      if (err) logger.error({ err, name: file.name }, 'backup download failed');
    });
  });

  app.get('/groups', (req, res) => {
    sendFor(res, req, groupsPage(groupIdFrom(req)), {
      title: 'Groups',
      active: '/groups',
      flash: flashFrom(req),
    });
  });

  app.post('/groups/:id', (req, res) => {
    const group = findGroupById(Number(req.params.id));
    if (!group) return res.redirect('/groups?err=' + encodeURIComponent('No such group.'));

    const body = req.body ?? {};
    const sport = SPORTS.includes(String(body.sport) as Sport)
      ? (String(body.sport) as Sport)
      : group.sport;

    updateGroup(group.id, {
      name: String(body.name ?? '').trim() || null,
      sport,
      // An unchecked checkbox is simply absent from the body.
      active: body.active === '1',
    });
    // A sport change shifts the default roster, so drop the cached settings.
    invalidateSettings(group.id);
    res.redirect(`/groups?g=${group.id}&ok=${encodeURIComponent('Group updated.')}`);
  });

  app.get('/reports', (req, res) => {
    const reports = many<{
      id: number;
      user_id: number;
      kind: string;
      body: string;
      status: string;
      created_at: string;
    }>('SELECT * FROM reports ORDER BY created_at DESC LIMIT 200');

    sendFor(res, req, reportsPage(reports), {
      title: 'Reports',
      active: '/reports',
      flash: flashFrom(req),
    });
  });

  app.post('/reports/:id/close', (req, res) => {
    run(`UPDATE reports SET status = 'CLOSED' WHERE id = ?`, Number(req.params.id));
    res.redirect('/reports?ok=' + encodeURIComponent('Report closed.'));
  });

  app.get('/settings', (req, res) => {
    sendFor(res, req, settingsPage(groupIdFrom(req)), {
      title: 'Settings',
      active: '/settings',
      flash: flashFrom(req),
    });
  });

  app.post('/settings', (req, res) => {
    const body = req.body ?? {};

    const int = (name: string, fallback: number, min: number, max: number): number => {
      const value = Number.parseInt(String(body[name] ?? ''), 10);
      return Number.isFinite(value) && value >= min && value <= max ? value : fallback;
    };

    const current = getSettings(groupIdFrom(req));
    const languages: Lang[] = ['en', 'de', 'pt'];
    const modes: PaymentConfirmationMode[] = ['receiver', 'both', 'dual', 'anyone'];

    const language = languages.includes(String(body.language) as Lang)
      ? (String(body.language) as Lang)
      : current.language;

    const paymentConfirmationMode = modes.includes(
      String(body.paymentConfirmationMode) as PaymentConfirmationMode,
    )
      ? (String(body.paymentConfirmationMode) as PaymentConfirmationMode)
      : current.paymentConfirmationMode;

    const patch: Partial<Settings> = {
      commandPrefix: String(body.commandPrefix ?? '!').trim().slice(0, 3) || '!',
      language,
      timezone: String(body.timezone ?? current.timezone).trim() || current.timezone,
      currency: String(body.currency ?? current.currency).trim().toUpperCase().slice(0, 3) || current.currency,
      paymentConfirmationMode,
      defaultCancelLimitHours: int('defaultCancelLimitHours', current.defaultCancelLimitHours, 0, 336),
      defaultDurationMin: int('defaultDurationMin', current.defaultDurationMin, 15, 480),
      defaultMinPlayers: int('defaultMinPlayers', current.defaultMinPlayers, 1, 50),
      defaultMaxPlayers: int('defaultMaxPlayers', current.defaultMaxPlayers, 1, 50),
      reminderHoursBefore: int('reminderHoursBefore', current.reminderHoursBefore, 0, 336),
      paymentDeadlineDays: int('paymentDeadlineDays', current.paymentDeadlineDays, 1, 90),
      dataRetentionDays: int('dataRetentionDays', current.dataRetentionDays, 1, 3650),
      backupKeepDays: int('backupKeepDays', current.backupKeepDays, 0, 365),
      // Unchecked checkboxes are simply absent from the form body.
      allowPerBookingCancelLimit: body.allowPerBookingCancelLimit === '1',
      allowCustomPlaces: body.allowCustomPlaces === '1',
      requirePaymentProof: body.requirePaymentProof === '1',
    };

    if (patch.defaultMaxPlayers! < patch.defaultMinPlayers!) {
      return res.redirect(
        '/settings?err=' + encodeURIComponent('Maximum players cannot be below the minimum.'),
      );
    }

    setSettings(patch, groupIdFrom(req));
    logger.info('settings updated from web console');
    res.redirect(`/settings?g=${groupIdFrom(req)}&ok=` + encodeURIComponent('Settings saved.'));
  });

  // Managing logins is the owner's alone — a shared admin should not be able to
  // mint or revoke access. The owner is whoever logged in with ADMIN_PASSWORD.
  const requireOwner = (req: Request, res: Response): boolean => {
    if (tokenSubject(req.cookies?.[SESSION_COOKIE], secret) === 'owner') return true;
    sendFor(
      res,
      req,
      '<div class="card"><h1>Not allowed</h1><p class="sub">Only the owner (the server password) can manage console logins.</p></div>',
      { title: 'Access', active: '/access' },
    );
    return false;
  };

  app.get('/access', (req, res) => {
    if (!requireOwner(req, res)) return;
    sendFor(res, req, accessPage(listConsoleUsers()), {
      title: 'Access',
      active: '/access',
      flash: flashFrom(req),
    });
  });

  app.post('/access', (req, res) => {
    if (!requireOwner(req, res)) return;
    const ok = addConsoleUser(String(req.body?.username ?? ''), String(req.body?.password ?? ''));
    res.redirect(
      '/access?' +
        (ok
          ? 'ok=' + encodeURIComponent('Login created.')
          : 'err=' +
            encodeURIComponent('Could not create it — username must be 3–32 chars, password 6+, and not already taken.')),
    );
  });

  app.post('/access/:id/password', (req, res) => {
    if (!requireOwner(req, res)) return;
    const ok = setConsolePasswordById(Number(req.params.id), String(req.body?.password ?? ''));
    res.redirect(
      '/access?' +
        (ok
          ? 'ok=' + encodeURIComponent('Password updated.')
          : 'err=' + encodeURIComponent('Password must be at least 6 characters.')),
    );
  });

  app.post('/access/:id/delete', (req, res) => {
    if (!requireOwner(req, res)) return;
    deleteConsoleUser(Number(req.params.id));
    res.redirect('/access?ok=' + encodeURIComponent('Login removed.'));
  });

  app.use((_req, res) => {
    res.status(404).type('html').send(layout('<h1>Not found</h1>', { title: 'Not found' }));
  });

  return app;
}

export function startWebServer(deps: WebDeps): Server | null {
  if (!config.web.enabled) {
    logger.info('web console disabled (WEB_PORT=0)');
    return null;
  }

  if (!config.web.adminPassword) {
    logger.warn(
      'ADMIN_PASSWORD is not set — the web console will refuse every login until it is.',
    );
  }

  const app = createWebApp(deps);
  return app.listen(config.web.port, config.web.host, () => {
    logger.info({ port: config.web.port }, 'web console listening');
  });
}

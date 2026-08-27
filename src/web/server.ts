import crypto from 'node:crypto';
import cookieParser from 'cookie-parser';
import express, { type NextFunction, type Request, type Response } from 'express';
import type { Server } from 'node:http';
import { config } from '../config.js';
import { many, run } from '../db/index.js';
import {
  cancelBooking,
  findBookingById,
  findBookingByCode,
  placeAddress,
  placeLabel,
} from '../domain/bookings.js';
import { settleBooking } from '../domain/ledger.js';
import { approveClaim, findClaimByCode, rejectClaim } from '../domain/payments.js';
import { createPlace, deletePlace } from '../domain/places.js';
import { getSettings, setSettings, type Lang, type PaymentConfirmationMode, type Settings } from '../domain/settings.js';
import { anonymiseUser, findUserById, listAdmins, setAdmin, setPaymentHandle } from '../domain/users.js';
import { buildIcs } from '../util/calendar.js';
import { logger } from '../util/logger.js';
import { layout } from './layout.js';
import {
  bookingsPage,
  dashboardPage,
  loginPage,
  moneyPage,
  peoplePage,
  placesPage,
  reportsPage,
  settingsPage,
} from './pages.js';

const SESSION_COOKIE = 'jpi_session';
const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;

export interface WebDeps {
  /** Live WhatsApp state, so the dashboard can show it. */
  isConnected(): boolean;
  listGroups(): Promise<{ id: string; subject: string }[]>;
}

/**
 * A signed, expiring token. Deliberately stateless: with one admin password and
 * a single-process deployment there is nothing worth keeping a session store for.
 */
function sign(payload: string, secret: string): string {
  return crypto.createHmac('sha256', secret).update(payload).digest('base64url');
}

function issueToken(secret: string): string {
  const expires = Date.now() + SESSION_TTL_MS;
  const payload = `admin.${expires}`;
  return `${payload}.${sign(payload, secret)}`;
}

function verifyToken(token: string | undefined, secret: string): boolean {
  if (!token) return false;
  const parts = token.split('.');
  if (parts.length !== 3) return false;

  const [subject, expiresRaw, signature] = parts as [string, string, string];
  const payload = `${subject}.${expiresRaw}`;

  const expected = sign(payload, secret);
  // Timing-safe compare on equal-length buffers only.
  const a = Buffer.from(signature);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return false;

  const expires = Number(expiresRaw);
  return Number.isFinite(expires) && expires > Date.now();
}

export function createWebApp(deps: WebDeps) {
  const app = express();

  // Generated per boot when unset: sessions simply do not survive a restart.
  const secret = config.web.sessionSecret || crypto.randomBytes(32).toString('hex');
  const password = config.web.adminPassword;

  app.disable('x-powered-by');
  app.use(express.urlencoded({ extended: false, limit: '256kb' }));
  app.use(cookieParser());

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
      title: `Padel — ${placeLabel(booking)}`,
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
    if (!password) {
      return res.redirect('/login?err=' + encodeURIComponent('ADMIN_PASSWORD is not set on the server.'));
    }

    const supplied = String(req.body?.password ?? '');
    const a = crypto.createHash('sha256').update(supplied).digest();
    const b = crypto.createHash('sha256').update(password).digest();

    if (!crypto.timingSafeEqual(a, b)) {
      logger.warn('failed admin login attempt');
      return res.redirect('/login?err=' + encodeURIComponent('Wrong password.'));
    }

    res.cookie(SESSION_COOKIE, issueToken(secret), {
      httpOnly: true,
      sameSite: 'lax',
      maxAge: SESSION_TTL_MS,
      // The Pi deployment is usually plain HTTP on the LAN, so this cannot be
      // unconditional without locking the admin out of their own console.
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
    send(res, dashboardPage(deps.isConnected()), {
      title: 'Dashboard',
      active: '/',
      flash: flashFrom(req),
    });
  });

  app.get('/bookings', (req, res) => {
    send(res, bookingsPage(), { title: 'Bookings', active: '/bookings', flash: flashFrom(req) });
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

  app.post('/bookings/:id/settle', (req, res) => {
    const result = settleBooking(Number(req.params.id));
    res.redirect(
      result.ok
        ? `/bookings?ok=${encodeURIComponent(`Settled ${result.booking.code}.`)}`
        : `/bookings?err=${encodeURIComponent(result.reason)}`,
    );
  });

  app.get('/places', (req, res) => {
    send(res, placesPage(), { title: 'Places', active: '/places', flash: flashFrom(req) });
  });

  app.post('/places', (req, res) => {
    const name = String(req.body?.name ?? '').trim();
    if (!name) return res.redirect('/places?err=A+name+is+required');
    try {
      createPlace({ name, address: String(req.body?.address ?? '') });
      res.redirect(`/places?ok=${encodeURIComponent(`${name} added.`)}`);
    } catch {
      res.redirect('/places?err=' + encodeURIComponent('A place with that name already exists.'));
    }
  });

  app.post('/places/:id/delete', (req, res) => {
    const outcome = deletePlace(Number(req.params.id));
    res.redirect(
      `/places?ok=${encodeURIComponent(
        outcome === 'deactivated'
          ? 'Place hidden — it is still used by existing bookings.'
          : 'Place removed.',
      )}`,
    );
  });

  app.get('/people', (req, res) => {
    send(res, peoplePage(), { title: 'People', active: '/people', flash: flashFrom(req) });
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
    res.redirect('/people?ok=' + encodeURIComponent('Payment details saved.'));
  });

  app.post('/people/:id/forget', (req, res) => {
    const userId = Number(req.params.id);
    if (findUserById(userId)?.is_admin && listAdmins().length <= 1) {
      return res.redirect('/people?err=' + encodeURIComponent('Cannot erase the only admin.'));
    }
    anonymiseUser(userId);
    res.redirect('/people?ok=' + encodeURIComponent('Personal data erased.'));
  });

  app.get('/money', (req, res) => {
    send(res, moneyPage(), { title: 'Money', active: '/money', flash: flashFrom(req) });
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

  app.get('/reports', (req, res) => {
    const reports = many<{
      id: number;
      user_id: number;
      kind: string;
      body: string;
      status: string;
      created_at: string;
    }>('SELECT * FROM reports ORDER BY created_at DESC LIMIT 200');

    send(res, reportsPage(reports), {
      title: 'Reports',
      active: '/reports',
      flash: flashFrom(req),
    });
  });

  app.post('/reports/:id/close', (req, res) => {
    run(`UPDATE reports SET status = 'CLOSED' WHERE id = ?`, Number(req.params.id));
    res.redirect('/reports?ok=' + encodeURIComponent('Report closed.'));
  });

  app.get('/settings', async (req, res) => {
    let groups: { id: string; subject: string }[] = [];
    try {
      if (deps.isConnected()) groups = await deps.listGroups();
    } catch (err) {
      logger.error({ err }, 'could not list WhatsApp groups');
    }

    send(res, settingsPage(groups), {
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

    const current = getSettings();
    const languages: Lang[] = ['en', 'de', 'pt'];
    const modes: PaymentConfirmationMode[] = ['receiver', 'both', 'anyone'];

    const language = languages.includes(String(body.language) as Lang)
      ? (String(body.language) as Lang)
      : current.language;

    const paymentConfirmationMode = modes.includes(
      String(body.paymentConfirmationMode) as PaymentConfirmationMode,
    )
      ? (String(body.paymentConfirmationMode) as PaymentConfirmationMode)
      : current.paymentConfirmationMode;

    const patch: Partial<Settings> = {
      groupJid: String(body.groupJid ?? '').trim(),
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

    setSettings(patch);
    logger.info('settings updated from web console');
    res.redirect('/settings?ok=' + encodeURIComponent('Settings saved.'));
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

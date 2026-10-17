import 'dotenv/config';
import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';

/**
 * Home Assistant writes an add-on's configuration to /data/options.json rather
 * than passing environment variables. Reading it here means the same image runs
 * unchanged under `docker compose` (env vars) and as an HA add-on (options
 * file), with no branching anywhere else in the codebase.
 *
 * Values found here win, because in an add-on the HA UI is the only place the
 * user can set them.
 */
function applyHomeAssistantOptions(): void {
  const optionsPath = process.env.HA_OPTIONS_PATH ?? '/data/options.json';
  if (!fs.existsSync(optionsPath)) return;

  const MAPPING: Record<string, string> = {
    admin_password: 'ADMIN_PASSWORD',
    session_secret: 'SESSION_SECRET',
    pairing_number: 'WHATSAPP_PAIRING_NUMBER',
    playtomic_email: 'PLAYTOMIC_EMAIL',
    playtomic_password: 'PLAYTOMIC_PASSWORD',
    web_port: 'WEB_PORT',
    log_level: 'LOG_LEVEL',
  };

  try {
    const raw = JSON.parse(fs.readFileSync(optionsPath, 'utf8')) as Record<string, unknown>;
    for (const [key, envName] of Object.entries(MAPPING)) {
      const value = raw[key];
      // An empty string means "not set" in the HA options UI.
      if (value === undefined || value === null || value === '') continue;
      process.env[envName] = String(value);
    }
  } catch {
    // A malformed options file must not stop the bot from booting with defaults.
  }
}

applyHomeAssistantOptions();

const schema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  DATA_DIR: z.string().default('./data'),
  LOG_LEVEL: z.string().default('info'),

  /** Set to 0 to run the bot without the admin web UI. */
  WEB_PORT: z.coerce.number().int().default(8080),
  WEB_HOST: z.string().default('0.0.0.0'),
  /** Admin console password. Required whenever the web UI is enabled. */
  ADMIN_PASSWORD: z.string().default(''),
  /** Signing secret for the admin session cookie. Generated per-install if unset. */
  SESSION_SECRET: z.string().default(''),

  /** Set to 0 during development to skip connecting to WhatsApp. */
  WHATSAPP_ENABLED: z.coerce.number().default(1),

  /**
   * Human-like sending: paces replies, shows a brief "typing…" before each,
   * never bursts, and reads the commands it answers. Set to 0 to send
   * instantly (useful in development). On by default.
   */
  WA_HUMANIZE: z.coerce.number().default(1),

  /** ntfy.sh topic for operational alerts (e.g. a brute-forced login). */
  NTFY_TOPIC: z.string().default(''),

  /**
   * Link by pairing code instead of QR. Set to the bot's own number in
   * international format, digits only (e.g. 4915112345678).
   *
   * This is the route to use when the primary WhatsApp runs in an Android
   * emulator, which has no camera to scan a QR code with.
   */
  WHATSAPP_PAIRING_NUMBER: z.string().default(''),

  /**
   * A dedicated Playtomic account the bot reads shared matches with. Optional:
   * without it, Playtomic links are still accepted and shown, just not enriched
   * with live roster/slot data. One account serves every group.
   */
  PLAYTOMIC_EMAIL: z.string().default(''),
  PLAYTOMIC_PASSWORD: z.string().default(''),

  PADELCITY_EMAIL: z.string().default(''),
  PADELCITY_PASSWORD: z.string().default(''),
  PADELCITY_CLIENT_SECRET: z.string().default(''),
  PADELCITY_APP_VERSION: z.string().default(''),
  PADELCITY_APP_BUILD: z.string().default(''),
});

const env = schema.parse(process.env);

const dataDir = path.resolve(env.DATA_DIR);

export const config = {
  env: env.NODE_ENV,
  isProduction: env.NODE_ENV === 'production',
  logLevel: env.LOG_LEVEL,
  dataDir,
  dbPath: path.join(dataDir, 'justplayit.db'),
  /** Baileys multi-device auth state (the "logged in device" credentials). */
  authDir: path.join(dataDir, 'wa-auth'),
  /** Payment proof attachments. */
  mediaDir: path.join(dataDir, 'media'),
  web: {
    enabled: env.WEB_PORT > 0,
    port: env.WEB_PORT,
    host: env.WEB_HOST,
    adminPassword: env.ADMIN_PASSWORD,
    sessionSecret: env.SESSION_SECRET,
  },
  whatsappEnabled: env.WHATSAPP_ENABLED === 1,
  /** Pace + typing + read receipts, to look less like a bot. */
  humanizeSending: env.WA_HUMANIZE === 1,
  ntfyTopic: env.NTFY_TOPIC,
  /** Digits only; empty means link by QR code instead. */
  whatsappPairingNumber: env.WHATSAPP_PAIRING_NUMBER.replace(/\D/g, ''),
  playtomic:
    env.PLAYTOMIC_EMAIL.length > 0
      ? { email: env.PLAYTOMIC_EMAIL, password: env.PLAYTOMIC_PASSWORD }
      : null,
  padelcity:
    env.PADELCITY_EMAIL.length > 0 && env.PADELCITY_CLIENT_SECRET.length > 0
      ? {
          email: env.PADELCITY_EMAIL,
          password: env.PADELCITY_PASSWORD,
          clientSecret: env.PADELCITY_CLIENT_SECRET,
          appVersion: env.PADELCITY_APP_VERSION || undefined,
          appBuild: env.PADELCITY_APP_BUILD || undefined,
        }
      : null,
} as const;

export type Config = typeof config;

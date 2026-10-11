import { Boom } from '@hapi/boom';
import {
  DisconnectReason,
  fetchLatestBaileysVersion,
  isJidGroup,
  makeWASocket,
  useMultiFileAuthState,
  type WASocket,
  type proto,
} from 'baileys';
import fs from 'node:fs';
import qrcode from 'qrcode-terminal';
import { config } from '../config.js';
import { logger } from '../util/logger.js';

export interface IncomingMessage {
  /** WhatsApp's message id, used to drop redeliveries. */
  id: string;
  chatId: string;
  senderJid: string;
  senderName: string | null;
  text: string;
  isGroup: boolean;
  mentionedJids: string[];
  /** The group's display name, when the message came from a group. */
  groupSubject?: string | null;
  /** Present when the message carried an image or document. */
  hasMedia: boolean;
  raw: proto.IWebMessageInfo;
}

export type MessageHandler = (message: IncomingMessage) => Promise<void>;

export interface WhatsAppClient {
  sendText(chatId: string, text: string, mentionJids?: string[]): Promise<void>;
  /** Marks a message as read — used for the commands the bot answers. */
  markRead(message: IncomingMessage): Promise<void>;
  downloadMedia(message: IncomingMessage): Promise<Buffer | null>;
  /** Resolves a phone number to the JID WhatsApp actually uses for it. */
  isConnected(): boolean;
  listGroups(): Promise<{ id: string; subject: string }[]>;
  /** WhatsApp's own admin list for a group, as JIDs. */
  groupAdmins(groupJid: string): Promise<string[]>;
  logout(): Promise<void>;
}

/**
 * Baileys speaks WhatsApp's multi-device protocol directly over a WebSocket —
 * no Chromium, which is what makes this viable inside a container on a Pi.
 *
 * This is an unofficial client: the account is a normal WhatsApp account, so it
 * is subject to WhatsApp's terms. The bot only ever replies to explicit
 * commands, never sends unsolicited bulk messages.
 */
export async function startWhatsApp(onMessage: MessageHandler): Promise<WhatsAppClient> {
  fs.mkdirSync(config.authDir, { recursive: true });

  const { state, saveCreds } = await useMultiFileAuthState(config.authDir);
  const { version } = await fetchLatestBaileysVersion();

  let socket: WASocket | null = null;
  let connected = false;
  // Baileys tears the socket down on most errors; a fresh one is cheap.
  let reconnectAttempts = 0;

  // When a recipient (notably iOS) fails to decrypt a message we sent, it asks
  // for a retry. Baileys answers by calling getMessage() to fetch the original
  // and re-encrypting it — without this the recipient is stuck on "Waiting for
  // this message." We keep a bounded cache of what we have sent, keyed by id.
  const SENT_CACHE_MAX = 1000;
  const sentMessages = new Map<string, proto.IMessage>();
  const rememberSent = (id: string | null | undefined, msg: proto.IMessage | null | undefined): void => {
    if (!id || !msg) return;
    sentMessages.set(id, msg);
    if (sentMessages.size > SENT_CACHE_MAX) {
      const oldest = sentMessages.keys().next().value;
      if (oldest) sentMessages.delete(oldest);
    }
  };

  // Human-like sending (anti-ban hygiene for a reply-only bot): replies are
  // serialized, never burst, preceded by a brief "typing…", and paced with a
  // small random delay. Tunable off via WA_HUMANIZE=0.
  const SEND_MIN_GAP_MS = 900; // never two sends closer together than this
  const TYPING_PER_CHAR_MS = 35;
  const TYPING_MAX_MS = 4000;
  const JITTER_MIN_MS = 300;
  const JITTER_MAX_MS = 1200;
  const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, Math.max(0, ms)));
  // Gaussian-ish jitter (average of two uniforms) clusters near the middle,
  // which looks more human than a flat random.
  const jitter = (): number =>
    Math.round(JITTER_MIN_MS + ((Math.random() + Math.random()) / 2) * (JITTER_MAX_MS - JITTER_MIN_MS));

  let sendChain: Promise<void> = Promise.resolve();
  let lastSentAt = 0;
  // Serializes every outbound message and enforces the minimum gap, so a burst
  // (e.g. reminders fanning out to several groups) goes out paced, not at once.
  const enqueueSend = (task: () => Promise<void>): Promise<void> => {
    const run = sendChain.then(async () => {
      if (config.humanizeSending) {
        const wait = SEND_MIN_GAP_MS - (Date.now() - lastSentAt);
        if (wait > 0) await sleep(wait);
      }
      await task();
      lastSentAt = Date.now();
    });
    sendChain = run.catch(() => undefined); // keep the chain alive past a failure
    return run;
  };

  // Caps how many times a single message is retried, so a permanently
  // undecryptable message cannot loop forever.
  const retryCounters = new Map<string, unknown>();
  const msgRetryCounterCache = {
    get: <T>(key: string): T | undefined => retryCounters.get(key) as T | undefined,
    set: <T>(key: string, value: T): void => void retryCounters.set(key, value),
    del: (key: string): void => void retryCounters.delete(key),
    flushAll: (): void => retryCounters.clear(),
  };

  const usePairingCode = config.whatsappPairingNumber.length > 0;
  if (usePairingCode) {
    logger.info('linking by pairing code (no QR scan needed)');
  }

  const connect = (): void => {
    socket = makeWASocket({
      version,
      auth: {
        creds: state.creds,
        // Deliberately NOT wrapped in makeCacheableSignalKeyStore: a stale
        // cached Signal session made the bot encrypt replies with an outdated
        // ratchet, so recipients (notably iOS) saw "Waiting for this message"
        // until a restart cleared the cache. Reading straight from disk is a
        // touch slower but keeps our view of each session current.
        keys: state.keys,
      },
      // The bot answers commands; it does not need to look "online".
      markOnlineOnConnect: false,
      syncFullHistory: false,
      logger: logger as never,
      generateHighQualityLinkPreview: false,
      msgRetryCounterCache,
      // Lets Baileys resend a message a recipient could not decrypt.
      getMessage: async (key) => (key.id ? sentMessages.get(key.id) : undefined),
    });

    socket.ev.on('creds.update', saveCreds);

    // Pairing-code linking: WhatsApp shows an 8-character code that the user
    // types on the primary device. This is the only workable route when the
    // primary WhatsApp runs in an Android emulator, which has no camera to
    // point at a QR code.
    if (usePairingCode && !socket.authState.creds.registered) {
      // The socket has to finish its opening handshake before the request is
      // accepted, and Baileys exposes no event for that point.
      setTimeout(async () => {
        try {
          const code = await socket!.requestPairingCode(config.whatsappPairingNumber);
          const pretty = code.match(/.{1,4}/g)?.join('-') ?? code;
          logger.info(
            `Pairing code: ${pretty} — on the bot's WhatsApp, open ` +
              'Linked devices → Link a device → Link with phone number instead, and enter it.',
          );
        } catch (err) {
          logger.error({ err }, 'could not request a pairing code');
        }
      }, 4000);
    }

    socket.ev.on('connection.update', (update) => {
      const { connection, lastDisconnect, qr } = update;

      // In pairing mode the QR is noise — the code above is what to use.
      if (qr && !usePairingCode) {
        logger.info('Scan this QR code in WhatsApp → Linked devices → Link a device');
        qrcode.generate(qr, { small: true });
      }

      if (connection === 'open') {
        connected = true;
        reconnectAttempts = 0;
        logger.info('connected to WhatsApp');
      }

      if (connection === 'close') {
        connected = false;
        const statusCode = (lastDisconnect?.error as Boom | undefined)?.output?.statusCode;
        const loggedOut = statusCode === DisconnectReason.loggedOut;

        if (loggedOut) {
          // The credentials are dead; a human has to re-link the device.
          logger.error(
            'WhatsApp session logged out. Delete the auth folder and scan the QR code again.',
          );
          return;
        }

        // Exponential backoff, capped, so a long outage does not hammer the API.
        const delay = Math.min(30_000, 2_000 * 2 ** reconnectAttempts);
        reconnectAttempts++;
        logger.warn({ statusCode, delay }, 'connection closed, reconnecting');
        setTimeout(connect, delay);
      }
    });

    socket.ev.on('messages.upsert', async ({ messages, type }) => {
      // 'notify' is a live message. 'append' covers two different things:
      // messages that arrived while the socket was down and are handed over on
      // reconnect, and bulk history sync. Ignoring it wholesale meant every
      // command sent during a connection blip was lost for good — but accepting
      // it wholesale would replay weeks of old chat on first link. The age
      // check separates the two.
      if (type !== 'notify' && type !== 'append') return;

      for (const message of messages) {
        try {
          if (!isRecent(message)) continue;
          const parsed = toIncoming(message);
          if (parsed) await onMessage(parsed);
        } catch (err) {
          logger.error({ err }, 'failed to handle incoming message');
        }
      }
    });
  };

  connect();

  return {
    isConnected: () => connected,

    async sendText(chatId, text, mentionJids) {
      if (!socket) throw new Error('WhatsApp socket not ready');
      return enqueueSend(async () => {
        const s = socket;
        if (!s) return;
        if (config.humanizeSending) {
          // Show "typing…" for a spell proportional to the message, then pause,
          // then send — the shape a person's reply has.
          try {
            await s.sendPresenceUpdate('composing', chatId);
          } catch {
            // presence is best-effort; never let it block the actual reply
          }
          await sleep(Math.min(TYPING_MAX_MS, text.length * TYPING_PER_CHAR_MS) + jitter());
          try {
            await s.sendPresenceUpdate('paused', chatId);
          } catch {
            // ignore
          }
        }
        const sent = await s.sendMessage(chatId, {
          text,
          ...(mentionJids?.length ? { mentions: mentionJids } : {}),
        });
        rememberSent(sent?.key?.id, sent?.message);
      });
    },

    async markRead(message) {
      if (!socket || !config.humanizeSending) return;
      try {
        await socket.readMessages([message.raw.key]);
      } catch {
        // read receipts are best-effort
      }
    },

    async downloadMedia(message) {
      if (!socket || !message.hasMedia) return null;
      const { downloadMediaMessage } = await import('baileys');
      try {
        const buffer = await downloadMediaMessage(
          message.raw,
          'buffer',
          {},
          { logger: logger as never, reuploadRequest: socket.updateMediaMessage },
        );
        return buffer as Buffer;
      } catch (err) {
        logger.error({ err }, 'media download failed');
        return null;
      }
    },

    async groupAdmins(groupJid) {
      if (!socket) return [];
      try {
        const meta = await socket.groupMetadata(groupJid);
        return (meta.participants ?? [])
          .filter((p) => p.admin === 'admin' || p.admin === 'superadmin')
          .map((p) => p.id);
      } catch (err) {
        logger.error({ err }, 'could not read group admins');
        return [];
      }
    },

    async listGroups() {
      if (!socket) return [];
      const groups = await socket.groupFetchAllParticipating();
      return Object.values(groups).map((g) => ({ id: g.id, subject: g.subject ?? g.id }));
    },

    async logout() {
      await socket?.logout();
    },
  };
}

/**
 * How far back a redelivered message may be and still be acted on. Long enough
 * to cover a reconnect after a network drop, short enough that history sync
 * never makes the bot answer a command from last week.
 */
export const CATCH_UP_WINDOW_MINUTES = 30;

/**
 * WhatsApp timestamps are seconds, and Baileys hands them over as a number or
 * a Long depending on where they came from. A message with no usable timestamp
 * is treated as live rather than discarded — better to answer twice than to
 * ignore someone.
 */
export function isWithinCatchUpWindow(
  timestamp: unknown,
  nowMs: number = Date.now(),
  windowMinutes: number = CATCH_UP_WINDOW_MINUTES,
): boolean {
  const raw =
    typeof timestamp === 'number'
      ? timestamp
      : typeof timestamp === 'object' && timestamp !== null && 'toNumber' in timestamp
        ? (timestamp as { toNumber(): number }).toNumber()
        : Number(timestamp);

  if (!Number.isFinite(raw) || raw <= 0) return true;

  const ageMinutes = (nowMs / 1000 - raw) / 60;
  // A clock slightly ahead of ours must not look like a message from the future.
  return ageMinutes <= windowMinutes;
}

function isRecent(message: proto.IWebMessageInfo): boolean {
  return isWithinCatchUpWindow(message.messageTimestamp);
}

/** Pulls the plain text out of the several shapes WhatsApp uses for it. */
function extractText(message: proto.IWebMessageInfo): string {
  const content = message.message;
  if (!content) return '';

  return (
    content.conversation ??
    content.extendedTextMessage?.text ??
    content.imageMessage?.caption ??
    content.videoMessage?.caption ??
    content.documentMessage?.caption ??
    content.buttonsResponseMessage?.selectedDisplayText ??
    content.listResponseMessage?.title ??
    ''
  );
}

function extractMentions(message: proto.IWebMessageInfo): string[] {
  const content = message.message;
  return (
    content?.extendedTextMessage?.contextInfo?.mentionedJid ??
    content?.imageMessage?.contextInfo?.mentionedJid ??
    []
  );
}

function toIncoming(message: proto.IWebMessageInfo): IncomingMessage | null {
  // Ignore our own messages, or we would answer ourselves in a loop.
  if (message.key.fromMe) return null;

  const chatId = message.key.remoteJid;
  if (!chatId || chatId === 'status@broadcast') return null;

  const text = extractText(message);
  if (!text.trim()) return null;

  const isGroup = isJidGroup(chatId) ?? false;
  // In a group the author is `participant`; in a DM it is the chat itself.
  const senderJid = (isGroup ? message.key.participant : chatId) ?? chatId;

  const content = message.message;
  const hasMedia = Boolean(content?.imageMessage || content?.documentMessage);

  return {
    id: message.key.id ?? '',
    chatId,
    senderJid,
    senderName: message.pushName ?? null,
    text,
    isGroup,
    mentionedJids: extractMentions(message),
    hasMedia,
    raw: message,
  };
}

import fs from 'node:fs';
import path from 'node:path';
import { config } from '../config.js';
import { one, run } from '../db/index.js';
import { handleCommand, type OutgoingMessage } from '../bot/commands.js';
import { parseMessage } from '../bot/parser.js';
import { getSettings, setSetting } from '../domain/settings.js';
import { displayName, findUserById, isAdmin, languageFor, upsertUser } from '../domain/users.js';
import { t } from '../i18n/index.js';
import { nowIso } from '../util/datetime.js';
import { logger } from '../util/logger.js';
import type { IncomingMessage, WhatsAppClient } from './client.js';

/**
 * WhatsApp redelivers messages after a reconnect. Without this guard a
 * dropped connection could book the same court twice.
 */
function alreadyProcessed(messageId: string): boolean {
  if (!messageId) return false;
  const seen = one('SELECT 1 AS x FROM processed_messages WHERE wa_message_id = ?', messageId);
  if (seen) return true;
  run(
    'INSERT OR IGNORE INTO processed_messages (wa_message_id, processed_at) VALUES (?, ?)',
    messageId,
    nowIso(),
  );
  return false;
}

export function createDispatcher(client: WhatsAppClient) {
  return async function dispatch(message: IncomingMessage): Promise<void> {
    if (alreadyProcessed(message.id)) return;

    const settings = getSettings();
    const user = upsertUser(message.senderJid, message.senderName);
    const admin = isAdmin(user);
    const dict = t(languageFor(user));

    // Bootstrap: the first admin to run a command in a group adopts that group,
    // so a fresh install works without opening the web console first.
    let groupJid = settings.groupJid;
    if (!groupJid && message.isGroup && admin) {
      setSetting('groupJid', message.chatId);
      groupJid = message.chatId;
      logger.info({ chatId: message.chatId }, 'adopted WhatsApp group');
    }

    // Stay silent in any group that is not the configured one.
    if (message.isGroup && groupJid && message.chatId !== groupJid) return;

    const parsed = parseMessage(message.text, {
      prefix: settings.commandPrefix,
      prefixOptional: !message.isGroup,
    });

    if (parsed.kind === 'not_a_command') return;

    if (parsed.kind === 'unknown_command') {
      await send(client, {
        target: 'origin',
        text: dict.common.unknownCommand(parsed.raw, settings.commandPrefix),
      }, message, groupJid);
      return;
    }

    // Only pull media down when a command can actually use it, so ordinary
    // group photos are never written to disk.
    let attachmentPath: string | null = null;
    if (message.hasMedia && parsed.command.name === 'confirm') {
      attachmentPath = await saveAttachment(client, message);
    }

    const mentionedUserIds = message.mentionedJids
      .map((jid) => upsertUser(jid).id)
      .filter((id) => id !== user.id);

    let outgoing: OutgoingMessage[];
    try {
      outgoing = handleCommand(parsed.command, {
        user,
        isAdmin: admin,
        chatId: message.chatId,
        isGroup: message.isGroup,
        dict,
        settings: getSettings(),
        mentionedUserIds,
        attachmentPath,
      });
    } catch (err) {
      logger.error({ err, command: parsed.command.name }, 'command handler threw');
      outgoing = [{ target: 'origin', text: dict.common.genericError }];
    }

    for (const out of outgoing) {
      await send(client, out, message, groupJid);
    }
  };
}

async function send(
  client: WhatsAppClient,
  out: OutgoingMessage,
  origin: IncomingMessage,
  groupJid: string,
): Promise<void> {
  const chatId = resolveChatId(out, origin, groupJid);
  if (!chatId) return;

  const mentions = (out.mentionUserIds ?? [])
    .map((id) => findUserById(id)?.wa_id)
    .filter((jid): jid is string => Boolean(jid) && !jid!.startsWith('deleted:'));

  // Mentions only render as pings inside a group.
  const text = appendMentionHandles(out.text, mentions, chatId.endsWith('@g.us'));

  try {
    await client.sendText(chatId, text, mentions);
  } catch (err) {
    logger.error({ err, target: out.target }, 'failed to send message');

    // A DM can fail when the user has never messaged the bot directly. Say so
    // in the originating chat rather than silently dropping the reply.
    if (out.target === 'dm' && origin.chatId !== chatId) {
      const dict = t(getSettings().language);
      await client
        .sendText(origin.chatId, dict.common.cannotDmYou)
        .catch((e) => logger.error({ err: e }, 'fallback notice failed too'));
    }
  }
}

function resolveChatId(
  out: OutgoingMessage,
  origin: IncomingMessage,
  groupJid: string,
): string | null {
  switch (out.target) {
    case 'origin':
      return origin.chatId;
    case 'group':
      // Fall back to the originating chat if no group is configured yet.
      return groupJid || origin.chatId;
    case 'dm': {
      const user = out.userId != null ? findUserById(out.userId) : undefined;
      if (!user || user.wa_id.startsWith('deleted:')) return null;
      return user.wa_id;
    }
    default:
      return origin.chatId;
  }
}

/**
 * WhatsApp only renders a mention as a ping when the handle appears in the
 * body, so append any that the message text does not already name.
 */
function appendMentionHandles(text: string, mentions: string[], isGroupChat: boolean): string {
  if (!isGroupChat || mentions.length === 0) return text;

  const missing = mentions
    .map((jid) => `@${jid.split('@')[0]}`)
    .filter((handle) => !text.includes(handle));

  return missing.length > 0 ? `${text}\n${missing.join(' ')}` : text;
}

async function saveAttachment(
  client: WhatsAppClient,
  message: IncomingMessage,
): Promise<string | null> {
  const buffer = await client.downloadMedia(message);
  if (!buffer) return null;

  fs.mkdirSync(config.mediaDir, { recursive: true });
  const filename = `proof-${Date.now()}-${message.id.slice(0, 8)}.bin`;
  const filePath = path.join(config.mediaDir, filename);
  fs.writeFileSync(filePath, buffer);

  logger.info({ filename }, 'stored payment proof');
  return filePath;
}

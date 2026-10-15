import fs from 'node:fs';
import path from 'node:path';
import { config } from '../config.js';
import { one, run } from '../db/index.js';
import { autoAddFromShare, handleCommand, type OutgoingMessage } from '../bot/commands.js';
import { parseMessage, field, type ParsedCommand } from '../bot/parser.js';
import { parseSharedMatch } from '../bot/share.js';
import { providerFor } from '../providers/index.js';
import { DateTime } from 'luxon';
import { getSettings } from '../domain/settings.js';
import {
  ensureGroup,
  ensureMember,
  getDmGroup,
  groupsForUser,
  isGroupAdmin,
  syncGroupAdmins,
} from '../domain/groups.js';
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

    const user = upsertUser(message.senderJid, message.senderName);
    const dict = t(languageFor(user));

    /* ---------------------------------------------------------------- */
    /* Which group is this?                                              */
    /*                                                                   */
    /* In a group chat the chat *is* the group, registered on first sight */
    /* so adding the bot to a new group needs no console setup. In a DM   */
    /* there is no chat to go on, so the sender's own membership decides: */
    /* one group is unambiguous, and several need them to say which.      */
    /* ---------------------------------------------------------------- */
    let group;
    if (message.isGroup) {
      group = ensureGroup(message.chatId, message.groupSubject ?? null);
      ensureMember(group.id, user.id);
      // Keep the bot's idea of who administers the chat in step with WhatsApp's.
      await syncAdminsIfStale(client, group.id, message.chatId);
    } else {
      const mine = groupsForUser(user.id);
      if (mine.length === 0) return; // not in any group the bot serves
      group = mine[0]!;
      if (mine.length > 1) {
        // Precedence: a group named in this message wins; otherwise the one the
        // admin picked with `.use`; otherwise we have to ask — unless the
        // message is itself a `.use`, which must always get through.
        const explicit = pickGroupFromMessage(message.text, mine);
        const stored = explicit ? null : getDmGroup(user.id);
        group = explicit ?? stored ?? mine[0]!;

        const peek = parseMessage(message.text, {
          prefix: getSettings(group.id).commandPrefix,
          prefixOptional: true,
        });
        const isUse = peek.kind === 'command' && peek.command.name === 'use';

        if (!explicit && !stored && !isUse) {
          await client
            .sendText(
              message.chatId,
              dict.common.whichGroup(mine.map((g) => g.name ?? g.wa_jid).join('\n  • ')),
            )
            .catch(() => undefined);
          return;
        }
      }
    }

    const settings = getSettings(group.id);
    const groupJid = group.wa_jid;
    // A WhatsApp group admin administers the bot; the console owner always does.
    const admin = isGroupAdmin(group.id, user.id) || isAdmin(user);

    const parsed = parseMessage(message.text, {
      prefix: settings.commandPrefix,
      prefixOptional: !message.isGroup,
    });

    if (parsed.kind === 'not_a_command') {
      // Not a command — but it may be a match shared straight from the
      // Playtomic/Padelcity app. If so, add it to the list, owned by the sharer.
      if (message.isGroup) {
        const share = parseSharedMatch(message.text, settings.timezone, DateTime.now());
        if (share) {
          void client.markRead(message);
          try {
            const out = await autoAddFromShare(share, {
              groupId: group.id,
              user,
              dict,
              settings,
            });
            for (const o of out) await send(client, o, message, groupJid);
          } catch (err) {
            logger.error({ err }, 'auto-add from shared match failed');
          }
        }
      }
      return;
    }

    // Read the command we are about to answer — a person reads before replying.
    void client.markRead(message);

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

    // For a Playtomic-style link, the match itself carries the date, time and
    // court — so fetch it now and fill those in, rather than making the user
    // retype what the platform already knows. If the fetch fails (no creds, a
    // dead link), the fields stay empty and the handler asks for them as before.
    if (parsed.command.name === 'external') {
      await prefillExternalFromLink(parsed.command, settings.timezone);
    }

    let outgoing: OutgoingMessage[];
    try {
      outgoing = handleCommand(parsed.command, {
        groupId: group.id,
        user,
        isAdmin: admin,
        chatId: message.chatId,
        isGroup: message.isGroup,
        dict,
        settings: getSettings(group.id),
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

/**
 * Mirrors WhatsApp's own admin list onto the group, at most once every few
 * minutes. WhatsApp is the source of truth — whoever administers the chat
 * administers the bot — so there is no second list to maintain by hand.
 */
const ADMIN_SYNC_INTERVAL_MS = 5 * 60 * 1000;
const lastAdminSync = new Map<number, number>();

async function syncAdminsIfStale(
  client: WhatsAppClient,
  groupId: number,
  groupJid: string,
): Promise<void> {
  const last = lastAdminSync.get(groupId) ?? 0;
  if (Date.now() - last < ADMIN_SYNC_INTERVAL_MS) return;
  lastAdminSync.set(groupId, Date.now());

  try {
    const jids = await client.groupAdmins(groupJid);
    if (jids.length === 0) return; // a failed lookup must not strip every admin
    const ids = jids.map((jid) => upsertUser(jid).id);
    const changed = syncGroupAdmins(groupId, ids);
    if (changed.length > 0) logger.info({ groupId, changed: changed.length }, 'synced group admins');
  } catch (err) {
    logger.error({ err, groupId }, 'admin sync failed');
  }
}

/**
 * Picks a group from a DM when the sender belongs to several. Matches a
 * trailing or leading `#name` / name fragment against the group names, so
 * `.list #tennis` works without the user learning an id.
 */
function pickGroupFromMessage<T extends { id: number; name: string | null; wa_jid: string }>(
  text: string,
  candidates: T[],
): T | null {
  const lower = text.toLowerCase();
  const matches = candidates.filter((g) => {
    const name = (g.name ?? '').toLowerCase().trim();
    return name.length > 0 && (lower.includes(`#${name}`) || lower.includes(name));
  });
  return matches.length === 1 ? matches[0]! : null;
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

/**
 * Fills a `.playtomic`/external command's date, time and court from the live
 * match the link points to, when a provider recognises it and can read it.
 * Mutates the parsed command's fields in place; leaves them untouched on any
 * failure so the normal "I still need date, time" path kicks in.
 */
export async function prefillExternalFromLink(cmd: ParsedCommand, timezone: string): Promise<void> {
  const url = field(cmd.fields, 'url') ?? cmd.args.find((a) => /^https?:\/\//i.test(a));
  if (!url) return;

  const provider = providerFor(url);
  if (!provider) return;

  try {
    const result = await provider.fetch(url);
    if (!result.ok || !result.match.startsAtIso) return;

    // Keep the fetched match so the handler can build one complete card at
    // creation (right provider, roster, slots) instead of a bare card now and
    // a second enriched one after the first background sync.
    cmd.prefetchedMatch = result.match;

    const start = DateTime.fromISO(result.match.startsAtIso, { zone: 'utc' }).setZone(timezone);
    // Only fill what the user did not type — an explicit value always wins.
    if (!field(cmd.fields, 'date')) cmd.fields.set('date', start.toFormat('yyyy-LL-dd'));
    if (!field(cmd.fields, 'time')) cmd.fields.set('time', start.toFormat('HH:mm'));
    if (!field(cmd.fields, 'court') && result.match.court) {
      cmd.fields.set('court', result.match.court);
    }
    // The venue goes in its own field (not `place`), so the handler uses it
    // directly as the booking's location — it is authoritative platform data,
    // not user free-text to validate against the club allowlist.
    if (!field(cmd.fields, 'place') && result.match.venueName) {
      cmd.fields.set('venue', result.match.venueName);
    }
  } catch {
    // Network or parse failure: fall back to asking the user.
  }
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

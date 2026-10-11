import fs from 'node:fs';
import type { Server } from 'node:http';
import { config } from './config.js';
import { closeDb, initDb } from './db/index.js';
import { findGroupById } from './domain/groups.js';
import { findUserById } from './domain/users.js';
import { startScheduler, type Notifier, type SchedulerHandle } from './scheduler/jobs.js';
import { logger } from './util/logger.js';
import { startWebServer } from './web/server.js';
import { startWhatsApp, type WhatsAppClient } from './whatsapp/client.js';
import { createDispatcher } from './whatsapp/dispatcher.js';

async function main(): Promise<void> {
  fs.mkdirSync(config.dataDir, { recursive: true });
  initDb();
  logger.info({ dataDir: config.dataDir }, 'Just Play It starting');

  let client: WhatsAppClient | null = null;

  if (config.whatsappEnabled) {
    // The dispatcher needs the client to download media, and the client needs
    // the dispatcher to handle messages, so the reference is filled in after.
    let dispatch: ((m: Parameters<ReturnType<typeof createDispatcher>>[0]) => Promise<void>) | null =
      null;

    client = await startWhatsApp(async (message) => {
      if (dispatch) await dispatch(message);
    });
    dispatch = createDispatcher(client);
  } else {
    logger.warn('WHATSAPP_ENABLED=0 — running without a WhatsApp connection');
  }

  /**
   * Routes scheduled announcements to a specific group's WhatsApp chat. With
   * several groups on one bot, every group-bound message has to name which
   * group it belongs to — the group's own JID is looked up here.
   */
  const notifier: Notifier = {
    async sendToGroup(groupId, text, mentionUserIds) {
      const group = findGroupById(groupId);
      if (!client || !group || !group.wa_jid || group.wa_jid === 'unconfigured') return;

      const mentions = (mentionUserIds ?? [])
        .map((id) => findUserById(id)?.wa_id)
        .filter((jid): jid is string => typeof jid === 'string' && !jid.startsWith('deleted:'));

      await client.sendText(group.wa_jid, text, mentions);
    },

    async sendToUser(userId, text) {
      const user = findUserById(userId);
      if (!client || !user || user.wa_id.startsWith('deleted:')) return;
      await client.sendText(user.wa_id, text);
    },
  };

  const scheduler: SchedulerHandle = startScheduler(notifier);

  const server: Server | null = startWebServer({
    isConnected: () => client?.isConnected() ?? false,
    listGroups: async () => (client ? client.listGroups() : []),
    notifyGroup: (groupId, text, mentionUserIds) =>
      notifier.sendToGroup(groupId, text, mentionUserIds),
  });

  let shuttingDown = false;
  const shutdown = (signal: string): void => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info({ signal }, 'shutting down');

    scheduler.stop();
    server?.close();
    closeDb();

    // Give in-flight sends a moment, then exit regardless.
    setTimeout(() => process.exit(0), 1500).unref();
  };

  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));

  process.on('unhandledRejection', (err) => logger.error({ err }, 'unhandled rejection'));
  process.on('uncaughtException', (err) => {
    logger.fatal({ err }, 'uncaught exception');
    shutdown('uncaughtException');
  });
}

main().catch((err) => {
  logger.fatal({ err }, 'failed to start');
  process.exit(1);
});

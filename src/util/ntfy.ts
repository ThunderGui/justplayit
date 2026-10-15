import { logger } from './logger.js';

/**
 * Fire-and-forget push to ntfy.sh. No-ops when no topic is configured. Used for
 * operational alerts (a login being brute-forced, say). Never throws.
 */
export async function sendNtfy(
  topic: string,
  title: string,
  message: string,
  priority: 'min' | 'low' | 'default' | 'high' | 'urgent' = 'default',
  tags?: string,
): Promise<void> {
  if (!topic) return;
  // HTTP headers are Latin1 only, so an emoji in the title throws. Strip it from
  // the title (the message body is UTF-8 and keeps any emoji); ntfy renders the
  // optional `Tags` (e.g. "warning") as an icon instead.
  const safeTitle = title.replace(/[^\u0000-\u00ff]/g, '').trim() || 'JustPlayIt';
  try {
    await fetch(`https://ntfy.sh/${encodeURIComponent(topic)}`, {
      method: 'POST',
      headers: { Title: safeTitle, Priority: priority, ...(tags ? { Tags: tags } : {}) },
      body: message,
      signal: AbortSignal.timeout(8000),
    });
  } catch (err) {
    logger.warn({ err }, 'ntfy notify failed');
  }
}

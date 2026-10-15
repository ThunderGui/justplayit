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
): Promise<void> {
  if (!topic) return;
  try {
    await fetch(`https://ntfy.sh/${encodeURIComponent(topic)}`, {
      method: 'POST',
      headers: { Title: title, Priority: priority },
      body: message,
      signal: AbortSignal.timeout(8000),
    });
  } catch (err) {
    logger.warn({ err }, 'ntfy notify failed');
  }
}

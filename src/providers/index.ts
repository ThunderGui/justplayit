import { config } from '../config.js';
import { PlaytomicProvider } from './playtomic.js';
import type { Provider } from './types.js';

export type { ExternalMatch, FetchResult, Provider } from './types.js';

/**
 * The providers the bot knows about, in priority order. A link is handed to the
 * first one that recognises it. Built once at startup from config; a provider
 * with no credentials still recognises its links and is simply not able to
 * enrich them (fetch returns `unavailable`).
 */
let registry: Provider[] | null = null;

export function providers(): Provider[] {
  if (!registry) {
    registry = [new PlaytomicProvider(config.playtomic)];
  }
  return registry;
}

/** The provider that recognises this URL, or null. */
export function providerFor(url: string): Provider | null {
  return providers().find((p) => p.matches(url)) ?? null;
}

/** Test seam: replace the registry. */
export function setProviders(list: Provider[]): void {
  registry = list;
}

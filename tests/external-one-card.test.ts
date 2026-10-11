import { DateTime } from 'luxon';
import { beforeEach, describe, expect, it } from 'vitest';
import { handleCommand, type OutgoingMessage } from '../src/bot/commands.js';
import { parseMessage } from '../src/bot/parser.js';
import { findBookingByCode } from '../src/domain/bookings.js';
import { getSettings } from '../src/domain/settings.js';
import { t } from '../src/i18n/index.js';
import type { ExternalMatch } from '../src/providers/types.js';
import { GROUP, freshDb, user } from './helpers.js';

beforeEach(() => freshDb());

function addPlaytomic(withMatch: boolean): OutgoingMessage[] {
  const gui = user('Gui Hering');
  const start = DateTime.utc().plus({ days: 3 }).set({ hour: 17, minute: 30 }).toISO()!;
  const p = parseMessage('!playtomic https://app.playtomic.com/matches/a6301dc2-8119-42a2-9605-644cb1222b4e', { prefix: '!', prefixOptional: true });
  if (p.kind !== 'command') throw new Error('not a command');
  const cmd = p.command;
  // Dispatcher would have filled these from the fetched match:
  cmd.fields.set('date', start.slice(0, 10));
  cmd.fields.set('time', '19:30');
  cmd.fields.set('venue', 'Ocean Athletics Club');
  cmd.fields.set('court', '3');
  if (withMatch) {
    cmd.prefetchedMatch = {
      providerMatchId: 'abc', provider: 'Playtomic', url: 'https://app.playtomic.com/matches/a6301dc2-8119-42a2-9605-644cb1222b4e',
      venueName: 'Ocean Athletics Club', address: null, court: '3', startsAtIso: start, endsAtIso: null,
      timezone: 'Europe/Berlin', sport: 'PADEL', status: 'PENDING',
      players: ['Gui Hering'], slotsTotal: 4, slotsFree: 3, priceLabel: null,
    } satisfies ExternalMatch;
  }
  return handleCommand(cmd, {
    groupId: GROUP, user: gui, isAdmin: false, chatId: 'g', isGroup: true,
    dict: t('en'), settings: getSettings(GROUP), mentionedUserIds: [],
  });
}

describe('adding a Playtomic match posts exactly one complete card', () => {
  it('uses the real provider label (not the URL host) and shows the roster', () => {
    const out = addPlaytomic(true);
    const group = out.filter((m) => m.target === 'group');
    expect(group).toHaveLength(1);
    const text = group[0]!.text;
    expect(text).toContain('Playtomic');
    expect(text).not.toContain('App'); // the old providerFromUrl bug
    expect(text).toContain('Ocean Athletics Club');
    expect(text).toContain('Gui Hering'); // roster present at creation
    expect(text).toContain('3 spots left');
  });

  it('marks the booking synced so the sync job will not post a second card', () => {
    const out = addPlaytomic(true);
    const code = out.map((m) => m.text).join(' ').match(/\*([A-Z0-9]{4})\*/)![1]!;
    expect(findBookingByCode(code)!.external_synced_at).not.toBeNull();
  });

  it('without a prefetched match, leaves it unsynced (first sync will announce)', () => {
    const out = addPlaytomic(false);
    const code = out.map((m) => m.text).join(' ').match(/\*([A-Z0-9]{4})\*/)![1]!;
    expect(findBookingByCode(code)!.external_synced_at).toBeNull();
    // still labelled Playtomic via providerFor fallback, not "App"
    expect(out.find((m) => m.target === 'group')!.text).toContain('Playtomic');
  });
});

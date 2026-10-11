import { beforeEach, describe, expect, it } from 'vitest';
import { dashboardPage } from '../src/web/pages.js';
import { ensureGroup } from '../src/domain/groups.js';
import { freshDb } from './helpers.js';

beforeEach(() => freshDb());

describe('dashboard reports a group as linked from its real wa_jid', () => {
  it('shows a newly added group as linked, not "No WhatsApp group linked yet"', () => {
    // A group the bot joined: ensureGroup sets groups.wa_jid, and nothing ever
    // writes the old settings.groupJid. This is exactly the production shape
    // that used to show a false "not linked" warning.
    const jid = '120363427805070158@g.us';
    const g = ensureGroup(jid, 'Padel FFM');

    const html = dashboardPage(true, g.id);
    expect(html).toContain(jid); // the real JID is shown
    expect(html).not.toContain('No WhatsApp group linked yet.');
  });
});

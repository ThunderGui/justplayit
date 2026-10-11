import { beforeEach, describe, expect, it } from 'vitest';
import { placesPage, settingsPage } from '../src/web/pages.js';
import { ensureGroup } from '../src/domain/groups.js';
import { createPlace } from '../src/domain/places.js';
import { freshDb } from './helpers.js';

beforeEach(() => freshDb());

/**
 * Group-scoped forms must post back to the SAME group. A bare action falls
 * back to the first group server-side, which is how a club added while viewing
 * "Tennis FFM" ended up in "Test Group".
 */
describe('group-scoped console forms carry the current group', () => {
  it('Places add + delete forms post to ?g=<current group>', () => {
    const g = ensureGroup('120363430683506509@g.us', 'Tennis FFM');
    createPlace({ groupId: g.id, name: 'Tennis Center' });

    const html = placesPage(g.id);
    expect(html).toContain(`action="/places?g=${g.id}"`); // add
    expect(html).toContain(`/delete?g=${g.id}"`); // delete
    // It must NOT emit a bare action that would default to group 1.
    expect(html).not.toContain('action="/places"');
  });

  it('Settings form posts to ?g=<current group>', () => {
    const g = ensureGroup('120363430683506509@g.us', 'Tennis FFM');
    expect(settingsPage(g.id)).toContain(`action="/settings?g=${g.id}"`);
  });
});

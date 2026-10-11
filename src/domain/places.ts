import { many, one, run } from '../db/index.js';
import { nowIso } from '../util/datetime.js';

export interface Place {
  id: number;
  group_id: number;
  name: string;
  address: string | null;
  maps_url: string | null;
  active: number;
  created_at: string;
}

export function listPlaces(groupId: number, includeInactive = false): Place[] {
  return includeInactive
    ? many<Place>('SELECT * FROM places WHERE group_id = ? ORDER BY name COLLATE NOCASE', groupId)
    : many<Place>(
        'SELECT * FROM places WHERE group_id = ? AND active = 1 ORDER BY name COLLATE NOCASE',
        groupId,
      );
}

export function findPlaceById(id: number): Place | undefined {
  return one<Place>('SELECT * FROM places WHERE id = ?', id);
}

/**
 * Resolves what a user typed against the club list. Exact name wins; otherwise
 * a unique prefix/substring match, so "padel b" finds "Padel Base".
 * An ambiguous match returns null so the caller can ask them to be specific.
 */
export function resolvePlace(
  input: string,
  groupId: number,
): { place?: Place; ambiguous?: Place[] } {
  const query = input.trim().toLowerCase();
  if (!query) return {};

  const places = listPlaces(groupId);
  const exact = places.find((p) => p.name.toLowerCase() === query);
  if (exact) return { place: exact };

  const matches = places.filter((p) => p.name.toLowerCase().includes(query));
  if (matches.length === 1) return { place: matches[0]! };
  if (matches.length > 1) return { ambiguous: matches };
  return {};
}

export function createPlace(input: {
  groupId: number;
  name: string;
  address?: string | null;
  mapsUrl?: string | null;
}): Place {
  const { lastInsertRowid } = run(
    'INSERT INTO places (group_id, name, address, maps_url, active, created_at) VALUES (?, ?, ?, ?, 1, ?)',
    input.groupId,
    input.name.trim(),
    input.address?.trim() || null,
    input.mapsUrl?.trim() || null,
    nowIso(),
  );
  return findPlaceById(lastInsertRowid)!;
}

export function updatePlace(
  id: number,
  patch: { name?: string; address?: string | null; mapsUrl?: string | null; active?: boolean },
): void {
  const current = findPlaceById(id);
  if (!current) return;
  run(
    'UPDATE places SET name = ?, address = ?, maps_url = ?, active = ? WHERE id = ?',
    patch.name?.trim() ?? current.name,
    patch.address !== undefined ? patch.address?.trim() || null : current.address,
    patch.mapsUrl !== undefined ? patch.mapsUrl?.trim() || null : current.maps_url,
    patch.active !== undefined ? (patch.active ? 1 : 0) : current.active,
    id,
  );
}

/**
 * Places referenced by a booking are deactivated rather than deleted, so old
 * bookings keep their location.
 */
export function deletePlace(id: number): 'deleted' | 'deactivated' {
  const inUse = one<{ n: number }>('SELECT COUNT(*) AS n FROM bookings WHERE place_id = ?', id)!.n;
  if (inUse > 0) {
    run('UPDATE places SET active = 0 WHERE id = ?', id);
    return 'deactivated';
  }
  run('DELETE FROM places WHERE id = ?', id);
  return 'deleted';
}

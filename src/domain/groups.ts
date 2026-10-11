import { many, one, run } from '../db/index.js';
import { nowIso } from '../util/datetime.js';

/**
 * A group is a complete, isolated world: its own settings, places, bookings,
 * members and ledger. Nothing crosses between groups — least of all money.
 */

export type Sport = 'padel' | 'tennis' | 'squash' | 'badminton' | 'other';

export const SPORTS: Sport[] = ['padel', 'tennis', 'squash', 'badminton', 'other'];

export interface Group {
  id: number;
  wa_jid: string;
  name: string | null;
  sport: Sport;
  active: number;
  created_at: string;
}

export interface GroupMember {
  group_id: number;
  user_id: number;
  is_admin: number;
  joined_at: string;
}

/** Court sizes differ by sport, so a sensible default roster does too. */
export const SPORT_DEFAULT_PLAYERS: Record<Sport, { min: number; max: number }> = {
  padel: { min: 4, max: 4 },
  tennis: { min: 2, max: 4 }, // singles or doubles
  squash: { min: 2, max: 2 },
  badminton: { min: 2, max: 4 },
  other: { min: 2, max: 4 },
};

export function findGroupById(id: number): Group | undefined {
  return one<Group>('SELECT * FROM groups WHERE id = ?', id);
}

export function findGroupByJid(waJid: string): Group | undefined {
  return one<Group>('SELECT * FROM groups WHERE wa_jid = ?', waJid);
}

export function listGroups(includeInactive = false): Group[] {
  return includeInactive
    ? many<Group>('SELECT * FROM groups ORDER BY id')
    : many<Group>('SELECT * FROM groups WHERE active = 1 ORDER BY id');
}

export function createGroup(input: {
  waJid: string;
  name?: string | null;
  sport?: Sport;
}): Group {
  const { lastInsertRowid } = run(
    `INSERT INTO groups (wa_jid, name, sport, active, created_at) VALUES (?, ?, ?, 1, ?)`,
    input.waJid,
    input.name?.trim() || null,
    input.sport ?? 'padel',
    nowIso(),
  );
  return findGroupById(lastInsertRowid)!;
}

/**
 * Finds the group for a WhatsApp chat, creating it on first contact.
 *
 * Self-registration is what makes multi-group practical: adding the bot to a
 * new group and sending one command is the whole setup, rather than an admin
 * having to pre-register every group's JID in the console first.
 */
export function ensureGroup(waJid: string, name?: string | null): Group {
  const existing = findGroupByJid(waJid);
  if (existing) {
    if (name && name !== existing.name) {
      run('UPDATE groups SET name = ? WHERE id = ?', name, existing.id);
      return { ...existing, name };
    }
    return existing;
  }
  return createGroup({ waJid, name: name ?? null });
}

export function updateGroup(
  id: number,
  patch: { name?: string | null; sport?: Sport; active?: boolean },
): void {
  const current = findGroupById(id);
  if (!current) return;
  run(
    'UPDATE groups SET name = ?, sport = ?, active = ? WHERE id = ?',
    patch.name !== undefined ? patch.name?.trim() || null : current.name,
    patch.sport ?? current.sport,
    patch.active !== undefined ? (patch.active ? 1 : 0) : current.active,
    id,
  );
}

/* ------------------------------------------------------------------ */
/* Membership                                                          */
/* ------------------------------------------------------------------ */

export function findMember(groupId: number, userId: number): GroupMember | undefined {
  return one<GroupMember>(
    'SELECT * FROM group_members WHERE group_id = ? AND user_id = ?',
    groupId,
    userId,
  );
}

/** Adds the member if absent. Never downgrades an existing admin by accident. */
export function ensureMember(groupId: number, userId: number, isAdmin?: boolean): GroupMember {
  const existing = findMember(groupId, userId);
  if (existing) {
    if (isAdmin !== undefined && existing.is_admin !== (isAdmin ? 1 : 0)) {
      run(
        'UPDATE group_members SET is_admin = ? WHERE group_id = ? AND user_id = ?',
        isAdmin ? 1 : 0,
        groupId,
        userId,
      );
      return { ...existing, is_admin: isAdmin ? 1 : 0 };
    }
    return existing;
  }
  run(
    'INSERT INTO group_members (group_id, user_id, is_admin, joined_at) VALUES (?, ?, ?, ?)',
    groupId,
    userId,
    isAdmin ? 1 : 0,
    nowIso(),
  );
  return findMember(groupId, userId)!;
}

export function listMembers(groupId: number): GroupMember[] {
  return many<GroupMember>('SELECT * FROM group_members WHERE group_id = ?', groupId);
}

export function listGroupAdmins(groupId: number): GroupMember[] {
  return many<GroupMember>(
    'SELECT * FROM group_members WHERE group_id = ? AND is_admin = 1',
    groupId,
  );
}

export function isGroupAdmin(groupId: number, userId: number): boolean {
  return findMember(groupId, userId)?.is_admin === 1;
}

/** Groups a person belongs to. Used to answer a DM without a group context. */
export function groupsForUser(userId: number): Group[] {
  return many<Group>(
    `SELECT g.* FROM groups g
       JOIN group_members m ON m.group_id = g.id
      WHERE m.user_id = ? AND g.active = 1
      ORDER BY g.id`,
    userId,
  );
}

/**
 * Replaces the admin set for a group with the one WhatsApp reports.
 *
 * WhatsApp is the source of truth: whoever administers the chat administers the
 * bot, so nobody has to maintain a second list that silently drifts out of
 * date. Returns the users whose admin status actually changed.
 */
export function syncGroupAdmins(groupId: number, adminUserIds: number[]): number[] {
  const wanted = new Set(adminUserIds);
  const changed: number[] = [];

  for (const member of listMembers(groupId)) {
    const shouldBeAdmin = wanted.has(member.user_id);
    if (shouldBeAdmin === (member.is_admin === 1)) continue;
    run(
      'UPDATE group_members SET is_admin = ? WHERE group_id = ? AND user_id = ?',
      shouldBeAdmin ? 1 : 0,
      groupId,
      member.user_id,
    );
    changed.push(member.user_id);
  }

  // An admin the bot has not seen post yet still needs a membership row.
  for (const userId of wanted) {
    if (!findMember(groupId, userId)) {
      ensureMember(groupId, userId, true);
      changed.push(userId);
    }
  }

  return changed;
}

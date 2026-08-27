import { many, one, run } from '../db/index.js';
import { nowIso } from '../util/datetime.js';
import type { Lang } from './settings.js';
import { getSetting } from './settings.js';

export interface User {
  id: number;
  wa_id: string;
  phone: string | null;
  display_name: string | null;
  language: Lang | null;
  is_admin: number;
  payment_handle: string | null;
  created_at: string;
  anonymised_at: string | null;
}

/** WhatsApp JIDs arrive with device/session suffixes; the account is the stem. */
export function normaliseJid(jid: string): string {
  const [user = '', domain = 's.whatsapp.net'] = jid.split('@');
  const account = user.split(':')[0] ?? '';
  return `${account}@${domain}`;
}

export function phoneFromJid(jid: string): string | null {
  const account = jid.split('@')[0]?.split(':')[0] ?? '';
  return /^\d{6,20}$/.test(account) ? `+${account}` : null;
}

export function findUserById(id: number): User | undefined {
  return one<User>('SELECT * FROM users WHERE id = ?', id);
}

export function findUserByJid(waId: string): User | undefined {
  return one<User>('SELECT * FROM users WHERE wa_id = ?', normaliseJid(waId));
}

/**
 * Looks up the sender, creating a lightweight record on first contact.
 * The very first user to talk to the bot becomes admin, which is how a fresh
 * install bootstraps without touching the database by hand.
 */
export function upsertUser(waId: string, displayName?: string | null): User {
  const jid = normaliseJid(waId);
  const existing = findUserByJid(jid);

  if (existing) {
    if (displayName && displayName !== existing.display_name && !existing.anonymised_at) {
      run('UPDATE users SET display_name = ? WHERE id = ?', displayName, existing.id);
      // A rename can create or resolve a collision.
      invalidateNameCache();
      return { ...existing, display_name: displayName };
    }
    return existing;
  }

  const isFirstUser = one<{ n: number }>('SELECT COUNT(*) AS n FROM users')!.n === 0;
  const { lastInsertRowid } = run(
    `INSERT INTO users (wa_id, phone, display_name, is_admin, created_at)
     VALUES (?, ?, ?, ?, ?)`,
    jid,
    phoneFromJid(jid),
    displayName ?? null,
    isFirstUser ? 1 : 0,
    nowIso(),
  );
  invalidateNameCache();
  return findUserById(lastInsertRowid)!;
}

export function isAdmin(user: User): boolean {
  return user.is_admin === 1;
}

export function listUsers(): User[] {
  return many<User>('SELECT * FROM users ORDER BY display_name COLLATE NOCASE, id');
}

export function listAdmins(): User[] {
  return many<User>('SELECT * FROM users WHERE is_admin = 1 ORDER BY id');
}

export function setAdmin(userId: number, value: boolean): void {
  run('UPDATE users SET is_admin = ? WHERE id = ?', value ? 1 : 0, userId);
}

export function setUserLanguage(userId: number, lang: Lang | null): void {
  run('UPDATE users SET language = ? WHERE id = ?', lang, userId);
}

export function setPaymentHandle(userId: number, handle: string | null): void {
  run('UPDATE users SET payment_handle = ? WHERE id = ?', handle, userId);
}

export function languageFor(user: User | undefined): Lang {
  return user?.language ?? getSetting('language');
}

/**
 * Names that more than one active user shares. Cached because it is consulted
 * for every name rendered, and invalidated whenever a user is added, renamed or
 * erased — the only things that can change the answer.
 */
let duplicateNames: Set<string> | null = null;

function duplicateNameSet(): Set<string> {
  if (duplicateNames) return duplicateNames;

  const rows = many<{ name: string }>(
    `SELECT LOWER(TRIM(display_name)) AS name
       FROM users
      WHERE display_name IS NOT NULL AND TRIM(display_name) <> '' AND anonymised_at IS NULL
      GROUP BY LOWER(TRIM(display_name))
      HAVING COUNT(*) > 1`,
  );

  duplicateNames = new Set(rows.map((r) => r.name));
  return duplicateNames;
}

export function invalidateNameCache(): void {
  duplicateNames = null;
}

/** The bracketed tail that tells two same-named people apart. */
export function nameSuffix(user: User): string {
  return user.phone ? `…${user.phone.slice(-4)}` : `#${user.id}`;
}

/**
 * Short label used in group messages. Falls back to a masked phone.
 *
 * When two people in the group share a name — likely, since WhatsApp push names
 * are often just a first name — the label gains the last digits of their number
 * so a roster or a balance is never two identical lines. Unique names are left
 * completely alone, which is the overwhelmingly common case.
 */
export function displayName(user: User | undefined): string {
  if (!user) return 'someone';
  if (user.anonymised_at) return 'deleted user';

  if (user.display_name) {
    const name = user.display_name.trim();
    if (!duplicateNameSet().has(name.toLowerCase())) return name;
    return `${name} (${nameSuffix(user)})`;
  }

  if (user.phone) return `…${user.phone.slice(-4)}`;
  return `user ${user.id}`;
}

/**
 * GDPR erasure. The ledger row must survive (it is another person's financial
 * record too), so identifiers are wiped in place rather than the row deleted.
 */
export function anonymiseUser(userId: number): void {
  run(
    `UPDATE users
        SET wa_id = 'deleted:' || id,
            phone = NULL,
            display_name = NULL,
            payment_handle = NULL,
            is_admin = 0,
            anonymised_at = ?
      WHERE id = ?`,
    nowIso(),
    userId,
  );
  run('DELETE FROM pending_actions WHERE user_id = ?', userId);
  // Erasing one of two same-named people makes the other unique again.
  invalidateNameCache();
}

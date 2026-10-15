import crypto from 'node:crypto';
import { many, one, run } from '../db/index.js';
import { nowIso } from '../util/datetime.js';

/**
 * Named logins for the web console. Every console user is a full admin — the
 * access model the operator chose. Passwords are stored as scrypt hashes
 * (salt + derived key), never in the clear. The env ADMIN_PASSWORD remains a
 * separate owner/break-glass login, handled in the server, not here.
 */
export interface ConsoleUser {
  id: number;
  username: string;
  created_at: string;
}

function hashPassword(password: string): string {
  const salt = crypto.randomBytes(16);
  const dk = crypto.scryptSync(password, salt, 64);
  return `scrypt$${salt.toString('base64url')}$${dk.toString('base64url')}`;
}

function passwordMatches(password: string, stored: string): boolean {
  const [alg, saltB64, hashB64] = stored.split('$');
  if (alg !== 'scrypt' || !saltB64 || !hashB64) return false;
  const salt = Buffer.from(saltB64, 'base64url');
  const expected = Buffer.from(hashB64, 'base64url');
  const dk = crypto.scryptSync(password, salt, 64);
  return dk.length === expected.length && crypto.timingSafeEqual(dk, expected);
}

const USERNAME_RE = /^[a-zA-Z0-9._-]{3,32}$/;

export function isValidUsername(username: string): boolean {
  return USERNAME_RE.test(username);
}

export function countConsoleUsers(): number {
  return one<{ n: number }>('SELECT COUNT(*) AS n FROM console_users')!.n;
}

export function listConsoleUsers(): ConsoleUser[] {
  return many<ConsoleUser>('SELECT id, username, created_at FROM console_users ORDER BY username');
}

export function consoleUsernameTaken(username: string): boolean {
  return one('SELECT 1 AS x FROM console_users WHERE username = ?', username) != null;
}

/** Adds a login. Returns false if the name is invalid or already taken. */
export function addConsoleUser(username: string, password: string): boolean {
  const name = username.trim();
  if (!isValidUsername(name) || password.length < 6) return false;
  if (consoleUsernameTaken(name)) return false;
  run(
    'INSERT INTO console_users (username, password_hash, created_at) VALUES (?, ?, ?)',
    name,
    hashPassword(password),
    nowIso(),
  );
  return true;
}

export function verifyConsoleUser(username: string, password: string): boolean {
  const row = one<{ password_hash: string }>(
    'SELECT password_hash FROM console_users WHERE username = ?',
    username.trim(),
  );
  if (!row) return false;
  return passwordMatches(password, row.password_hash);
}

export function setConsolePassword(username: string, password: string): boolean {
  if (password.length < 6) return false;
  const { changes } = run(
    'UPDATE console_users SET password_hash = ? WHERE username = ?',
    hashPassword(password),
    username.trim(),
  );
  return changes > 0;
}

export function setConsolePasswordById(id: number, password: string): boolean {
  if (password.length < 6) return false;
  const { changes } = run('UPDATE console_users SET password_hash = ? WHERE id = ?', hashPassword(password), id);
  return changes > 0;
}

export function deleteConsoleUser(id: number): void {
  run('DELETE FROM console_users WHERE id = ?', id);
}

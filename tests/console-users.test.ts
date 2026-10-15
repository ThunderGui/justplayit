import { beforeEach, describe, expect, it } from 'vitest';
import {
  addConsoleUser, verifyConsoleUser, listConsoleUsers, consoleUsernameTaken,
  deleteConsoleUser, setConsolePasswordById, isValidUsername,
} from '../src/domain/console-users.js';
import { freshDb } from './helpers.js';
import { one } from '../src/db/index.js';

beforeEach(() => freshDb());

describe('console logins', () => {
  it('adds a login and verifies the right password', () => {
    expect(addConsoleUser('friend', 'secret1')).toBe(true);
    expect(verifyConsoleUser('friend', 'secret1')).toBe(true);
    expect(verifyConsoleUser('friend', 'wrong')).toBe(false);
    expect(verifyConsoleUser('nobody', 'secret1')).toBe(false);
  });

  it('is case-insensitive on the username', () => {
    addConsoleUser('Friend', 'secret1');
    expect(verifyConsoleUser('friend', 'secret1')).toBe(true);
    expect(consoleUsernameTaken('FRIEND')).toBe(true);
  });

  it('rejects a duplicate, a bad username, or a short password', () => {
    addConsoleUser('friend', 'secret1');
    expect(addConsoleUser('friend', 'other1')).toBe(false); // taken
    expect(addConsoleUser('ab', 'secret1')).toBe(false); // too short username
    expect(addConsoleUser('has space', 'secret1')).toBe(false); // invalid chars
    expect(addConsoleUser('ok_user', '12345')).toBe(false); // short password
    expect(isValidUsername('ok.user-1')).toBe(true);
  });

  it('never stores the password in the clear', () => {
    addConsoleUser('friend', 'secret1');
    // one imported below
    const row = one('SELECT password_hash FROM console_users WHERE username = ?', 'friend');
    expect(row.password_hash).not.toContain('secret1');
    expect(row.password_hash.startsWith('scrypt$')).toBe(true);
  });

  it('resets a password by id and removes a login', () => {
    addConsoleUser('friend', 'secret1');
    const id = listConsoleUsers()[0]!.id;
    expect(setConsolePasswordById(id, 'newpass')).toBe(true);
    expect(verifyConsoleUser('friend', 'newpass')).toBe(true);
    expect(verifyConsoleUser('friend', 'secret1')).toBe(false);
    deleteConsoleUser(id);
    expect(verifyConsoleUser('friend', 'newpass')).toBe(false);
  });
});

import { describe as d2, it as i2, expect as e2 } from 'vitest';
import { layout } from '../src/web/layout.js';

d2('the Access link is owner-only in the nav', () => {
  i2('shows for the owner, hidden for a named admin', () => {
    e2(layout('<p>x</p>', { title: 'T', isOwner: true })).toContain('>Access<');
    e2(layout('<p>x</p>', { title: 'T', isOwner: false })).not.toContain('>Access<');
  });
});

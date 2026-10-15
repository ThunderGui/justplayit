import { describe, expect, it } from 'vitest';
import { adminPasswordWeakness } from '../src/util/password.js';

describe('owner password weakness check', () => {
  it('flags the obvious weak cases', () => {
    expect(adminPasswordWeakness('')).toContain('not set');
    expect(adminPasswordWeakness('short')).toContain('12');
    expect(adminPasswordWeakness('ownerpass')).toBeTruthy(); // in common list
    expect(adminPasswordWeakness('administrator')).toContain('common'); // 13 chars, in common list
    expect(adminPasswordWeakness('password123')).toBeTruthy(); // weak (too short)
    expect(adminPasswordWeakness('aaaaaaaaaaaa')).toContain('repeated');
    expect(adminPasswordWeakness('123456789012')).toContain('digits');
  });

  it('passes a decent password', () => {
    expect(adminPasswordWeakness('tR0ub4dour-Horse-Battery')).toBeNull();
    expect(adminPasswordWeakness('a-fairly-long-unique-one')).toBeNull();
  });
});

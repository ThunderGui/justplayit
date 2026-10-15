/**
 * Flags a weak owner (ADMIN_PASSWORD) login. Not a strength meter — just a few
 * clear, cheap red flags, since this password is a full-admin login that is
 * reachable from the internet once the console is tunnelled. Returns a short
 * reason phrase when weak, or null when it passes.
 */
const COMMON = new Set([
  'password', 'password1', 'password123', 'passw0rd', 'admin', 'admin123',
  'administrator', 'root', 'changeme', 'change-me', 'letmein', 'welcome',
  'welcome1', 'secret', 'qwerty', 'qwertyuiop', '123456', '1234567', '12345678',
  '123456789', '1234567890', '111111', '000000', 'iloveyou', 'test', 'test123',
  'ownerpass', 'justplayit', 'padel', 'tennis',
]);

export function adminPasswordWeakness(password: string): string | null {
  if (!password) return 'is not set';
  if (password.length < 12) return 'is shorter than 12 characters';
  if (COMMON.has(password.toLowerCase())) return 'is a very common password';
  if (/^(.)\1+$/.test(password)) return 'is a single character repeated';
  if (/^\d+$/.test(password)) return 'is only digits';
  return null;
}

/** Minimal HTML escaping for every interpolated value. */
export function esc(value: unknown): string {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

const STYLES = `
:root {
  color-scheme: light dark;
  --bg: #f6f7f9;
  --surface: #ffffff;
  --border: #e2e5ea;
  --text: #1a1d21;
  --muted: #666e7a;
  --accent: #1f7a4d;
  --accent-text: #ffffff;
  --danger: #b3261e;
  --radius: 10px;
}
@media (prefers-color-scheme: dark) {
  :root {
    --bg: #14161a;
    --surface: #1c1f24;
    --border: #2c3138;
    --text: #e8eaed;
    --muted: #9aa3ad;
    --accent: #37b26e;
    --accent-text: #06130c;
    --danger: #f2726a;
  }
}
* { box-sizing: border-box; }
body {
  margin: 0;
  background: var(--bg);
  color: var(--text);
  font: 15px/1.55 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
}
header.top {
  background: var(--surface);
  border-bottom: 1px solid var(--border);
  padding: 0 20px;
  display: flex;
  align-items: center;
  gap: 22px;
  flex-wrap: wrap;
  position: sticky;
  top: 0;
  z-index: 10;
}
header.top .brand { font-weight: 700; padding: 14px 0; margin-right: 4px; }
header.top nav { display: flex; gap: 18px; flex-wrap: wrap; }
header.top nav a {
  color: var(--muted);
  text-decoration: none;
  padding: 14px 0;
  border-bottom: 2px solid transparent;
}
header.top nav a:hover { color: var(--text); }
header.top nav a.active { color: var(--text); border-bottom-color: var(--accent); }
header.top .spacer { margin-left: auto; }
main { max-width: 960px; margin: 0 auto; padding: 24px 20px 60px; }
h1 { font-size: 22px; margin: 0 0 4px; }
h2 { font-size: 16px; margin: 28px 0 10px; }
p.sub { color: var(--muted); margin: 0 0 22px; }
.card {
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: var(--radius);
  padding: 18px;
  margin-bottom: 16px;
}
table { width: 100%; border-collapse: collapse; }
th, td { text-align: left; padding: 9px 10px; border-bottom: 1px solid var(--border); }
th { color: var(--muted); font-weight: 600; font-size: 12px; text-transform: uppercase; letter-spacing: .04em; }
tr:last-child td { border-bottom: none; }
.table-wrap { overflow-x: auto; }
code, .mono { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 13px; }
label { display: block; margin: 14px 0 5px; font-weight: 600; font-size: 13px; }
label .hint { display: block; font-weight: 400; color: var(--muted); font-size: 12px; margin-top: 2px; }
input[type=text], input[type=number], input[type=password], input[type=url], select, textarea {
  width: 100%;
  padding: 9px 11px;
  border: 1px solid var(--border);
  border-radius: 8px;
  background: var(--bg);
  color: var(--text);
  font: inherit;
}
input[type=checkbox] { width: 16px; height: 16px; vertical-align: -2px; margin-right: 7px; }
button, .btn {
  background: var(--accent);
  color: var(--accent-text);
  border: none;
  border-radius: 8px;
  padding: 9px 16px;
  font: inherit;
  font-weight: 600;
  cursor: pointer;
  text-decoration: none;
  display: inline-block;
}
button.secondary, .btn.secondary { background: transparent; color: var(--text); border: 1px solid var(--border); }
button.danger, .btn.danger { background: transparent; color: var(--danger); border: 1px solid var(--danger); }
.row { display: flex; gap: 14px; flex-wrap: wrap; }
.row > * { flex: 1 1 200px; }
.pill {
  display: inline-block; padding: 2px 9px; border-radius: 99px;
  font-size: 12px; font-weight: 600; border: 1px solid var(--border); color: var(--muted);
}
.pill.ok { color: var(--accent); border-color: var(--accent); }
.pill.warn { color: var(--danger); border-color: var(--danger); }
.flash { padding: 11px 14px; border-radius: 8px; margin-bottom: 18px; font-weight: 600; }
.flash.ok { background: color-mix(in srgb, var(--accent) 15%, transparent); color: var(--accent); }
.flash.err { background: color-mix(in srgb, var(--danger) 15%, transparent); color: var(--danger); }
.muted { color: var(--muted); }
.actions { display: flex; gap: 8px; margin-top: 18px; flex-wrap: wrap; }
.empty { color: var(--muted); padding: 22px 0; text-align: center; }
form.inline { display: inline; }
.login { max-width: 340px; margin: 12vh auto; }
`;

export interface LayoutOptions {
  title: string;
  active?: string;
  flash?: { kind: 'ok' | 'err'; text: string } | null;
  /** Chrome is hidden on the login page. */
  bare?: boolean;
}

const NAV: [string, string][] = [
  ['/', 'Dashboard'],
  ['/bookings', 'Bookings'],
  ['/places', 'Places'],
  ['/people', 'People'],
  ['/money', 'Money'],
  ['/reports', 'Reports'],
  ['/settings', 'Settings'],
];

export function layout(body: string, options: LayoutOptions): string {
  const nav = NAV.map(
    ([href, label]) =>
      `<a href="${href}"${options.active === href ? ' class="active"' : ''}>${esc(label)}</a>`,
  ).join('');

  const flash = options.flash
    ? `<div class="flash ${options.flash.kind}">${esc(options.flash.text)}</div>`
    : '';

  const chrome = options.bare
    ? ''
    : `<header class="top">
         <span class="brand">🎾 Just Play It</span>
         <nav>${nav}</nav>
         <span class="spacer"></span>
         <form method="post" action="/logout" class="inline">
           <button class="secondary" type="submit">Sign out</button>
         </form>
       </header>`;

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow">
<title>${esc(options.title)} · Just Play It</title>
<style>${STYLES}</style>
</head>
<body>
${chrome}
<main>${flash}${body}</main>
</body>
</html>`;
}

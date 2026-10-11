import { DateTime } from 'luxon';
import type { BackupFile } from '../domain/backup.js';
import { findGroupById, listGroups, listMembers, SPORTS, type Group } from '../domain/groups.js';
import {
  getRoster,
  listAllBookings,
  listUpcoming,
  placeLabel,
  type Booking,
} from '../domain/bookings.js';
import { listLedger, overallBalances, simplifyDebts } from '../domain/ledger.js';
import { listPendingClaims } from '../domain/payments.js';
import { listPlaces, type Place } from '../domain/places.js';
import {
  DEFAULT_SETTINGS,
  getSettings,
  type PaymentConfirmationMode,
  type Settings,
} from '../domain/settings.js';
import { displayName, findUserById, listUsers, type User } from '../domain/users.js';
import { LANGUAGE_NAMES, SUPPORTED_LANGUAGES } from '../i18n/index.js';
import { formatDateTime } from '../util/datetime.js';
import { formatMoney } from '../util/money.js';
import { esc } from './layout.js';

const money = (cents: number, currency = getSettings().currency) => formatMoney(cents, currency);
const when = (iso: string) => {
  const s = getSettings();
  return formatDateTime(iso, s.timezone, s.language);
};

/* ------------------------------------------------------------------ */
/* Login                                                               */
/* ------------------------------------------------------------------ */

export function loginPage(error?: string): string {
  return `
  <div class="login">
    <div class="card">
      <h1>🎾 Just Play It</h1>
      <p class="sub">Admin console</p>
      ${error ? `<div class="flash err">${esc(error)}</div>` : ''}
      <form method="post" action="/login">
        <label for="password">Password</label>
        <input type="password" id="password" name="password" autofocus autocomplete="current-password" required>
        <div class="actions"><button type="submit">Sign in</button></div>
      </form>
    </div>
  </div>`;
}

/* ------------------------------------------------------------------ */
/* Dashboard                                                           */
/* ------------------------------------------------------------------ */

export function dashboardPage(connected: boolean, groupId: number): string {
  const group = findGroupById(groupId);
  const upcoming = listUpcoming(groupId, 10);
  const claims = listPendingClaims(groupId);
  const admins = listUsers().filter((u) => u.is_admin === 1);

  const setupIssues: string[] = [];
  if (!group?.wa_jid) setupIssues.push('No WhatsApp group linked yet.');
  if (admins.length === 0) setupIssues.push('No admin user recognised yet.');
  if (listPlaces(groupId).length === 0) setupIssues.push('No places added yet.');

  return `
  <h1>Dashboard</h1>
  <p class="sub">Overview of the bot and what is coming up.</p>

  <div class="card">
    <h2 style="margin-top:0">Status</h2>
    <table>
      <tr><td>WhatsApp</td><td>${
        connected
          ? '<span class="pill ok">Connected</span>'
          : '<span class="pill warn">Not connected</span> <span class="muted">— check the container logs for the QR code</span>'
      }</td></tr>
      <tr><td>Group</td><td>${
        group?.wa_jid
          ? `<code>${esc(group.wa_jid)}</code>`
          : '<span class="muted">not linked</span>'
      }</td></tr>
      <tr><td>Admins</td><td>${admins.map((a) => esc(displayName(a))).join(', ') || '<span class="muted">none</span>'}</td></tr>
      <tr><td>Pending payments</td><td>${claims.length}</td></tr>
    </table>
    ${
      setupIssues.length > 0
        ? `<div class="flash err" style="margin:16px 0 0">${setupIssues.map(esc).join('<br>')}</div>`
        : ''
    }
  </div>

  <h2>Next games</h2>
  <div class="card">${bookingTable(upcoming)}</div>

  ${
    claims.length > 0
      ? `<h2>Payments awaiting confirmation</h2>
         <div class="card"><div class="table-wrap"><table>
           <tr><th>ID</th><th>From</th><th>To</th><th>Amount</th><th></th></tr>
           ${claims
             .map(
               (c) => `<tr>
             <td class="mono">${esc(c.code)}</td>
             <td>${esc(displayName(findUserById(c.from_user_id)))}</td>
             <td>${esc(displayName(findUserById(c.to_user_id)))}</td>
             <td>${esc(money(c.amount_cents, c.currency))}</td>
             <td>
               <form method="post" action="/claims/${c.id}/approve" class="inline"><button type="submit">Approve</button></form>
               <form method="post" action="/claims/${c.id}/reject" class="inline"><button class="danger" type="submit">Reject</button></form>
             </td></tr>`,
             )
             .join('')}
         </table></div></div>`
      : ''
  }`;
}

/* ------------------------------------------------------------------ */
/* Bookings                                                            */
/* ------------------------------------------------------------------ */

function bookingTable(bookings: Booking[]): string {
  if (bookings.length === 0) return '<div class="empty">Nothing scheduled.</div>';

  return `<div class="table-wrap"><table>
    <tr><th>ID</th><th>When</th><th>Place</th><th>Players</th><th>Cost</th><th>Status</th><th></th></tr>
    ${bookings
      .map((b) => {
        const external = b.kind === 'EXTERNAL';
        const roster = external ? null : getRoster(b.id);
        const players = external
          ? `<span class="muted">on ${esc(b.external_provider ?? 'platform')}</span>`
          : `${roster!.confirmed.length}/${b.max_players}` +
            (roster!.waitlist.length ? ` <span class="muted">+${roster!.waitlist.length}</span>` : '');

        return `<tr>
          <td class="mono">${esc(b.code)}</td>
          <td>${esc(when(b.starts_at))}</td>
          <td>${esc(placeLabel(b))}${
            external && b.external_url
              ? ` <a href="${esc(b.external_url)}" target="_blank" rel="noopener noreferrer">↗</a>`
              : ''
          }</td>
          <td>${players}</td>
          <td>${external ? '<span class="muted">—</span>' : esc(money(b.total_cost_cents, b.currency))}</td>
          <td><span class="pill ${b.status === 'OPEN' ? 'ok' : ''}">${esc(b.status)}</span></td>
          <td>
            ${
              b.status === 'OPEN'
                ? `<a class="btn secondary" href="/bookings/${b.id}/edit">Edit</a>`
                : ''
            }
            ${
              b.status === 'OPEN'
                ? `<form method="post" action="/bookings/${b.id}/cancel" class="inline"
                     onsubmit="return confirm('Cancel booking ${esc(b.code)}?')">
                     <button class="danger" type="submit">Cancel</button></form>`
                : ''
            }
            ${
              b.status === 'OPEN' && !external
                ? `<form method="post" action="/bookings/${b.id}/settle" class="inline"
                     onsubmit="return confirm('Settle ${esc(b.code)} now and create the debts?')">
                     <button class="secondary" type="submit">Settle</button></form>`
                : ''
            }
          </td>
        </tr>`;
      })
      .join('')}
  </table></div>`;
}

export function bookingsPage(groupId: number): string {
  return `
  <h1>Bookings</h1>
  <p class="sub">Everything the bot knows about, newest first.</p>
  <div class="card">${bookingTable(listAllBookings(groupId))}</div>`;
}

/* ------------------------------------------------------------------ */
/* Edit a booking                                                      */
/* ------------------------------------------------------------------ */

/** Splits a stored UTC instant into the date and time fields the form shows. */
export function localDateTimeFields(isoUtc: string, timezone: string): { date: string; time: string } {
  const local = DateTime.fromISO(isoUtc, { zone: 'utc' }).setZone(timezone);
  return { date: local.toFormat('yyyy-LL-dd'), time: local.toFormat('HH:mm') };
}

export function bookingEditPage(booking: Booking): string {
  const settings = getSettings();
  const { date, time } = localDateTimeFields(booking.starts_at, settings.timezone);
  const external = booking.kind === 'EXTERNAL';
  const roster = external ? null : getRoster(booking.id);
  const places = listPlaces(booking.group_id);

  const placeOptions = places
    .map(
      (p) =>
        `<option value="${p.id}"${p.id === booking.place_id ? ' selected' : ''}>${esc(p.name)}</option>`,
    )
    .join('');

  return `
  <h1>Edit booking ${esc(booking.code)}</h1>
  <p class="sub">
    ${esc(placeLabel(booking))} · currently ${esc(when(booking.starts_at))}
    ${
      roster
        ? ` · ${roster.confirmed.length} confirmed${roster.waitlist.length ? `, ${roster.waitlist.length} waiting` : ''}`
        : ` · on ${esc(booking.external_provider ?? 'an external platform')}`
    }
  </p>

  ${
    roster && roster.confirmed.length > 0
      ? `<div class="flash err">
           Changing the date or time announces the new schedule to the group, so the
           ${roster.confirmed.length} player(s) already in can react. Nobody is removed.
         </div>`
      : ''
  }

  <form method="post" action="/bookings/${booking.id}/edit">
    <div class="card">
      <h2 style="margin-top:0">Schedule</h2>
      <p class="muted" style="margin:0 0 4px">Times are in ${esc(settings.timezone)}.</p>
      <div class="row">
        <div>
          <label for="date">Date</label>
          <input type="date" id="date" name="date" value="${esc(date)}" required>
        </div>
        <div>
          <label for="time">Start time</label>
          <input type="time" id="time" name="time" value="${esc(time)}" required>
        </div>
        <div>
          <label for="durationMin">Length (minutes)</label>
          <input type="number" id="durationMin" name="durationMin"
                 value="${booking.duration_min}" min="15" max="480" required>
        </div>
      </div>
    </div>

    <div class="card">
      <h2 style="margin-top:0">Where</h2>
      <div class="row">
        <div>
          <label for="placeId">Place</label>
          <select id="placeId" name="placeId">
            <option value="">— free text below —</option>
            ${placeOptions}
          </select>
        </div>
        <div>
          <label for="customPlace">Or a one-off location</label>
          <input type="text" id="customPlace" name="customPlace"
                 value="${esc(booking.place_id ? '' : (booking.custom_place ?? ''))}"
                 placeholder="Only used when no place is selected">
        </div>
        <div>
          <label for="court">Court</label>
          <input type="text" id="court" name="court" value="${esc(booking.court ?? '')}">
        </div>
      </div>
    </div>

    ${
      external
        ? `<div class="card">
             <h2 style="margin-top:0">${esc(booking.external_provider ?? 'External')}</h2>
             <label for="externalUrl">Link</label>
             <input type="url" id="externalUrl" name="externalUrl" value="${esc(booking.external_url ?? '')}">
             <p class="muted" style="margin:8px 0 0">
               Cost and players are managed on ${esc(booking.external_provider ?? 'the platform')},
               so they are not editable here.
             </p>
           </div>`
        : `<div class="card">
             <h2 style="margin-top:0">Cost and players</h2>
             <div class="row">
               <div>
                 <label for="cost">Total cost (${esc(booking.currency)})</label>
                 <input type="text" id="cost" name="cost"
                        value="${(booking.total_cost_cents / 100).toFixed(2)}" required>
               </div>
               <div>
                 <label for="minPlayers">Minimum players
                   <span class="hint">Used for the per-player estimate</span>
                 </label>
                 <input type="number" id="minPlayers" name="minPlayers"
                        value="${booking.min_players}" min="1" max="50" required>
               </div>
               <div>
                 <label for="maxPlayers">Maximum players</label>
                 <input type="number" id="maxPlayers" name="maxPlayers"
                        value="${booking.max_players}" min="1" max="50" required>
               </div>
             </div>
             <label for="cancelLimitHours">Free cancellation limit (hours before start)</label>
             <input type="number" id="cancelLimitHours" name="cancelLimitHours"
                    value="${booking.cancel_limit_hours}" min="0" max="336" required>
           </div>`
    }

    <div class="card">
      <h2 style="margin-top:0">Notes</h2>
      <textarea name="notes" rows="3">${esc(booking.notes ?? '')}</textarea>
    </div>

    <div class="actions">
      <button type="submit">Save changes</button>
      <a class="btn secondary" href="/bookings">Cancel</a>
    </div>
  </form>`;
}

/* ------------------------------------------------------------------ */
/* Places                                                             */
/* ------------------------------------------------------------------ */

export function placesPage(groupId: number): string {
  const places = listPlaces(groupId, true);

  return `
  <h1>Places</h1>
  <p class="sub">The clubs your group plays at. Users pick these by name when booking.</p>

  <div class="card">
    ${
      places.length === 0
        ? '<div class="empty">No places yet — add your first club below.</div>'
        : `<div class="table-wrap"><table>
            <tr><th>Name</th><th>Address</th><th>Status</th><th></th></tr>
            ${places
              .map(
                (p: Place) => `<tr>
              <td>${esc(p.name)}</td>
              <td class="muted">${esc(p.address ?? '—')}</td>
              <td>${p.active ? '<span class="pill ok">Active</span>' : '<span class="pill">Hidden</span>'}</td>
              <td><form method="post" action="/places/${p.id}/delete" class="inline"
                    onsubmit="return confirm('Remove ${esc(p.name)}?')">
                    <button class="danger" type="submit">Remove</button></form></td>
            </tr>`,
              )
              .join('')}
          </table></div>`
    }
  </div>

  <h2>Add a place</h2>
  <div class="card">
    <form method="post" action="/places">
      <div class="row">
        <div>
          <label for="name">Name <span class="hint">What people type when booking</span></label>
          <input type="text" id="name" name="name" required placeholder="Padel Base">
        </div>
        <div>
          <label for="address">Address <span class="hint">Optional, used in calendar invites</span></label>
          <input type="text" id="address" name="address" placeholder="Musterstraße 1, Berlin">
        </div>
      </div>
      <div class="actions"><button type="submit">Add place</button></div>
    </form>
  </div>`;
}

/* ------------------------------------------------------------------ */
/* People                                                              */
/* ------------------------------------------------------------------ */

export function peoplePage(groupId: number): string {
  // This group's members only — People is scoped like every other page. Admin
  // status mirrors the WhatsApp group, so it is shown rather than toggled here.
  const members = listMembers(groupId)
    .map((m) => ({ member: m, user: findUserById(m.user_id) }))
    .filter((r): r is { member: typeof r.member; user: User } => r.user != null && !r.user.anonymised_at)
    .sort((a, b) => displayName(a.user).localeCompare(displayName(b.user)));

  return `
  <h1>People</h1>
  <p class="sub">
    Members of this group. Admins are mirrored from the WhatsApp group itself,
    so promote or demote someone there, not here. Payment details and erasure
    apply to the person across every group.
  </p>

  <div class="card">
    ${
      members.length === 0
        ? '<div class="empty">Nobody yet. People appear here once they message this group.</div>'
        : `<div class="table-wrap"><table>
            <tr><th>Name</th><th>Payment details</th><th>Admin</th><th></th></tr>
            ${members
              .map(
                ({ member, user: u }) => `<tr>
              <td>${esc(displayName(u))}</td>
              <td>
                <form method="post" action="/people/${u.id}/handle?g=${groupId}" class="inline" style="display:flex;gap:6px">
                  <input type="text" name="handle" value="${esc(u.payment_handle ?? '')}"
                         placeholder="paypal.me/… or IBAN" style="min-width:200px">
                  <button class="secondary" type="submit">Save</button>
                </form>
              </td>
              <td>${member.is_admin ? '<span class="pill ok">Admin</span>' : '<span class="muted">—</span>'}</td>
              <td>
                <form method="post" action="/people/${u.id}/forget?g=${groupId}" class="inline"
                      onsubmit="return confirm('Erase personal data for ${esc(displayName(u))}? This cannot be undone.')">
                  <button class="danger" type="submit">Erase</button>
                </form>
              </td>
            </tr>`,
              )
              .join('')}
          </table></div>`
    }
  </div>`;
}

/* ------------------------------------------------------------------ */
/* Money                                                               */
/* ------------------------------------------------------------------ */

export function moneyPage(groupId: number): string {
  const balances = overallBalances(groupId);
  const transfers = simplifyDebts(groupId);
  const ledger = listLedger(groupId, 60);

  return `
  <h1>Money</h1>
  <p class="sub">Net positions across the whole group. Everything is derived from the ledger below.</p>

  <h2>Balances</h2>
  <div class="card">
    ${
      balances.length === 0
        ? '<div class="empty">Everyone is square. 🎉</div>'
        : `<div class="table-wrap"><table>
            <tr><th>Person</th><th>Position</th></tr>
            ${balances
              .map(
                (b) => `<tr>
              <td>${esc(displayName(findUserById(b.userId)))}</td>
              <td>${
                b.netCents > 0
                  ? `<span class="pill ok">is owed ${esc(money(b.netCents))}</span>`
                  : `<span class="pill warn">owes ${esc(money(-b.netCents))}</span>`
              }</td>
            </tr>`,
              )
              .join('')}
          </table></div>`
    }
  </div>

  ${
    transfers.length > 0
      ? `<h2>Simplest way to settle up</h2>
         <div class="card"><div class="table-wrap"><table>
           <tr><th>From</th><th>To</th><th>Amount</th></tr>
           ${transfers
             .map(
               (tr) => `<tr>
             <td>${esc(displayName(findUserById(tr.fromUserId)))}</td>
             <td>${esc(displayName(findUserById(tr.toUserId)))}</td>
             <td>${esc(money(tr.cents))}</td></tr>`,
             )
             .join('')}
         </table></div>
         <p class="muted" style="margin:12px 0 0">
           These transfers clear every debt in the group with the fewest payments.
         </p></div>`
      : ''
  }

  <h2>Ledger</h2>
  <div class="card">
    ${
      ledger.length === 0
        ? '<div class="empty">No entries yet.</div>'
        : `<div class="table-wrap"><table>
            <tr><th>When</th><th>Type</th><th>From</th><th>To</th><th>Amount</th><th>Note</th></tr>
            ${ledger
              .map(
                (e) => `<tr>
              <td class="muted">${esc(when(e.created_at))}</td>
              <td><span class="pill">${esc(e.kind)}</span></td>
              <td>${esc(displayName(findUserById(e.from_user_id)))}</td>
              <td>${esc(displayName(findUserById(e.to_user_id)))}</td>
              <td>${esc(money(e.amount_cents, e.currency))}</td>
              <td class="muted">${esc(e.note ?? '')}</td>
            </tr>`,
              )
              .join('')}
          </table></div>`
    }
  </div>`;
}

/* ------------------------------------------------------------------ */
/* Reports                                                             */
/* ------------------------------------------------------------------ */

export function reportsPage(
  reports: { id: number; user_id: number; kind: string; body: string; status: string; created_at: string }[],
): string {
  return `
  <h1>Reports</h1>
  <p class="sub">Bugs and suggestions sent from WhatsApp.</p>
  <div class="card">
    ${
      reports.length === 0
        ? '<div class="empty">Nothing reported.</div>'
        : `<div class="table-wrap"><table>
            <tr><th>#</th><th>Type</th><th>From</th><th>What</th><th>When</th><th></th></tr>
            ${reports
              .map(
                (r) => `<tr>
              <td>${r.id}</td>
              <td><span class="pill">${esc(r.kind)}</span></td>
              <td>${esc(displayName(findUserById(r.user_id)))}</td>
              <td>${esc(r.body)}</td>
              <td class="muted">${esc(when(r.created_at))}</td>
              <td>${
                r.status === 'OPEN'
                  ? `<form method="post" action="/reports/${r.id}/close" class="inline">
                       <button class="secondary" type="submit">Close</button></form>`
                  : '<span class="pill">Closed</span>'
              }</td>
            </tr>`,
              )
              .join('')}
          </table></div>`
    }
  </div>`;
}

/* ------------------------------------------------------------------ */
/* Backups                                                             */
/* ------------------------------------------------------------------ */

function humanSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

export function backupsPage(files: BackupFile[]): string {
  const keep = getSettings().backupKeepDays;

  return `
  <h1>Backups</h1>
  <p class="sub">
    One snapshot of the database per day, taken automatically and pruned to the
    newest ${keep}. This is the only irreplaceable state the bot holds.
  </p>

  <div class="card">
    ${
      files.length === 0
        ? '<div class="empty">No snapshots yet. The first one is taken within a minute of starting up.</div>'
        : `<div class="table-wrap"><table>
            <tr><th>Snapshot</th><th>Size</th><th>Taken</th><th></th></tr>
            ${files
              .map(
                (f) => `<tr>
              <td class="mono">${esc(f.name)}</td>
              <td>${esc(humanSize(f.sizeBytes))}</td>
              <td class="muted">${esc(when(f.createdAt))}</td>
              <td><a class="btn secondary" href="/backups/${encodeURIComponent(f.name)}">Download</a></td>
            </tr>`,
              )
              .join('')}
          </table></div>`
    }
    <form method="post" action="/backups" style="margin-top:16px">
      <button type="submit">Take a snapshot now</button>
    </form>
  </div>

  <div class="card">
    <h2 style="margin-top:0">Restoring</h2>
    <p class="muted" style="margin:0">
      Stop the bot, replace <code>justplayit.db</code> in the data folder with a
      downloaded snapshot (renaming it), and start it again. WhatsApp device
      credentials are deliberately not included in snapshots — if you are moving
      to new hardware, simply link the device again by scanning the QR code.
    </p>
  </div>`;
}

/* ------------------------------------------------------------------ */
/* Groups                                                              */
/* ------------------------------------------------------------------ */

export function groupsPage(currentGroupId: number): string {
  const groups = listGroups(true);

  const row = (g: Group): string => {
    const members = listMembers(g.id).length;
    const sportOptions = SPORTS.map(
      (sp) => `<option value="${sp}"${sp === g.sport ? ' selected' : ''}>${esc(sp)}</option>`,
    ).join('');
    return `<tr>
      <td>${g.id === currentGroupId ? '➤ ' : ''}<a href="/?g=${g.id}">${esc(g.name ?? `Group ${g.id}`)}</a></td>
      <td class="mono" style="font-size:12px">${esc(g.wa_jid)}</td>
      <td>${members}</td>
      <td><span class="pill ${g.active ? 'ok' : ''}">${g.active ? 'Active' : 'Hidden'}</span></td>
      <td>
        <form method="post" action="/groups/${g.id}" class="inline" style="display:flex;gap:6px;align-items:center">
          <input type="text" name="name" value="${esc(g.name ?? '')}" placeholder="Name" style="width:150px">
          <select name="sport">${sportOptions}</select>
          <label style="font-weight:400;margin:0"><input type="checkbox" name="active" value="1"${g.active ? ' checked' : ''}>active</label>
          <button class="secondary" type="submit">Save</button>
        </form>
      </td>
    </tr>`;
  };

  return `
  <h1>Groups</h1>
  <p class="sub">
    Each group is its own world — its own bookings, places, members and balances.
    Nothing is shared between them. Pick one with the switcher up top to manage it.
  </p>

  <div class="card">
    ${
      groups.length === 0
        ? '<div class="empty">No groups yet. One is created automatically when the bot is added to a WhatsApp group.</div>'
        : `<div class="table-wrap"><table>
            <tr><th>Name</th><th>WhatsApp group</th><th>Members</th><th>Status</th><th>Edit</th></tr>
            ${groups.map(row).join('')}
          </table></div>`
    }
  </div>

  <div class="card">
    <h2 style="margin-top:0">About groups</h2>
    <p class="muted" style="margin:0">
      Groups register themselves: add the bot to a WhatsApp group and send one
      command, and it appears here. You cannot create an empty group from the
      console because a group only means anything once it is tied to a real
      WhatsApp chat. Rename, set the sport, or hide a finished group above.
      Hiding a group stops the bot responding there without deleting its history.
    </p>
  </div>`;
}

/* ------------------------------------------------------------------ */
/* Settings                                                            */
/* ------------------------------------------------------------------ */

const CONFIRMATION_MODES: [PaymentConfirmationMode, string][] = [
  ['receiver', 'Only the person who receives the money'],
  ['both', 'Either the sender or the receiver'],
  ['dual', 'Both of them — whoever records it, the other must approve'],
  ['anyone', 'Anyone in the group'],
];

function checkbox(name: string, checked: boolean, label: string, hint?: string): string {
  return `<label style="font-weight:400">
    <input type="checkbox" name="${name}" value="1"${checked ? ' checked' : ''}>
    <strong>${esc(label)}</strong>
    ${hint ? `<span class="hint" style="margin-left:24px">${esc(hint)}</span>` : ''}
  </label>`;
}

export function settingsPage(groupId: number): string {
  const s: Settings = getSettings(groupId);

  return `
  <h1>Settings</h1>
  <p class="sub">Everything the bot needs to run your group.</p>

  <form method="post" action="/settings">
    <div class="card">
      <h2 style="margin-top:0">General</h2>
      <p class="muted" style="margin:0 0 12px">
        The bot serves every WhatsApp group it is added to, and each one is its own
        space. Use the switcher at the top of the page to choose which group these
        settings apply to.
      </p>

      <div class="row">
        <div>
          <label for="commandPrefix">Command prefix</label>
          <input type="text" id="commandPrefix" name="commandPrefix" value="${esc(s.commandPrefix)}" maxlength="3" required>
        </div>
        <div>
          <label for="language">Language
            <span class="hint">Command words stay English in every language</span>
          </label>
          <select id="language" name="language">
            ${SUPPORTED_LANGUAGES.map(
              (l) => `<option value="${l}"${l === s.language ? ' selected' : ''}>${esc(LANGUAGE_NAMES[l])}</option>`,
            ).join('')}
          </select>
        </div>
      </div>

      <div class="row">
        <div>
          <label for="timezone">Timezone</label>
          <input type="text" id="timezone" name="timezone" value="${esc(s.timezone)}" required>
        </div>
        <div>
          <label for="currency">Currency</label>
          <input type="text" id="currency" name="currency" value="${esc(s.currency)}" maxlength="3" required>
        </div>
      </div>
    </div>

    <div class="card">
      <h2 style="margin-top:0">Bookings</h2>
      <div class="row">
        <div>
          <label for="defaultCancelLimitHours">Free cancellation limit (hours)
            <span class="hint">Leaving later than this still costs the player their share</span>
          </label>
          <input type="number" id="defaultCancelLimitHours" name="defaultCancelLimitHours"
                 value="${s.defaultCancelLimitHours}" min="0" max="336" required>
        </div>
        <div>
          <label for="defaultDurationMin">Default game length (minutes)</label>
          <input type="number" id="defaultDurationMin" name="defaultDurationMin"
                 value="${s.defaultDurationMin}" min="15" max="480" required>
        </div>
      </div>

      <div class="row">
        <div>
          <label for="defaultMinPlayers">Default minimum players</label>
          <input type="number" id="defaultMinPlayers" name="defaultMinPlayers"
                 value="${s.defaultMinPlayers}" min="1" max="50" required>
        </div>
        <div>
          <label for="defaultMaxPlayers">Default maximum players</label>
          <input type="number" id="defaultMaxPlayers" name="defaultMaxPlayers"
                 value="${s.defaultMaxPlayers}" min="1" max="50" required>
        </div>
      </div>

      <label for="reminderHoursBefore">Remind the group when a game is short of players
        <span class="hint">Hours before the game. Set to 0 to switch reminders off.</span>
      </label>
      <input type="number" id="reminderHoursBefore" name="reminderHoursBefore"
             value="${s.reminderHoursBefore}" min="0" max="336" required>

      <div style="margin-top:18px">
        ${checkbox(
          'allowPerBookingCancelLimit',
          s.allowPerBookingCancelLimit,
          'Let the booking creator set their own cancellation limit',
          'When off, every booking uses the default above.',
        )}
        ${checkbox(
          'allowCustomPlaces',
          s.allowCustomPlaces,
          'Allow free-text locations',
          'When off, users can only book at the places you listed.',
        )}
      </div>
    </div>

    <div class="card">
      <h2 style="margin-top:0">Payments</h2>
      <label for="paymentConfirmationMode">Who can confirm a payment</label>
      <select id="paymentConfirmationMode" name="paymentConfirmationMode">
        ${CONFIRMATION_MODES.map(
          ([value, label]) =>
            `<option value="${value}"${value === s.paymentConfirmationMode ? ' selected' : ''}>${esc(label)}</option>`,
        ).join('')}
      </select>
      <p class="muted" style="margin:8px 0 0">
        Anyone may record a payment. If they are not allowed to confirm it themselves,
        the other party gets a private message to approve or reject it. Under
        <em>Both of them</em> no single person can clear a debt alone, so every payment
        carries two people's word.
      </p>

      <label for="paymentDeadlineDays" style="margin-top:18px">Payment deadline (days after the game)</label>
      <input type="number" id="paymentDeadlineDays" name="paymentDeadlineDays"
             value="${s.paymentDeadlineDays}" min="1" max="90" required>

      <div style="margin-top:18px">
        ${checkbox(
          'requirePaymentProof',
          s.requirePaymentProof,
          'Require a screenshot or receipt with every payment confirmation',
        )}
      </div>
    </div>

    <div class="card">
      <h2 style="margin-top:0">Backups</h2>
      <label for="backupKeepDays">Daily snapshots to keep
        <span class="hint">
          The bot writes one database snapshot per day to the data folder and deletes
          older ones. Set to 0 to switch backups off.
        </span>
      </label>
      <input type="number" id="backupKeepDays" name="backupKeepDays"
             value="${s.backupKeepDays}" min="0" max="365" required>
      <p class="muted" style="margin:10px 0 0"><a href="/backups">View and download snapshots →</a></p>
    </div>

    <div class="card">
      <h2 style="margin-top:0">Privacy</h2>
      <label for="dataRetentionDays">Message-record retention (days)
        <span class="hint">
          The bot stores message IDs only to avoid acting twice on the same message.
          They are deleted after this many days. Message content is never stored.
        </span>
      </label>
      <input type="number" id="dataRetentionDays" name="dataRetentionDays"
             value="${s.dataRetentionDays}" min="1" max="3650" required>
    </div>

    <div class="actions">
      <button type="submit">Save settings</button>
      <a class="btn secondary" href="/settings">Discard</a>
    </div>
  </form>

  <p class="muted" style="margin-top:22px">
    Defaults: cancellation ${DEFAULT_SETTINGS.defaultCancelLimitHours}h,
    payment deadline ${DEFAULT_SETTINGS.paymentDeadlineDays} days.
  </p>`;
}

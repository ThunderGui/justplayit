# Handoff — multi-group / admins / providers / sport

Branch `feature/multi-group`. **Not deployed.** Production (Beelink,
10.0.0.37:8090) still runs `main` and is untouched.

State: 167 tests pass, `tsc` clean, migration verified against a copy of the
live database.

## 1. Multi-group — done at the domain layer

Migration 4 adds `groups` and `group_members`, moves `settings` to a
`(group_id, key)` primary key, and adds `group_id` to places, bookings,
ledger_entries, payment_claims, pending_actions, reports and payment_reminders.
An existing install is adopted as group 1, keeping all its data — verified
against a copy of production (7 users, 1 booking, 5 ledger entries, integrity ok).

Groups self-register: the bot joins a WhatsApp group, someone sends a command,
and that chat becomes a group with its own world. No console setup first.

**Balances are deliberately NOT netted across groups.** Owing someone in the
padel group has nothing to do with a tennis group, and silently offsetting them
would invent money movements nobody agreed to. `tests/group-isolation.test.ts`
pins this, plus places, settings, the group-wide view and reminders.

`group_id` had to be nullable (SQLite cannot add a NOT NULL column to a
populated table), which means a forgotten column in an INSERT fails *silently*.
That already happened once during this work — `createExternalBooking` wrote
unscoped rows and nothing caught it. The first test in
`tests/group-isolation.test.ts` is the standing net for that; keep it.

### Remaining
- Web console has a `?g=N` group selector but no UI to switch or create groups.
- `pickGroupFromMessage` in the dispatcher matches a DM to a group by name
  fragment; only lightly considered, no tests.
- `scheduled_jobs` and `processed_messages` are still global. Fine for dedupe,
  but `runAutoSettlement` / `runSettlementAnnouncements` / `runPaymentReminders`
  still read settings from group 1 instead of each booking's own group.
  **This matters before any second group goes live.**

## 2. Admins — partially done

`syncGroupAdmins` mirrors WhatsApp's own admin list onto `group_members`, called
from the dispatcher at most every 5 minutes. WhatsApp is the source of truth, so
there is no second list to maintain. A failed lookup returns an empty list and
is ignored rather than stripping every admin.

### Remaining
- `.help` should go to an admin **privately** with the admin command list, and
  stay in the group for everyone else. Not done.
- Full admin control over private message (the web console's functions by DM).
  Not started.

## 3. External platform sync — blocked, not started

Probed during this session:
- `api.playtomic.io` and `api.playtomic.com` **do not resolve**.
- `playtomic.io` now 308-redirects to `playtomic.com`; the app lives at
  `app.playtomic.io` → `app.playtomic.com`.
- Both are client-rendered Next.js; the shell HTML carries no `__NEXT_DATA__`
  and no match payload. Player names and open slots load after login.

So plain HTTP scraping cannot get roster/status. Realistic options, in order of
cost: Open Graph metadata only (title/venue, probably not players); a headless
browser plus a logged-in session (heavy, and a Chromium on the Beelink); or the
private mobile API with a captured token (fragile, likely ToS-breaking).

Schema is ready: `bookings.external_synced_at/_status/_players/_slots_total/
_slots_free/_sync_error` exist and are in `updateBooking`'s whitelist. Nothing
writes them yet. Needs a real Playtomic match URL to probe before building.

## 4. Sport / tennis — partially done

`groups.sport` (padel | tennis | squash | badminton | other) with per-sport
default roster sizes, applied in `getSettings` before stored values. Tennis
defaults to min 2 / max 4 so singles and doubles both work.

### Remaining
- `bookingTitle()` in `src/bot/render.ts` still hardcodes `Padel — <place>`.
  That string reaches calendar invites.
- No sport selector in the console; `.help` and the rules text say "padel".

## Running
    npm test            # 167 tests
    npm run typecheck
    npx vitest run tests/group-isolation.test.ts   # the isolation guarantees

## Deploying (only after review)
    git checkout main && git merge feature/multi-group
    ./deploy/deploy.sh thundergui@10.0.0.37     # no MIGRATE_DATA
Migration 4 runs on first boot. Take a backup first:
    rsync -az beelink:~/justplayit/data/backups/ ./backups/

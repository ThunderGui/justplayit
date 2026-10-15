export interface Migration {
  id: number;
  name: string;
  up: string;
}

export const MIGRATIONS: Migration[] = [
  {
    id: 1,
    name: 'initial_schema',
    up: `
    /* ---------------------------------------------------------------- */
    /* Settings: flat key/value so the admin UI can add knobs without a   */
    /* migration. Typed access lives in src/domain/settings.ts.           */
    /* ---------------------------------------------------------------- */
    CREATE TABLE settings (
      key         TEXT PRIMARY KEY,
      value       TEXT NOT NULL,
      updated_at  TEXT NOT NULL
    );

    /* ---------------------------------------------------------------- */
    /* Users                                                             */
    /* ---------------------------------------------------------------- */
    CREATE TABLE users (
      id              INTEGER PRIMARY KEY,
      wa_id           TEXT NOT NULL UNIQUE,   -- 4915...@s.whatsapp.net
      phone           TEXT,                   -- E.164, best effort
      display_name    TEXT,
      language        TEXT,                   -- NULL => fall back to group default
      is_admin        INTEGER NOT NULL DEFAULT 0,
      payment_handle  TEXT,                   -- "paypal.me/x" or IBAN hint
      created_at      TEXT NOT NULL,
      -- GDPR erasure: row is kept (ledger integrity) but identifiers are wiped.
      anonymised_at   TEXT
    );
    CREATE INDEX idx_users_phone ON users(phone);

    /* ---------------------------------------------------------------- */
    /* Places / clubs                                                    */
    /* ---------------------------------------------------------------- */
    CREATE TABLE places (
      id          INTEGER PRIMARY KEY,
      name        TEXT NOT NULL,
      address     TEXT,
      maps_url    TEXT,
      active      INTEGER NOT NULL DEFAULT 1,
      created_at  TEXT NOT NULL
    );
    CREATE UNIQUE INDEX idx_places_name ON places(name COLLATE NOCASE);

    /* ---------------------------------------------------------------- */
    /* Bookings                                                          */
    /* ---------------------------------------------------------------- */
    CREATE TABLE bookings (
      id                  INTEGER PRIMARY KEY,
      code                TEXT NOT NULL UNIQUE,      -- short, typable: "A7K2"
      -- MANAGED  = the bot runs the roster, the split and the debts.
      -- EXTERNAL = booked on Playtomic or similar. The bot only shows it on the
      --            calendar with its link; sign-ups and money live on that
      --            platform. It still reserves the time slot so the group does
      --            not double-book itself.
      kind                TEXT NOT NULL DEFAULT 'MANAGED',
      external_provider   TEXT,                      -- 'Playtomic', ...
      external_url        TEXT,
      creator_id          INTEGER NOT NULL REFERENCES users(id),
      payer_id            INTEGER NOT NULL REFERENCES users(id),
      place_id            INTEGER REFERENCES places(id),
      custom_place        TEXT,                      -- when free-text is allowed
      court               TEXT,
      starts_at           TEXT NOT NULL,             -- ISO-8601 UTC
      duration_min        INTEGER NOT NULL,
      total_cost_cents    INTEGER NOT NULL,
      currency            TEXT NOT NULL,
      min_players         INTEGER NOT NULL,
      max_players         INTEGER NOT NULL,
      cancel_limit_hours  INTEGER NOT NULL,
      notes               TEXT,
      status              TEXT NOT NULL,             -- OPEN | CANCELLED | SETTLED
      cancelled_at        TEXT,
      cancelled_by        INTEGER REFERENCES users(id),
      settled_at          TEXT,
      created_at          TEXT NOT NULL,
      CHECK (status IN ('OPEN','CANCELLED','SETTLED')),
      CHECK (kind IN ('MANAGED','EXTERNAL')),
      CHECK (min_players >= 1),
      CHECK (max_players >= min_players),
      CHECK (total_cost_cents >= 0),
      -- An external booking is meaningless without the link to manage it on.
      CHECK (kind <> 'EXTERNAL' OR external_url IS NOT NULL)
    );
    CREATE INDEX idx_bookings_starts_at ON bookings(starts_at);
    CREATE INDEX idx_bookings_status ON bookings(status);

    /* ---------------------------------------------------------------- */
    /* Participants (roster + waiting list in one table)                 */
    /* ---------------------------------------------------------------- */
    CREATE TABLE participants (
      id            INTEGER PRIMARY KEY,
      booking_id    INTEGER NOT NULL REFERENCES bookings(id) ON DELETE CASCADE,
      user_id       INTEGER NOT NULL REFERENCES users(id),
      status        TEXT NOT NULL,   -- CONFIRMED | WAITLIST | LEFT | LEFT_LATE
      joined_at     TEXT NOT NULL,
      left_at       TEXT,
      seq           INTEGER NOT NULL, -- join order; drives waiting-list promotion
      -- For LEFT_LATE only: 1 while the late canceller is still on the hook.
      -- Cleared when a replacement joins AND min_players is met (see rules).
      liable        INTEGER NOT NULL DEFAULT 0,
      replaced_by   INTEGER REFERENCES users(id),
      UNIQUE (booking_id, user_id),
      CHECK (status IN ('CONFIRMED','WAITLIST','LEFT','LEFT_LATE'))
    );
    CREATE INDEX idx_participants_booking ON participants(booking_id, status);

    /* ---------------------------------------------------------------- */
    /* Ledger: append-only. Balance is always derived, never stored.     */
    /* CHARGE  => from_user owes to_user                                 */
    /* PAYMENT => from_user paid to_user (reduces the debt)              */
    /* ---------------------------------------------------------------- */
    CREATE TABLE ledger_entries (
      id            INTEGER PRIMARY KEY,
      kind          TEXT NOT NULL,   -- CHARGE | PAYMENT | ADJUSTMENT
      booking_id    INTEGER REFERENCES bookings(id),
      from_user_id  INTEGER NOT NULL REFERENCES users(id),
      to_user_id    INTEGER NOT NULL REFERENCES users(id),
      amount_cents  INTEGER NOT NULL,
      currency      TEXT NOT NULL,
      note          TEXT,
      created_by    INTEGER REFERENCES users(id),
      created_at    TEXT NOT NULL,
      CHECK (kind IN ('CHARGE','PAYMENT','ADJUSTMENT')),
      CHECK (amount_cents > 0),
      CHECK (from_user_id <> to_user_id)
    );
    CREATE INDEX idx_ledger_pair ON ledger_entries(from_user_id, to_user_id);
    CREATE INDEX idx_ledger_booking ON ledger_entries(booking_id);

    /* ---------------------------------------------------------------- */
    /* Payment claims: the "confirm" workflow before it hits the ledger. */
    /* ---------------------------------------------------------------- */
    CREATE TABLE payment_claims (
      id              INTEGER PRIMARY KEY,
      code            TEXT NOT NULL UNIQUE,
      from_user_id    INTEGER NOT NULL REFERENCES users(id),
      to_user_id      INTEGER NOT NULL REFERENCES users(id),
      amount_cents    INTEGER NOT NULL,
      currency        TEXT NOT NULL,
      booking_id      INTEGER REFERENCES bookings(id),
      proof_path      TEXT,
      status          TEXT NOT NULL,  -- PENDING | APPROVED | REJECTED
      claimed_by      INTEGER NOT NULL REFERENCES users(id),
      resolved_by     INTEGER REFERENCES users(id),
      resolved_at     TEXT,
      ledger_entry_id INTEGER REFERENCES ledger_entries(id),
      created_at      TEXT NOT NULL,
      CHECK (status IN ('PENDING','APPROVED','REJECTED')),
      CHECK (amount_cents > 0)
    );
    CREATE INDEX idx_claims_status ON payment_claims(status);

    /* ---------------------------------------------------------------- */
    /* Multi-step interactions (late-leave second confirmation, wizard). */
    /* ---------------------------------------------------------------- */
    CREATE TABLE pending_actions (
      id          INTEGER PRIMARY KEY,
      user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      chat_id     TEXT NOT NULL,
      kind        TEXT NOT NULL,
      payload     TEXT NOT NULL,   -- JSON
      expires_at  TEXT NOT NULL,
      created_at  TEXT NOT NULL
    );
    CREATE INDEX idx_pending_user ON pending_actions(user_id, chat_id);

    /* ---------------------------------------------------------------- */
    /* Scheduled outbound work (reminders, payment deadlines, settle).   */
    /* ---------------------------------------------------------------- */
    CREATE TABLE scheduled_jobs (
      id           INTEGER PRIMARY KEY,
      kind         TEXT NOT NULL,
      booking_id   INTEGER REFERENCES bookings(id) ON DELETE CASCADE,
      due_at       TEXT NOT NULL,
      payload      TEXT,
      done_at      TEXT,
      attempts     INTEGER NOT NULL DEFAULT 0,
      last_error   TEXT,
      created_at   TEXT NOT NULL
    );
    CREATE INDEX idx_jobs_due ON scheduled_jobs(done_at, due_at);
    CREATE UNIQUE INDEX idx_jobs_unique ON scheduled_jobs(kind, booking_id)
      WHERE booking_id IS NOT NULL;

    /* ---------------------------------------------------------------- */
    /* Bug reports / suggestions                                         */
    /* ---------------------------------------------------------------- */
    CREATE TABLE reports (
      id          INTEGER PRIMARY KEY,
      user_id     INTEGER NOT NULL REFERENCES users(id),
      kind        TEXT NOT NULL,   -- BUG | IDEA
      body        TEXT NOT NULL,
      status      TEXT NOT NULL DEFAULT 'OPEN',
      created_at  TEXT NOT NULL
    );

    /* ---------------------------------------------------------------- */
    /* Idempotency: WhatsApp redelivers on reconnect.                    */
    /* ---------------------------------------------------------------- */
    CREATE TABLE processed_messages (
      wa_message_id TEXT PRIMARY KEY,
      processed_at  TEXT NOT NULL
    );
    CREATE INDEX idx_processed_at ON processed_messages(processed_at);
    `,
  },
  {
    id: 2,
    name: 'claim_approver',
    up: `
    /* Until now a pending claim was always approved by the receiver. With the
       'dual' confirmation mode either party can be the one who still has to
       sign off — if the receiver files the claim, the sender approves it — so
       the approver has to be recorded per claim rather than inferred. */
    ALTER TABLE payment_claims ADD COLUMN approver_user_id INTEGER REFERENCES users(id);

    /* Existing pending claims keep their old semantics. */
    UPDATE payment_claims SET approver_user_id = to_user_id WHERE approver_user_id IS NULL;

    CREATE INDEX idx_claims_approver ON payment_claims(approver_user_id, status);
    `,
  },
  {
    id: 3,
    name: 'payment_reminders',
    up: `
    /* Records each nudge a creditor sends a debtor, purely so the same person
       cannot be reminded again and again. Chasing people is the job this bot
       exists to take over, and a chase button with no limit is a harassment
       button. */
    CREATE TABLE payment_reminders (
      id            INTEGER PRIMARY KEY,
      from_user_id  INTEGER NOT NULL REFERENCES users(id),  -- who is owed
      to_user_id    INTEGER NOT NULL REFERENCES users(id),  -- who owes
      amount_cents  INTEGER NOT NULL,
      sent_at       TEXT NOT NULL,
      CHECK (from_user_id <> to_user_id)
    );
    CREATE INDEX idx_reminders_pair ON payment_reminders(from_user_id, to_user_id, sent_at);
    `,
  },

  {
    id: 4,
    name: 'multi_group',
    up: `
    /* ---------------------------------------------------------------- */
    /* Multi-group: one bot instance serving several independent groups. */
    /*                                                                   */
    /* Each group is its own world — its own settings, places, bookings,  */
    /* members and ledger. Balances in particular must NOT net across     */
    /* groups: owing a colleague €8 from the Tuesday padel group has      */
    /* nothing to do with a tennis group, and silently offsetting them    */
    /* would invent money movements nobody agreed to.                     */
    /* ---------------------------------------------------------------- */
    CREATE TABLE groups (
      id          INTEGER PRIMARY KEY,
      wa_jid      TEXT NOT NULL UNIQUE,   -- ...@g.us, the WhatsApp group
      name        TEXT,
      -- Only affects wording; all scheduling and money logic is identical.
      sport       TEXT NOT NULL DEFAULT 'padel',
      active      INTEGER NOT NULL DEFAULT 1,
      created_at  TEXT NOT NULL,
      CHECK (sport IN ('padel','tennis','squash','badminton','other'))
    );

    /* Membership is per group; identity (users) stays global, because one
       WhatsApp account is one person regardless of how many groups they
       are in. is_admin here is group-level, mirrored from WhatsApp's own
       group admins. users.is_admin remains the web-console superadmin. */
    CREATE TABLE group_members (
      group_id    INTEGER NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
      user_id     INTEGER NOT NULL REFERENCES users(id),
      is_admin    INTEGER NOT NULL DEFAULT 0,
      joined_at   TEXT NOT NULL,
      PRIMARY KEY (group_id, user_id)
    );
    CREATE INDEX idx_members_user ON group_members(user_id);

    /* Adopt whatever single group this install was already bound to, so an
       existing deployment keeps its data instead of starting over. */
    INSERT INTO groups (id, wa_jid, name, sport, active, created_at)
    SELECT 1,
           COALESCE((SELECT value FROM settings WHERE key = 'groupJid'), 'unconfigured'),
           'My group', 'padel', 1, datetime('now');

    /* ---- settings become per-group (primary key changes) ---- */
    CREATE TABLE settings_new (
      group_id    INTEGER NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
      key         TEXT NOT NULL,
      value       TEXT NOT NULL,
      updated_at  TEXT NOT NULL,
      PRIMARY KEY (group_id, key)
    );
    INSERT INTO settings_new (group_id, key, value, updated_at)
      SELECT 1, key, value, updated_at FROM settings;
    DROP TABLE settings;
    ALTER TABLE settings_new RENAME TO settings;

    /* ---- everything group-scoped gains group_id ---- */
    ALTER TABLE places          ADD COLUMN group_id INTEGER REFERENCES groups(id);
    ALTER TABLE bookings        ADD COLUMN group_id INTEGER REFERENCES groups(id);
    ALTER TABLE ledger_entries  ADD COLUMN group_id INTEGER REFERENCES groups(id);
    ALTER TABLE payment_claims  ADD COLUMN group_id INTEGER REFERENCES groups(id);
    ALTER TABLE pending_actions ADD COLUMN group_id INTEGER REFERENCES groups(id);
    ALTER TABLE reports         ADD COLUMN group_id INTEGER REFERENCES groups(id);
    ALTER TABLE payment_reminders ADD COLUMN group_id INTEGER REFERENCES groups(id);

    UPDATE places            SET group_id = 1 WHERE group_id IS NULL;
    UPDATE bookings          SET group_id = 1 WHERE group_id IS NULL;
    UPDATE ledger_entries    SET group_id = 1 WHERE group_id IS NULL;
    UPDATE payment_claims    SET group_id = 1 WHERE group_id IS NULL;
    UPDATE pending_actions   SET group_id = 1 WHERE group_id IS NULL;
    UPDATE reports           SET group_id = 1 WHERE group_id IS NULL;
    UPDATE payment_reminders SET group_id = 1 WHERE group_id IS NULL;

    /* Everyone the bot already knew belongs to that first group, carrying
       their admin flag over as a group admin. */
    INSERT OR IGNORE INTO group_members (group_id, user_id, is_admin, joined_at)
      SELECT 1, id, is_admin, created_at FROM users WHERE anonymised_at IS NULL;

    CREATE INDEX idx_places_group   ON places(group_id);
    CREATE INDEX idx_bookings_group ON bookings(group_id, status, starts_at);
    CREATE INDEX idx_ledger_group   ON ledger_entries(group_id, from_user_id, to_user_id);
    CREATE INDEX idx_claims_group   ON payment_claims(group_id, status);
    CREATE INDEX idx_reports_group  ON reports(group_id);

    /* A place name only has to be unique within its own group. */
    DROP INDEX IF EXISTS idx_places_name;
    CREATE UNIQUE INDEX idx_places_group_name ON places(group_id, name COLLATE NOCASE);

    /* Booking codes stay globally unique: users type them without naming a
       group, and the bot has to resolve one without ambiguity. */

    /* ---- external-platform sync state (Playtomic etc.) ---- */
    ALTER TABLE bookings ADD COLUMN external_synced_at TEXT;
    ALTER TABLE bookings ADD COLUMN external_status TEXT;
    ALTER TABLE bookings ADD COLUMN external_players TEXT;   -- JSON array of names
    ALTER TABLE bookings ADD COLUMN external_slots_total INTEGER;
    ALTER TABLE bookings ADD COLUMN external_slots_free INTEGER;
    ALTER TABLE bookings ADD COLUMN external_sync_error TEXT;
    `,
  },

  {
    id: 5,
    name: 'dm_group_selection',
    up: `
    /* Remembers which group an admin is acting on in a private chat, so a
       multi-group admin can pick one with ".use <group>" and then issue
       commands without naming the group every time. One row per person. */
    CREATE TABLE dm_group_selection (
      user_id    INTEGER PRIMARY KEY REFERENCES users(id),
      group_id   INTEGER NOT NULL REFERENCES groups(id),
      updated_at TEXT NOT NULL
    );
    `,
  },

  {
    id: 6,
    name: 'console_users',
    up: `
    /* Named logins for the web console. Each is a full admin (the env
       ADMIN_PASSWORD stays valid as the owner's break-glass login). Added so
       the console can be shared without handing out one shared password. */
    CREATE TABLE console_users (
      id            INTEGER PRIMARY KEY,
      username      TEXT NOT NULL UNIQUE COLLATE NOCASE,
      password_hash TEXT NOT NULL,
      created_at    TEXT NOT NULL
    );
    `,
  },
];

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
];

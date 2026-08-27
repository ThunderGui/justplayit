# Privacy & GDPR notes

The design requires this bot to follow GDPR/Datenschutz rules. This document
records what it stores, why, and how each obligation is met — both as a
reference for you as the operator, and as the basis for a privacy notice if the
bot is ever offered to other groups.

As the person running the bot for your group, **you are the data controller**.

## What is stored

| Data | Why | Where |
|---|---|---|
| WhatsApp ID (phone number) | To recognise who sent a command and to reply | `users.wa_id`, `users.phone` |
| Display name | So group messages read "Bob is in", not a phone number | `users.display_name` |
| Bookings you create or join | The core function | `bookings`, `participants` |
| Charges and payments | To calculate balances | `ledger_entries`, `payment_claims` |
| Payment proof images | Only when the admin makes proof mandatory | `data/media/` |
| Message IDs | Deduplication only — WhatsApp redelivers after a reconnect | `processed_messages` |
| Bug reports you send | To act on them | `reports` |

## What is **not** stored

- **Message content.** Commands are parsed in memory and discarded. Only the
  message *ID* is retained, and only to avoid acting on the same message twice.
- Group chatter the bot is not addressed in. Non-command messages are dropped
  immediately.
- Contacts, profile photos, read receipts, or anything about people who never
  interact with the bot.
- Media, unless a message is an explicit `!confirm` **and** the admin has turned
  on mandatory payment proof.

## Legal basis

- **Contract / legitimate interest** for bookings and balances: the group agreed
  to use the bot to organise games and settle costs.
- **Consent** for participation itself: nobody is added without sending a
  command.

## Data subject rights

| Right | How |
|---|---|
| Access | `!balance` and `!list` show a person's own data; the admin console shows the rest |
| Erasure | `!forgetme`, or **People → Erase** in the console |
| Rectification | Display names update automatically; the admin can edit the rest |
| Portability | The SQLite database is a single file and can be exported directly |

### How erasure works, and why the row survives

`!forgetme` **anonymises** rather than deletes: the WhatsApp ID, phone number,
display name and payment details are wiped, and the user row is retained only as
an opaque key so the ledger stays balanced.

This is deliberate. A debt is not only the debtor's personal data — it is also
the creditor's financial record. Hard-deleting a person mid-ledger would either
destroy someone else's record of money they are owed, or leave dangling
references. Anonymisation satisfies erasure of the personal data while
preserving the other party's legitimate interest.

Erasure is refused while the person still **owes** money, with an explanation.
Once settled, it goes through.

## Retention

- Message-deduplication records: deleted after `dataRetentionDays` (default 90),
  by a job that runs every minute.
- Pending confirmations: expire after 10 minutes.
- Bookings and ledger entries: kept, as they are the group's financial history.
  Delete the database file to remove everything.

## Security

- WhatsApp device credentials live in `data/wa-auth/`. **Anyone with these files
  can act as the bot's WhatsApp account.** The `data/` directory is
  git-ignored; keep backups of it encrypted.
- The admin console is password-protected with a signed, expiring session
  cookie. Set a strong `ADMIN_PASSWORD` and a fixed `SESSION_SECRET`.
- The console has no HTTPS of its own. Expose it beyond your LAN only behind a
  reverse proxy with TLS, and set `TRUST_PROXY=1` so the session cookie becomes
  Secure-only.
- Logs redact phone numbers, WhatsApp IDs and message bodies.
- Balances are only ever sent in a private chat, never to the group — a public
  list of who has not paid is exactly the awkwardness this bot exists to remove.

## Transfers outside the EU

The bot itself sends no data anywhere except WhatsApp (Meta), which the group is
already using. There are no analytics, no telemetry, and no third-party
services. The one outbound link generated is a Google Calendar template URL,
which is only opened if a user chooses to tap it.

# 🎾 Just Play It

A WhatsApp bot that runs a padel group: bookings, waiting lists, and — the part
that actually hurts — keeping track of who owes whom, without one person having
to chase everybody after every game.

It answers commands in your group chat. It never posts unprompted except for the
callouts the group needs (a spot opening up, a game about to be short of
players, the cost split after a game).

## What it does

**Bookings**
- `!book` — create a booking with cost, min/max players, place, date, time
- `!list` — everything coming up, with player counts
- `!join` / `!leave` — take or give up a spot
- Automatic waiting list: join a full game and you are queued; if someone drops
  out, the first in line is promoted and told about it
- Two games can never be booked for the same time
- `!playtomic` — record a booking made on Playtomic. It shows on the calendar
  with its link and reserves the slot, but sign-ups and payment stay on
  Playtomic (see [External bookings](#external-bookings))

**Money**
- The cost is split automatically once the game has been played
- `!balance` — always answered privately — nets debts in both directions, so if
  you owe someone €10 and they owe you €8, you see **one** line: you owe €2
- `!confirm <name>` — record that you paid someone, with the admin choosing who
  is allowed to confirm a payment
- Late cancellations follow the group's rule: leaving after the deadline still
  costs your share **unless** someone takes your spot *and* the group still
  reaches the minimum number of players

**Admin**
- A web console for every setting: language, places, cancellation limits,
  payment policy, deadlines
- Group balance overview with the shortest set of transfers that settles
  everyone up

Three languages: English, German, Portuguese. Command words stay English in all
of them, so there is one syntax to learn and document.

## Requirements

- Node.js **24 or newer** (the bot uses the built-in `node:sqlite` module), or
  Docker
- A spare phone number for the bot — it links to WhatsApp as a companion device

## Quick start

```bash
git clone <this repo>
cd justplayit
npm install

cp .env.example .env
# set ADMIN_PASSWORD in .env

npm run build
npm start
```

On the first run the terminal prints a QR code. On the phone that will *be* the
bot, open **WhatsApp → Settings → Linked devices → Link a device** and scan it.

Then:

1. Open the console at <http://localhost:8080> and sign in.
2. Add your clubs under **Places**.
3. Send `!help` in your padel group. The first person to send a command becomes
   the admin, and that group becomes *the* group — the bot ignores every other
   chat from then on.

### Docker (Raspberry Pi / HAOS)

```bash
cp .env.example .env      # set ADMIN_PASSWORD
docker compose up -d --build
docker compose logs -f    # the QR code appears here on first run
```

There is no native module in the dependency tree, so the image builds on arm64
without a compiler toolchain.

## Commands

| Command | What it does |
|---|---|
| `!list` | Upcoming games |
| `!show <id>` | Full details of one game |
| `!book` | New booking (multi-line, see below) |
| `!playtomic` | Record a Playtomic booking |
| `!cancel <id>` | Delete a booking (creator or admin) |
| `!join <id>` | Take a spot, or join the waiting list |
| `!leave <id>` | Give up your spot |
| `!balance` | Your balance — always answered privately |
| `!confirm <name> [amount]` | Record a payment you made |
| `!approve <id>` / `!reject <id>` | Resolve a payment claim sent to you |
| `!settle <id>` | Close a game and split the cost now (creator/admin) |
| `!report <text>` | Report a bug or suggest something |
| `!help` | The short version of this table |
| `!privacy` / `!forgetme` | What is stored; erase your data |

The design's original wording works too: `include booking` and
`exclude booking` are accepted aliases.

### Creating a booking

```
!book
place: Padel Base
date: 03/09
time: 19:00
cost: 40
max: 4
```

Optional: `min`, `court`, `notes`, `duration`, `cancel` (hours).

Dates accept `03/09`, `3.9.`, `2026-09-03`, `today`, `tomorrow`, `friday`
(and the German/Portuguese weekday names). Times accept `19:00`, `19h30`,
`7pm`, `1930`. Bare day/month dates roll forward, so `01/02` typed in August
means next February — never a date in the past.

### External bookings

When the court is booked through Playtomic, the money and the player list live
there, not here:

```
!playtomic
url: https://playtomic.io/...
date: 03/09
time: 19:00
```

The bot lists it on the calendar with the link and blocks that time slot against
double-booking, but keeps no roster, splits no cost, and never touches the
ledger for it.

## How the money works

Every charge and payment is an append-only ledger entry. Balances are always
derived, never stored, so they cannot drift out of sync.

Between any two people the entries are netted into a single number. The group
view goes further and collapses the whole debt graph into the fewest transfers
that settle everyone — a chain where A owes B and B owes C becomes "A pays C".

Cost splitting uses integer cents with the remainder distributed one cent at a
time, so €40 across three players is €13.34 / €13.33 / €13.33 and never loses a
cent.

## Configuration

Everything below is set in the web console, not in code:

- Language, timezone, currency, command prefix
- The WhatsApp group the bot listens to
- Places, and whether free-text locations are allowed
- Default cancellation limit, and whether creators may override it per booking
- Who may confirm a payment: the receiver only, either party, or anyone
- Whether payment proof is mandatory
- Payment deadline after a game (default 7 days)
- Retention window for message-deduplication records

## Development

```bash
npm run dev        # watch mode
npm test           # 71 tests
npm run typecheck
```

`WHATSAPP_ENABLED=0` boots the web console and database without connecting to
WhatsApp.

The test suite covers the rules that are expensive to get wrong: debt netting,
late-cancellation liability, cost splitting, double-booking, waiting-list
promotion, and the channel rules (balances private, callouts in the group).

## Privacy

See [docs/PRIVACY.md](docs/PRIVACY.md). In short: the bot stores phone numbers,
display names, bookings and balances — never message content. `!forgetme` erases
a person's identifiers while keeping the ledger intact, since a debt is also
somebody else's financial record.

## A note on the WhatsApp connection

This uses [Baileys](https://github.com/WhiskeySockets/Baileys), which speaks
WhatsApp's multi-device protocol directly. It is not an official Meta API — the
official Cloud API does not support group chats at all, so there is no
sanctioned way to build this. The bot's account is an ordinary WhatsApp account
and is subject to WhatsApp's terms; use a number you can afford to lose, and
keep the bot reactive (which it is: it only answers commands).

## Licence

Private project — all rights reserved.

# Deployment

Two supported targets, from the same source tree and the same `Dockerfile`:

1. **Docker on a laptop** — for the first tests.
2. **Home Assistant OS add-on** — the Raspberry Pi.

---

## 1. Docker on your notebook

```bash
cp .env.example .env
# set ADMIN_PASSWORD (and ideally SESSION_SECRET)

docker compose up -d --build
docker compose logs -f
```

The QR code for linking the WhatsApp device is printed to the logs on first
run — `tty: true` in `docker-compose.yml` is what lets it render.

The admin console is on <http://localhost:8080>.

State lives in the `justplayit-data` named volume. To inspect or back it up:

```bash
docker compose exec justplayit ls -la /data
docker compose cp justplayit:/data/backups ./backups   # pull snapshots out
```

To reset everything (including the WhatsApp link):

```bash
docker compose down -v
```

---

## 2. Home Assistant OS (Raspberry Pi)

### Why it is not just `docker compose`

HAOS is a locked appliance OS. It runs Docker underneath, but there is no
docker CLI available to you and no supported way to run a compose file. The
supported extension mechanism is the **add-on**, which is what the `config.yaml`
and `build.yaml` at the repository root make this project into.

### Installing as a local add-on

The repository root *is* the add-on directory, so it builds on the Pi from this
source. No container registry and no credentials are involved, which matters
while the GitHub repo is private.

1. Install the **Samba share** or **Advanced SSH & Web Terminal** add-on so you
   can reach the Pi's `/addons` folder.

2. Copy this whole repository into `/addons/justplayit/`:

   ```bash
   # from your laptop, over Samba
   cp -r justplayit /Volumes/addons/

   # or over SSH
   rsync -av --exclude node_modules --exclude dist --exclude data \
     ./justplayit/ root@homeassistant.local:/addons/justplayit/
   ```

3. In Home Assistant: **Settings → Add-ons → Add-on Store → ⋮ → Check for
   updates**. "Just Play It" appears under *Local add-ons*.

4. Open it, **Install** (the first build takes several minutes on a Pi), then go
   to the **Configuration** tab and set `admin_password`. Set `session_secret`
   too if you want admin logins to survive a restart.

5. **Start** it, then open the **Log** tab to scan the QR code.

6. The admin console is available via **Open Web UI**, or directly at
   `http://homeassistant.local:8080`.

### Where the data lives

Home Assistant gives the add-on a persistent `/data`, which is exactly where the
bot keeps its database, WhatsApp credentials and backups. It survives add-on
restarts and updates, and is included in Home Assistant's own snapshots — so the
bot's state is covered by your existing HA backup routine as well as by its own
daily snapshots.

### Updating

Copy the new source over `/addons/justplayit/`, bump `version` in `config.yaml`
(Home Assistant only offers an update when the version string changes), then
**Check for updates** and **Rebuild** in the add-on page.

---

## Linking WhatsApp without a phone

The bot links to WhatsApp as a *companion device*, so something has to hold the
primary account. That does not have to be a physical phone — it can be an
Android emulator running on a laptop or a small x86 box.

### The number

WhatsApp registration needs a number that can receive an **SMS or a voice call**,
once. Data-only travel eSIMs generally have no phone number at all, so nothing
can be delivered to them — check that the plan actually includes one before
building on it. After registration WhatsApp runs entirely over IP, so the SIM
does not need to stay in service, though keeping it is wise in case WhatsApp
ever asks you to re-verify.

### Linking by pairing code

An emulator has no camera, so it cannot scan the QR code the bot prints. Use the
pairing-code flow instead: set

```
WHATSAPP_PAIRING_NUMBER=4915112345678     # the bot's own number, digits only
```

(or `pairing_number` in the Home Assistant add-on options). On startup the bot
logs an eight-character code:

```
Pairing code: ABCD-EFGH — on the bot's WhatsApp, open
Linked devices → Link a device → Link with phone number instead, and enter it.
```

Type it into WhatsApp on the primary device. No camera, no QR.

### Practical notes

- The primary must come online at least every ~14 days, or WhatsApp drops all
  linked devices — and with them the bot's session.
- The emulator cannot run on the Pi (no KVM, not enough RAM). It would live on
  a laptop or a small always-on machine; the bot itself still runs on the Pi and
  connects independently.
- WhatsApp running on an emulator is a known ban signal. A cheap second-hand
  Android on WiFi in a drawer is less elegant and considerably more durable.

---

## Backups

The bot snapshots its own database once a day into `<data>/backups/`, keeping the
newest 14 (configurable under **Settings → Backups** in the console, where you
can also download them or take one on demand).

WhatsApp device credentials are deliberately **not** in the snapshots. Re-linking
is a thirty-second QR scan, whereas dated copies of live session credentials
sitting on the same disk are a liability. The ledger is the irreplaceable part,
and that is what gets backed up.

To restore: stop the bot, replace `justplayit.db` in the data directory with a
snapshot (renamed), start it again.

---

## Security notes

- The console speaks plain HTTP. Keep it on your LAN. If you must expose it,
  put it behind a reverse proxy with TLS and set `TRUST_PROXY=1` so the session
  cookie becomes `Secure`-only.
- `ADMIN_PASSWORD` is the only thing between a visitor and the group's financial
  data. Make it a real password.
- Never commit `data/` — it contains WhatsApp credentials that would let anyone
  send messages as the bot. It is git-ignored, but worth knowing why.

---

## Resource use

The container idles at roughly 80–120 MB RSS; `docker-compose.yml` caps it at
512 MB. There is no browser and no native module in the stack — Baileys talks to
WhatsApp over a WebSocket and SQLite is built into Node — which is what keeps it
comfortable alongside Home Assistant on a Pi.

---

## 3. An always-on Debian box (Beelink, NUC, mini-PC)

The simplest of the three: an ordinary machine with Docker, surviving reboots
and power cuts on its own.

### How it survives a power cut

Two things combine, and both are needed:

1. `restart: unless-stopped` in `docker-compose.yml` — Docker restores the
   container whenever its daemon starts.
2. `systemctl enable docker` — the daemon itself starts at boot.

`unless-stopped` rather than `always` is deliberate: a container you deliberately
stopped stays stopped across a reboot, instead of resurrecting itself.

### First deployment

From your laptop, once:

```bash
ssh-copy-id thundergui@10.0.0.64     # you type the password; key auth after this
```

Then:

```bash
MIGRATE_DATA=1 ./deploy/deploy.sh thundergui@10.0.0.64
```

The script installs Docker if missing, enables it at boot, syncs the source,
copies `data/` across, builds, starts, and waits for `/healthz`.

### Moving an existing bot without re-linking WhatsApp

`data/wa-auth/` holds the linked-device credentials. Copying it over means the
bot keeps its WhatsApp session and its ledger — no QR scan, no lost balances.

**Only one process may use those credentials at a time.** Two bots on the same
session fight over the socket and can invalidate the link. So:

```bash
# 1. stop the old instance FIRST
pkill -f "dist/index.js"          # or: docker compose down

# 2. then migrate
MIGRATE_DATA=1 ./deploy/deploy.sh thundergui@10.0.0.64
```

`MIGRATE_DATA=1` refuses to run if the target already has a database, so a
re-deploy can never silently overwrite live data.

### Re-deploying after a code change

```bash
./deploy/deploy.sh thundergui@10.0.0.64      # no MIGRATE_DATA
```

Source is synced and the image rebuilt; `data/` on the target is left alone.

### Everyday operations on the box

```bash
cd ~/justplayit
docker compose logs -f            # follow
docker compose ps                 # status
docker compose restart            # restart
docker compose down               # stop (stays stopped across reboots)
ls data/backups                   # daily database snapshots
```

### Getting backups off the machine

The daily snapshots live on the host, so a disk failure takes them with it.
From your laptop:

```bash
rsync -az thundergui@10.0.0.64:~/justplayit/data/backups/ ./backups/
```

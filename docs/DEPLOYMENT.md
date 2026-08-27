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

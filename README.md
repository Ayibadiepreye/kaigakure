# Kaigakure 霞がくれ

**Hidden mist.** Paste a social media link and it reveals every photo, video and audio track the
post carries — then downloads exactly what you select.

Runs on your own machine. It reaches what a signed-out visitor can see, and your own private
content once you sign in.

---

## Quick start (local)

```bash
npm install
npm run serve          # http://localhost:3000
```

Requires Python 3.11+ with the extractor packages, plus `ffmpeg`. On Windows the bundled
`.venv` is auto-detected; otherwise set `KAIGAKURE_PYTHON`.

```bash
# explicit, if auto-detect misses
export KAIGAKURE_PYTHON="/path/to/python"
export KAIGAKURE_FFMPEG="/path/to/ffmpeg"   # optional; auto-detected from hermes tools
```

**Tests:** `npm test` runs everything — 26 API/unit and 5 browser (31 total).

---

## What actually works — measured, not assumed

Every row below was probed against the live server with a real URL. Nothing here is guessed.

| Platform | Status | Notes |
|---|---|---|
| YouTube (video / Short / playlist) | ✅ | 37 renditions + 10 audio tracks |
| TikTok | ✅ | 10 renditions + audio |
| SoundCloud | ✅ | audio + variants |
| Telegram (channel `t.me/s/x`, post `t.me/x/123`) | ✅ | needs headless Chromium |
| VK video | ✅ | 8 renditions + audio |
| Twitch, Dailymotion | ✅ | |
| Imgur (album + direct image) | ✅ | |
| **Pinterest** (pin / board / search) | ✅ | anonymous API, original quality |
| **Instagram** (reels, posts) | ✅ | 12 renditions + audio, no login |
| **X / Twitter** (video posts) | ✅ | multiple videos per post, renditions + audio |
| Direct file (`.mp4`, `.jpg`, `.mp3`, …) | ✅ | fetched straight, no extractor |
| **Reddit** | 🔒 sign in | `Account authentication is required` |
| **Facebook** | 🔒 sign in | `Cannot parse data` without a session |
| **Vimeo** | 🔒 sign in | `The web client only works when logged-in` |
| **Bilibili** | 🔒 geo/region | |
| **Spotify** | ⛔ DRM | yt-dlp refuses by design — correct |

**A correction worth stating plainly.** An earlier version of this file claimed Instagram and
Pinterest "need cookies". That was wrong, and the cause was mine: I probed pin/reel IDs I had
made up, got `404 Pin not found`, and read a dead-ID error as a platform gate. Testing with real
IDs showed both work anonymously.

What actually made Pinterest work: its data API (`/resource/PinResource/get/` with
`field_set_key: unauth_react_main_pin`) is anonymous, but pinterest.com's edge rejects any
request whose TLS fingerprint is not a real browser. `server/lib/pinterest_api.py` fetches it
with `curl_cffi` impersonating Chrome — that is the only trick required, and it needs no account.

### A post with no media is not an error

Paste a text-only post and Kaigakure says *"Nothing to download here"* instead of throwing an
error. Real failures (a deleted video, a dead link) still report as errors.

---

## Signing in (for private posts)

Click **Sign in** and pick a site. A browser window opens on that site's own login page.
**You type your password there — Kaigakure never sees it.** It only reads the session cookie the
site sets afterwards, then closes the window.

Sessions are stored per-site in `data/accounts/` and merged into `data/cookies.txt`, which is
passed to the extractors as `--cookies`. Files are written mode `0600` on POSIX and never leave
the machine.

This is what makes **private posts** reachable: the site is happy because the request carries your
real session. What it does **not** do is bypass anything — a post that is private to you is
private to you, and signing in as you is the only way in. To sign out, use the **sign out** button
next to the site.

---

## Saving into a folder

After a download finishes, a **Choose download folder** button appears. Pick a folder once and
every later download (and ZIP) is written straight into it — no Save As dialog each time.

**Honest limitation:** browsers do not let a web page create a folder anywhere it likes. That is a
deliberate security boundary. What this does is ask you to pick the folder once, remember the
permission, and write into it thereafter. It works in Chrome and Edge (desktop and Android), and
Safari 18.2+. On any other browser the button simply does not appear and files go to your normal
Downloads folder — nothing breaks.

---

## Platform notes

**Telegram** has no yt-dlp or gallery-dl extractor at all. The per-post embed requires a session
token, but the channel view `t.me/s/<channel>` serves media without one, so that is what Kaigakure
reads. It needs headless Chromium (Playwright), which is why the Docker image is large.

**Pinterest** items expose every size the pin carries, including `orig` (original quality). Pick
the size per card.

**Direct files** (`.mp4`, `.jpg`, `.mp3`, …) are fetched straight over HTTP with no extractor, so
they resolve instantly.

---

## API

| Method | Path | Purpose |
|---|---|---|
| GET | `/api/health` | capability probe, cookie state |
| POST | `/api/probe` | `{url}` → every media item + renditions |
| POST | `/api/download` | `{url, selection[], options}` → starts a job |
| GET | `/api/jobs/:id` | poll status/progress/files |
| GET | `/api/jobs` | list jobs |
| GET | `/api/jobs/:id/zip` | bundle finished files |
| GET | `/api/jobs/:id/file/:name` | download one produced file |
| DELETE | `/api/jobs/:id` | remove a job and its files |
| GET | `/api/image?url=&source=` | image proxy (adds Referer + CORS) |
| POST | `/api/cookies` | `{cookies}` — stores a pasted cookies.txt |
| GET | `/api/accounts` | lists sites and their saved-session status |
| POST | `/api/login/:site` | opens a real browser login, harvests the session |
| DELETE | `/api/login/:site` | forgets a saved session |

---

## Deploying

### 1. Render (free tier works)

`render.yaml` is ready for the free plan. Either:

```bash
render blueprint launch     # CLI
```

or in the dashboard: **New + → Blueprint →** pick this repo.

**Free tier is genuinely fine here.** Render's free plan has no persistent disk, but it does have a
normal writable filesystem, and Kaigakure only needs scratch space — every file is streamed to
your browser the moment it is ready. Downloads, ZIPs and probing all work normally.

What you give up: on a restart or redeploy the container filesystem resets, so **saved sign-in
sessions are lost** and would need re-pasting. Downloaded files are unaffected — they were already
on your device.

> **Note:** the interactive **Sign in** flow opens a browser window on the *server*, so it cannot
> work on Render. Use the **Paste cookies manually** option instead: sign in on your own machine,
> export a `cookies.txt`, and paste it. Everything else — probing, downloading, ZIP, the folder
> feature — works normally.

**If you later want sessions and files to survive restarts**, upgrade to Starter (~$7/mo) and add
a disk back to `render.yaml`:

```yaml
    disk:
      name: kaigakure-data
      mountPath: /data
      sizeGB: 5
```
and set `KAIGAKURE_DATA=/data` in `envVars`. Disks bill at $0.25/GB/month, prorated.

#### Keeping it awake (optional)

A free service spins down after **15 minutes** of no inbound traffic, and the next request then waits
**about a minute** for the cold start. If that pause bothers you, ping it on a schedule.

The Hermes cron job `Kaigakure keepalive` (`fa7faa906ffe`) does this every 10 minutes:

```bash
bash ~/AppData/Local/hermes/scripts/kaigakure_keepalive.sh
```

It hits `/api/health` — the route that actually touches the running Node process, so a 200 means the
instance is genuinely warm, not just serving a cached page. It stays silent when everything is fine and
only reports a cold start or a failure.

Two things to know before relying on it:

- **The Hermes gateway must be running.** It is installed as a Windows login item, so it starts with
  your PC. Check with `hermes gateway status`.
- **It only runs while your PC is on.** This is a local cron, not a cloud one — if the machine is off,
  nothing pings the service. For a pinger that works regardless, use an external service pointed at
  `https://kaigakure.onrender.com/api/health` (UptimeRobot and cron-job.org both have free tiers).

**Worth knowing:** keeping a free service warm all month costs nothing extra in instance hours — Render
grants 750 free hours per workspace per month, which is 31 days, and a spun-down service consumes none.
So a 10-minute ping is genuinely free.

### 2. Docker anywhere (Fly, Railway, a VPS)

```bash
docker build -t kaigakure .
docker run -d -p 3000:3000 --name kaigakure kaigakure
```

Then open `http://<host>:3000`.

No volume is required — the image writes to `/app/data` inside the container, which is enough for
downloading and ZIPs. Add one only if you want files and sessions to survive a container rebuild:

```bash
docker run -d -p 3000:3000 \
  -v kaigakure-data:/data \
  -e KAIGAKURE_DATA=/data \
  --name kaigakure kaigakure
```

### 3. Run it yourself (VPS / home server)

```bash
# 1. Python deps
python3 -m venv .venv
.venv/bin/pip install -r requirements.txt

# 2. Node deps
npm install

# 3. Playwright's Chromium (Telegram needs it)
npx playwright install chromium

# 4. Serve
npm run serve
```

To survive reboots, run it under systemd or pm2. A minimal systemd unit:

```ini
[Unit]
Description=Kaigakure
After=network.target

[Service]
WorkingDirectory=/opt/kaigakure
ExecStart=/usr/bin/npm run serve
Restart=always
Environment=KAIGAKURE_DATA=/var/lib/kaigakure

[Install]
WantedBy=multi-user.target
```

### Exposing it beyond localhost

The server already binds `0.0.0.0`, so it is reachable from your LAN once the port is open.

- **Windows firewall (run as admin):**
  ```powershell
  netsh advfirewall firewall add rule name="Kaigakure 3000" dir=in action=allow protocol=TCP localport=3000
  ```
- **Your LAN IP:** `http://<your-LAN-IP>:3000`
- **Phone on the same Wi-Fi:** same URL.
- **Tailscale:** bind stays `0.0.0.0` and you get `http://<tailscale-name>:3000` from anywhere.
- **Public internet:** put it behind a reverse proxy with HTTPS (Caddy or nginx). Plain HTTP
  across the internet is not advisable — anyone who can reach the port can drive your downloads.

**Not Vercel / Netlify / Cloudflare Workers.** Serverless functions cap at 4.5 MB request bodies
and a ~250 MB bundle, and cannot ship a Python runtime with `yt-dlp`/`gallery-dl` or the `ffmpeg`
binary. Any deployment needs a real container or VM.

---

## Honest limits

- **Private content needs your own session.** Sign in through the **Sign in** panel; Kaigakure
  never sees your password, only the session cookie.
- **DRM-protected audio (Spotify, Apple Music) is not extractable.** yt-dlp refuses, and that is
  the correct behaviour — there is no legitimate way around it.
- **Rate limits apply.** Hammering a platform can get your IP throttled or blocked. Kaigakure does
  not retry aggressively or hide behind proxies.
- **Files are stored locally** in `data/`. They never leave the machine. If you deploy it, the
  `/data` volume is as exposed as the service itself.
- **Older posts rot.** X in particular returns `tombstone` for some older tweets; those are gone
  from the platform's side, not a Kaigakure bug.

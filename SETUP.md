# Bachat — Setup, start to finish

Everything here is free. No credit card is required at any step.

Work through the phases in order. Phases 1–3 are one-time account setup and are
the only parts nobody can do for you. Budget about an hour, most of it waiting
for downloads.

| Phase | What | Time |
| --- | --- | --- |
| 1 | Cloudflare — the API and the price database | ~15 min |
| 2 | Firebase — push notifications | ~15 min |
| 3 | GitHub — the scheduled price collectors | ~10 min |
| 4 | Build the APK | ~50 min, mostly unattended |
| 5 | First run on the phone | ~10 min |

---

## Phase 1 — Cloudflare (the backend)

The Worker serves the app's API; D1 is the SQLite database holding price
history. Free tier: 100k requests/day, 5 GB, 100k writes/day. We use a small
fraction of that.

1. Sign up at <https://dash.cloudflare.com/sign-up>. Email and password only —
   no card.

2. From the repo root:

   ```bash
   cd worker
   npm install
   npx wrangler login          # opens a browser, authorise it
   npx wrangler d1 create bachat
   ```

3. The last command prints a `database_id`. Paste it into `worker/wrangler.toml`
   where it says `database_id = ""`.

4. Create the tables, locally and remotely:

   ```bash
   npx wrangler d1 execute bachat --local  --file=./schema.sql
   npx wrangler d1 execute bachat --remote --file=./schema.sql
   ```

5. Set the shared secret the collectors use to write prices. Invent a long
   random string and keep it — GitHub needs the same value in Phase 3.

   ```bash
   npx wrangler secret put INGEST_KEY
   ```

6. Deploy:

   ```bash
   npx wrangler deploy
   ```

   It prints a URL like `https://bachat.<your-subdomain>.workers.dev`.
   **Write it down — every later phase needs it.** Check it works:

   ```bash
   curl https://bachat.<your-subdomain>.workers.dev/api/health
   ```
   You should get JSON. It will report everything as stale, with no products —
   correct, since nothing has been collected yet.

---

## Phase 2 — Firebase (notifications)

Without this, notifications cannot work at all. Everything else still would.

1. Go to <https://console.firebase.google.com> and create a project. Turn
   Google Analytics off — it is not needed and adds steps.

2. Add an **Android** app to the project. The package name must be exactly:

   ```
   ai.smartlearners.bachat
   ```

   Getting this wrong is the single most common failure here. It has to match
   `mobile/app.json` character for character.

3. Download `google-services.json` and put it at:

   ```
   mobile/google-services.json
   ```

   Then add this line to `mobile/app.json`, inside the `"android"` block:

   ```json
   "googleServicesFile": "./google-services.json"
   ```

4. Create a service account key so the collectors can send pushes:
   **Project settings → Service accounts → Generate new private key.**
   A JSON file downloads. Keep it safe and do not commit it — GitHub needs its
   contents in Phase 3.

5. Note your Firebase **project ID** (Project settings → General). Phase 3
   needs it.

---

## Phase 3 — GitHub (the collectors)

The collectors run as scheduled Actions. They poll retailers, write prices to
D1, and send notifications. This is what runs while your phone is asleep.

1. Create a repository and push:

   ```bash
   cd "D:\Personal Repositories\Bachat"
   gh repo create bachat --private --source=. --push
   ```

   A **private** repo gets 2000 free Action minutes a month; the sweeps use
   about 1400. A **public** repo gets unlimited minutes but makes your basket
   and pincode visible to everyone. Private is the right default.

2. Add these secrets — **Settings → Secrets and variables → Actions**:

   The names must match **exactly** — GitHub hands a workflow an empty string
   for a secret that does not exist, so a typo here looks like a working
   config right up until the sweep fails.

   | Secret | Value |
   | --- | --- |
   | `WORKER_BASE_URL` | the URL from Phase 1.6, scheme included, e.g. `https://bachat-worker.<acct>.workers.dev` |
   | `INGEST_KEY` | the same string you set in Phase 1.5 |
   | `FCM_SERVICE_ACCOUNT_JSON` | the **entire contents** of the JSON file from Phase 2.4 |
   | `FCM_DEVICE_TOKEN` | *optional.* A fallback used only until the app registers a device in Phase 5; leave it unset. |

   Your **location is not a secret** — you set it in the app during Phase 5 and
   it lives in the Worker's prefs, which the sweep reads at startup. That
   matters more than you would think: quick-commerce prices are set per dark
   store, so the same Blinkit category returns a different store and different
   prices from Gurugram than from Bengaluru. A sweep run before you finish
   onboarding has no location to work with.

3. **Register a self-hosted runner.** The sweeps are configured with
   `runs-on: self-hosted` and will queue forever without one.

   This is not optional and it is not a preference. Measured 2026-09-14 on a
   GitHub-hosted US runner: Blinkit answered **403 to every request and every
   retry**, and BigBasket and Myntra never ingested a row — while the same
   commit collects 1,700+ offers from a residential connection in India. Only
   Amazon works on a hosted runner. India-only retailers refuse them.

   **Settings → Actions → Runners → New self-hosted runner**, pick your OS,
   and follow the commands it shows you. On Windows that is roughly:

   ```powershell
   mkdir C:\actions-runner ; cd C:\actions-runner
   # download + extract the package the page links, then:
   ./config.cmd --url https://github.com/<you>/bachat --token <token from that page>
   ./run.cmd
   ```

   Run it as a service (`./svc.sh install` on Linux/macOS, or pass
   `--runasservice` to `config.cmd` from an **admin** shell on Windows) so it
   survives a reboot.

   **The machine needs Python 3.11+ on `PATH`.** The sweep workflows do not use
   `actions/setup-python`: it downloads an interpreter and then runs an
   unsigned `setup.ps1`, which a `RemoteSigned` PowerShell execution policy
   refuses. On a runner you own, using the machine's own Python is both faster
   and closer to what you tested against. Check with `python --version`.

   The trade: a sweep whose scheduled minute lands while the machine is asleep
   is skipped. That costs one sweep. A hosted runner cost you all of them.

4. Trigger a first run by hand rather than waiting for the schedule:
   **Actions → "Quick-commerce sweep" → Run workflow.**

5. Watch the log. Expect a per-retailer summary at the end. Some retailers
   failing is normal and by design — one blocked retailer must never cost you
   the others' data. If *every* retailer fails, check `WORKER_BASE_URL` and
   `INGEST_KEY` first. A run that stops before any retailer summary and says
   `sweep_misconfigured` is naming a secret it could not read.

5. Confirm the prices landed:

   ```bash
   curl "https://bachat.<your-subdomain>.workers.dev/api/health"
   ```

   `product_count` should now be in the hundreds.

---

## Phase 4 — Build the APK

One-time toolchain setup, then one command per build. Full detail in
[mobile/BUILD-APK.md](./mobile/BUILD-APK.md).

```powershell
cd "D:\Personal Repositories\Bachat\mobile"
npm install
powershell -ExecutionPolicy Bypass -File scripts\setup-toolchain.ps1
```

Point the app at your Worker by editing `mobile/.env`:

```
EXPO_PUBLIC_DEMO=0
EXPO_PUBLIC_API_URL=https://bachat.<your-subdomain>.workers.dev
```

Leaving `EXPO_PUBLIC_DEMO=1` builds an app running entirely on the bundled
fake catalog. That is genuinely useful — you can see every screen working
before any backend exists — but the prices are invented.

Then:

```powershell
npm run apk
```

**The first build takes around 50 minutes** — Gradle compiles native code for
four CPU architectures. Later builds take 3–5 minutes. The build fails loudly
if the APK ends up debug-signed, so a build that completes is a build you can
install.

Output: `mobile/build/Bachat-release.apk`. Copy it to your phone and install it
(you will need to allow installing from unknown sources).

> ### Back up your keystore now
>
> `mobile/credentials/` is gitignored and **irreplaceable**. It is what lets a
> future build install *over* this one. Lose it and the only path forward is
> uninstalling Bachat and losing its local data. Copy that folder somewhere
> outside the repo today.

---

## Phase 5 — First run

Onboarding walks through four steps. Do not skip the last one.

1. **Location** — your pincode. This selects which dark store's prices you see.
2. **Categories** — what you actually buy. These gate both the deal feed and
   which notifications reach you.
3. **Notifications** — grant permission.
4. **Battery optimisation** — the important one, see below.

### Why step 4 matters

Xiaomi/Redmi/Poco, Samsung, OnePlus, Oppo, Realme and Vivo all run battery
managers that kill background app processes and silently drop Firebase's wake
signal. Firebase reports the notification as *delivered* and your phone never
shows it.

**No code can fix this.** It is the phone's behaviour, not a bug in Bachat. The
onboarding step detects your manufacturer and opens the right settings screen —
usually "Autostart" and "Don't optimise battery usage" for Bachat. Grant both.

If notifications still never arrive, open **Settings → Delivery health** in the
app. It shows the last push the server *sent* against the last one your phone
*received*. "Sent, but never received here" means the battery manager is
eating them, and links straight back to the guide.

### What to expect on day one

The app knows only the price history it has collected. On day one that is one
sweep, so it will say **"Lowest in 1 day"** — which is honest and not very
useful. It becomes genuinely useful after about a week, and the full 30-day
claim only appears once 30 days of history actually exist.

Nothing in the app will ever claim a 30-day low it cannot prove. That rule is
enforced independently in the collector, the API and the app.

---

## When something breaks

Retailers change their markup every few months. When one does, its adapter
starts returning nothing while the others keep working — by design.

**How you will notice:** the app shows a stale-price warning for that retailer,
and `/api/health` reports it stale.

**How to fix it:** each adapter has a saved fixture of a real page under
`collectors/tests/fixtures/`. Refresh that fixture, run
`cd collectors && python -m pytest -q`, and the failing test points at the exact
parser that needs updating. The break is contained to one file.

### Known limits

- **Zepto and Swiggy Instamart are not included.** Both need a full headless
  browser to read, which does not fit the free Actions minute budget.
- **Ajio and Nykaa Fashion are not included.** Both return 403 from Akamai to
  any request we can make for free. Adding them needs rotating residential
  proxies, which cost money.
- **Amazon and Flipkart are intermittent.** Both wall requests unpredictably.
  The collectors pace themselves and fail soft, so a blocked sweep costs you
  that retailer's prices for a few hours, not the whole run.

Adding a retailer later is one new file implementing the same adapter
interface — see `collectors/adapters/base.py`.

## Phase 6 — Where the sweeps actually run

The sweep workflows are **manual-only** (`workflow_dispatch`). The schedule
lives on the collector machine instead, in Windows Task Scheduler:

| Task | Cadence |
| --- | --- |
| `Bachat quick sweep` | once daily, 07:17 |
| `Bachat fashion sweep` | once daily, 09:43 |

**Once a day is a quota decision, not a preference.** `ingest.ts` writes three
rows per offer (a `products` upsert, a `prices` insert and a `price_daily`
upsert), and a quick sweep collects ~4,200 offers -- about 12,650 row writes
per run. D1's free plan allows 100,000 row writes per day, so the original
4-hourly schedule spent ~76,000 of them on the quick sweep alone, before the
fashion sweep or anything the app reads. It exhausted the daily quota and
every endpoint began returning 500. Once a day for each mode costs ~16,000
writes, which leaves real headroom.

If you want more frequent sweeps, the lever is not the schedule: it is that
every sweep writes a `prices` row per product whether or not the price moved.
Skipping unchanged prices would cut roughly two thirds of the writes.

Both run `%USERPROFILE%\.bachat\run-sweep.ps1` as the logged-in user, with
`-StartWhenAvailable` so a run missed while the machine was off fires when it
comes back. Logs: `%USERPROFILE%\.bachat\logs\sweep-<mode>-<date>.log`, kept
14 days.

**Why not GitHub's schedule.** These jobs need `runs-on: self-hosted`, because
four of the five retailers refuse GitHub's hosted runners (section 9 of
`collectors/adapters/FASHION-NOTES.md` has the measurements). A scheduled run
with no runner registered does not fail — it queues indefinitely, which looks
exactly like nothing happening. Manual dispatch keeps the workflows usable the
moment a runner is online, without that failure mode.

**Why not a self-hosted runner as a service.** It can be, but on a machine
signed in with a Microsoft account the service needs
`MicrosoftAccount\<email>` plus the account password and the "Log on as a
service" right, and running it as `NETWORK SERVICE` instead cannot work: that
account has no ACL entry on a per-user Python install, so `python` is neither
on its `PATH` nor readable. The scheduled task sidesteps all of it.

**Credentials** live in `%USERPROFILE%\.bachat\`, deliberately outside the
repository. `WORKER_BASE_URL` and `INGEST_KEY` are set by `run-sweep.ps1`.
Nothing under the repo should ever hold the ingest key.

To run a sweep by hand:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File "$env:USERPROFILE\.bachat\run-sweep.ps1" -Mode quick
```

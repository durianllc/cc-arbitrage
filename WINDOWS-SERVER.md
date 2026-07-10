# Running the 24/7 monitor on a Windows Server

The monitor scrapes Collector Crypt every 15 minutes, adds any new graded slabs
into the Card Ladder collection **ARBALL**, and posts arbitrage deals to Discord
(routed by price: `< $200` → low webhook, `>= $200` → high webhook). It only
re-posts a card when its discount **%** actually changes.

## 1. Install prerequisites
- **Node.js LTS** — https://nodejs.org (check "Add to PATH")
- **Google Chrome** — https://google.com/chrome

## 2. Get the code
Download the repo (GitHub → **Code → Download ZIP**, or `git clone`), extract it,
then open **Command Prompt** in the folder and run:
```cmd
npm install
npm run install-browsers
```

## 3. Configure
Copy `settings.example.txt` to `settings.txt` and fill in:
```
DISCORD_WEBHOOK_LOW=...     (cards under $200)
DISCORD_WEBHOOK_HIGH=...    (cards $200 and up)
CL_EMAIL=...
CL_PASSWORD=...
```

## 4. Log in to Card Ladder (once, on the server)
Must be done **on the server itself** (RDP in) — Card Ladder's Cloudflare
clearance is tied to the IP that logs in.
```cmd
Login.cmd
```
Sign in, handle any 2FA, then close the browser window.

## 5. (Optional) seed data to skip a big first load
If you copy these from your Mac, the monitor won't have to re-learn everything:
- `cl-values.json`, `cl-notfound.json`, `posted-deals.json`
- the `browser-state-context\` folder (the logged-in session — then you can skip step 4)
- `cert-upload\exports\ARBALL-export.csv`

Without them it self-seeds on the first daily export.

## 6. Start the monitor (runs forever)
```cmd
Start Monitor.cmd
```
Leave the window open. It runs a cycle every 15 minutes. To stop, close the window.

## Keep it running across reboots
Use **Task Scheduler** → Create Task → Trigger "At startup" → Action: start
`Start Monitor.cmd`. Set it to run whether or not a user is logged on.

## Maintenance
- **"not logged in"** in the logs → RDP in and run `Login.cmd` again (the
  Cloudflare cookie expires periodically). Price-change detection keeps working
  in the meantime; only adding new certs pauses.
- Logs print each cycle: how many new certs, price changes, and deals posted.
- Tune with args, e.g. `node monitor-loop.mjs --threshold 0.75 --min-change 0.02`.

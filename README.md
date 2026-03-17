# POLY // EDGE — Automated Scanner

Automated Polymarket scanner that sends Telegram alerts for high-edge trading opportunities.
Runs every 30 minutes via GitHub Actions. Free. No server required.

---

## What It Detects

| Scanner | Signal | Threshold |
|---|---|---|
| Edge Scanner | Return potential ≥ 20% if correct | 20% |
| News Lag Detector | Volume spike vs liquidity (money rushing in) | Vol/Liq ≥ 3x |
| Correlation Detector | Same-category markets priced inconsistently | 20pt gap |

---

## Setup (10 minutes)

### Step 1 — Fork this repo
Click **Fork** on GitHub. Do not clone to local -- GitHub Actions runs it in the cloud.

---

### Step 2 — Create a Telegram Bot

1. Open Telegram, search for **@BotFather**
2. Send `/newbot`
3. Give it a name (e.g. `PolyEdge`) and a username (e.g. `polyedge_myname_bot`)
4. Copy the **Bot Token** it gives you (looks like `7123456789:AAF...`)

Then get your Chat ID:
1. Search for **@userinfobot** on Telegram
2. Send `/start`
3. Copy the **Id** number it shows you

---

### Step 3 — Add secrets to GitHub

In your forked repo:
1. Go to **Settings → Secrets and variables → Actions**
2. Click **New repository secret** and add:

| Secret name | Value |
|---|---|
| `TELEGRAM_BOT_TOKEN` | Your bot token from Step 2 |
| `TELEGRAM_CHAT_ID` | Your chat ID from Step 2 |

---

### Step 4 — Enable Actions

1. Go to the **Actions** tab in your repo
2. Click **I understand my workflows, go ahead and enable them**
3. Click **Poly Edge Scanner** → **Enable workflow**

---

### Step 5 — Test it

1. Go to **Actions → Poly Edge Scanner → Run workflow**
2. Check the **dry_run** box to test without Telegram messages
3. Uncheck to run live -- you should get a Telegram within 30 seconds

---

## How Alerts Look

```
🔥 EDGE ALERT — +43% if correct

Will GPT-5 launch before June 2026?

Direction: Bet YES @ $0.412
Return: +43.0% on correct call
Edge Score: 78/99
Liquidity: $88K
Volume: $430K
Days to resolve: 76

🔗 polymarket.com/event/gpt5-before-jun
```

```
⚡ NEWS LAG SIGNAL — 6.2x vol spike

Will Bitcoin exceed $100k before April 2026?

Vol / Liq ratio: 6.2x (threshold: 3x)
Current price: $0.780
Volume: $2.1M
Days to resolve: 15

⏱ Market may still be repricing. Act within 5-30 min window.
```

---

## Tuning the Scanner

Edit these constants at the top of `scanner.js`:

```js
const MIN_EDGE_RETURN_PCT   = 20;    // Lower = more alerts
const MIN_LIQUIDITY         = 15000; // Raise = only liquid markets
const VOL_LIQ_RATIO_THRESH  = 3.0;  // Lower = more news lag alerts
const MAX_DAYS_TO_RESOLVE   = 90;   // Raise = include longer-dated markets
const CORR_GAP_THRESH       = 20;   // Lower = more correlation alerts
```

---

## How Duplicate Alerts Are Prevented

`alerted.json` tracks every market that has already triggered an alert.
GitHub Actions commits it back to the repo after each run.
Entries older than 7 days are pruned automatically.

---

## Running Locally

```bash
npm install
node scanner.js --dry-run   # test, no Telegram
TELEGRAM_BOT_TOKEN=xxx TELEGRAM_CHAT_ID=yyy node scanner.js
```

---

## Important Disclaimer

This tool surfaces mathematical edge based on price and liquidity data.
It does not predict outcomes. Every bet is your own judgment call.
The 20% return is realised only if your assessment of the event is correct.
Never bet more than you can lose entirely.

# ZeroScroll

One calm daily ledger combining three zero-scrolling productivity tools, running 24/7 for free on GitHub Actions and GitHub Pages and delivering to both Gmail and Discord.

## What is included

1. **Morning Briefing** — Sent once every morning with live local weather (Open-Meteo, no key required), calendar events (`.ics` feed), upcoming tasks from your Brain Dump, fresh deduplicated headlines for your topics (such as OpenAI), and summarized Read-Later links.
2. **Brain Dump Inbox** — Drop quick natural-language thoughts like `submit lab report Friday 5pm #school`, `quiz tomorrow 9am`, or `idea: minimal status bar`. Automatically sorts into tasks, events, and notes, parses due timestamps, and sends hourly reminder alerts (24 hours before, 2 hours before, and at due time).
3. **Read-Later Digest** — Paste any article or YouTube URL (directly or inside Brain Dump). Extracts the content, creates a 3-bullet summary (using Gemini free-tier API if configured, or the built-in offline extractive summarizer), and bundles unread links into your morning briefing.
4. **Installable Web App (PWA)** — Works locally (`npm run dev`) or hosted free on GitHub Pages so you can capture tasks and links straight from your phone even when your laptop is off.

## 5-minute 24/7 free setup (GitHub Actions + Pages)

### 1. Add repository secrets

Open **Settings -> Secrets and variables -> Actions** in your GitHub repository and add the channels you want:

| Secret | Required? | How to get it |
| --- | --- | --- |
| `DISCORD_WEBHOOK_URL` (or `DISCORD`) | For Discord | Discord Server Settings -> Integrations -> Webhooks -> Copy Webhook URL |
| `GMAIL_USER` | For Gmail | Your Gmail address |
| `GMAIL_APP_PASSWORD` | For Gmail | Google Account -> Security -> 2-Step Verification -> [App passwords](https://myaccount.google.com/apppasswords) |
| `GMAIL_TO` | Optional | Recipient email (defaults to `GMAIL_USER`) |
| `GEMINI_API_KEY` | Optional | Free API key from [Google AI Studio](https://aistudio.google.com/apikey) for AI 3-bullet summaries (works offline without it) |
| `ICAL_URL` | Optional | Secret `.ics` address from Google Calendar or Apple Calendar |

### 2. Enable GitHub Pages (optional phone web app)

Open **Settings -> Pages**, set **Source** to **GitHub Actions**, and run the **Deploy Web App to GitHub Pages** workflow (or push a change).

Open your Pages URL on your phone and tap **Add to Home Screen**. To commit captures directly from your phone without opening GitHub:

1. Tap **Sync settings** inside the app.
2. Paste a fine-grained GitHub Personal Access Token scoped **only** to this repository with **Contents: Read and write**.
3. The token stays strictly in your own browser storage.

You can also capture from the official GitHub mobile app by opening a new Issue on this repo; the `Mobile Issue Capture` workflow parses your title/body into `data/inbox.json` or `data/readlater.json` and closes the issue automatically (owner-only).

### 3. Customize topics, city, and schedule

Edit [`config.json`](./config.json) to change:
- `timezone` (default `Asia/Manila`)
- `weather.city`, `latitude`, `longitude`, `unit`
- `news.topics` (Google News queries) and `news.feeds` (direct RSS/Atom feeds)
- `reminders.leadHours` (default `[24, 2]`)
- `delivery.gmail` / `delivery.discord` toggles

To adjust the morning delivery hour, edit the `cron` line in [`.github/workflows/morning-briefing.yml`](./.github/workflows/morning-briefing.yml) (times are in UTC).

## Local usage and CLI

```bash
npm install
cp .env.example .env
```

Run the local dashboard (reads and writes `data/*.json` directly):

```bash
npm run dev
# Open http://127.0.0.1:4310
```

CLI commands:

```bash
# Preview today's Morning Briefing without sending email/Discord
npm run brief:dry

# Build and deliver the Morning Briefing
npm run brief

# Capture a task, event, note, or URL
npm run dump -- "submit lab Friday 5pm #school"
npm run dump -- "https://openai.com/news/"

# Save and summarize a Read-Later link directly
npm run save -- "https://example.com/article" "read before class"

# Check and send upcoming reminders
npm run reminders:dry
npm run reminders

# Run automated tests
npm test
```

## License

[MIT](./LICENSE)

# Kara — Pilar's always-on chief of staff

A Telegram bot (@Karaeabot) whose brain is Claude (Opus 4.8) with tools to read and
write the Notion **Command Center**. It listens and replies 24/7, runs proactive
check-ins at **7am / 12pm / 3pm / 9pm ET**, and follows up on reminders
("did you do it?"). Deploys to a small always-on cloud host (Railway).

## What it does
- **Two-way chat:** text Kara anything — "add wedding gift task", "remind me to call the venue at 4", "plan my day", "what's on my plate". She uses Notion tools to act.
- **Heartbeat:** builds & sends your morning plan (and logs it to the Daily Plan DB), checks in midday/afternoon, runs an evening shutdown.
- **Reminders:** at a reminder's time she pings you and asks if it got done, then logs the result.

## The 3 secrets you provide (never commit them)
1. `TELEGRAM_BOT_TOKEN` — from @BotFather (already known for @Karaeabot).
2. `ANTHROPIC_API_KEY` — from https://console.anthropic.com → API Keys.
3. `NOTION_TOKEN` — a Notion **internal integration** token (below).

## One-time Notion setup (2 min)
1. Go to https://www.notion.so/my-integrations → **New integration** → internal → name it "Kara". Copy the token (`ntn_...`).
2. Open your **Command Center** page in Notion → top-right **•••** → **Connections** → add **Kara**. This shares the hub + all four databases (Goals, Tasks, Reminders, Daily Plan) with the bot.

Database IDs are already wired in `src/config.js`.

## Run locally (optional smoke test)
```bash
cd kara-bot
cp .env.example .env      # fill in ANTHROPIC_API_KEY and NOTION_TOKEN
npm install
npm start
```
Text @Karaeabot "what's on my plate" — she should answer from Notion.

## Deploy to Railway (always-on)
1. Push this folder to a GitHub repo (private).
2. On https://railway.app → **New Project → Deploy from GitHub repo** → pick it.
3. Railway auto-detects Node and runs `npm start`.
4. In the project's **Variables**, add: `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID`, `ANTHROPIC_API_KEY`, `NOTION_TOKEN`, `TZ=America/New_York`.
5. Deploy. Check the logs for "Kara is live." Text her to confirm.

> Note: uses Telegram long-polling, so no public URL/webhook needed. Only one instance should run at a time (Railway default). Conversation history is stored in `data/history.json`; for durable memory across redeploys, attach a Railway volume at `/app/data` (optional).

## Roadmap (next)
- Web/news tool (AI + finance brief), Google Calendar blocks, email triage, meeting recaps.

# auto-deploy verified 2026-08-07
15:56:52 auto-deploy live

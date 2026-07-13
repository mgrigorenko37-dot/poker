---
name: Poker Terminal Telegram delivery
description: How automatic decision push-to-Telegram is wired for the poker-advisor app (chat_id discovery, dedup)
---

Telegram bot token is a user-provided secret (`TELEGRAM_BOT_TOKEN`). The destination `chat_id` is
NOT a secret — it's discovered automatically via Telegram's `getUpdates` API after the user sends
`/start` to their bot, then persisted to a local JSON file on the api-server (not an env var, not
a DB table — the schema had no tables and adding one felt like overkill for one non-sensitive value).

**Why:** avoids a manual round trip asking the user to find/paste their numeric chat_id, and avoids
requiring a DB migration for a single config value in an app whose DB schema is otherwise empty.

**How to apply:** if extending this (e.g. multiple recipients, per-user config), migrate the local
JSON file to a real DB table at that point — the file approach only holds up for a single-user hobby
deployment.

Push messages are deduplicated by hashing `{holeCards, boardCards, displayText}` and only sending
when that key changes, since the screen-scan loop ticks every ~700ms and would otherwise spam
identical decisions repeatedly.

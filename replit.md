# Poker Terminal

A poker advisor web app that analyzes hands, shows preflop charts, tracks history, and can scan cards from screenshots using AI.

## Run & Operate

- Workflows: `API Server` (`artifacts/api-server`, port 8080) and `Poker Advisor` (`artifacts/poker-advisor`, port 20319) — both auto-start.
- `pnpm --filter @workspace/api-server run dev` — run the API server directly
- `pnpm --filter @workspace/poker-advisor run dev` — run the frontend directly (needs `PORT` and `BASE_PATH` env vars, see vite.config.ts)
- `pnpm run typecheck` — full typecheck across all packages
- `pnpm run build` — typecheck + build all packages
- `pnpm --filter @workspace/api-spec run codegen` — regenerate API hooks and Zod schemas from the OpenAPI spec
- `pnpm --filter @workspace/db run push` — push DB schema changes (dev only)
- Required env: `DATABASE_URL` — Postgres connection string (auto-provisioned)
- Required env: `OPENROUTER_API_KEY` — needed for the camera-based card scanner (`POST /api/scan-cards`, `CameraScan.tsx`), which calls `google/gemma-4-31b-it:free` via OpenRouter. Not yet set — this feature (photo of table → AI reads cards) is inactive without it. The screen-scan auto-pilot (`ScreenScan.tsx`) does NOT need this — it reads cards locally via Tesseract OCR.
- Required secret: `TELEGRAM_BOT_TOKEN` — set. Powers automatic push of fold/call/raise decisions to the user's Telegram while `ScreenScan` (🖥️ Экран tab) is running.
- Telegram chat_id is auto-discovered (not a secret) — user sends `/start` to their bot once, then clicks "привязать" in the app's Telegram card, which calls `POST /api/telegram/link` (Telegram `getUpdates`) and persists the chat_id to `artifacts/api-server/data/telegram-config.json`. Re-link if the bot is recreated with a new token.

## Stack

- pnpm workspaces, Node.js 24, TypeScript 5.9
- API: Express 5
- DB: PostgreSQL + Drizzle ORM
- Validation: Zod (`zod/v4`), `drizzle-zod`
- API codegen: Orval (from OpenAPI spec)
- Build: esbuild (CJS bundle)

## Where things live

_Populate as you build — short repo map plus pointers to the source-of-truth file for DB schema, API contracts, theme files, etc._

## Architecture decisions

_Populate as you build — non-obvious choices a reader couldn't infer from the code (3-5 bullets)._

## Product

Poker Terminal helps a player make faster in-hand decisions:
- **Analyzer** — manual hand input with Monte Carlo equity + GTO-based fold/call/raise/bet-sizing advice.
- **🖥️ Экран (ScreenScan)** — fully automatic: user shares their screen once, calibrates card positions once, then the app OCRs hole/board cards every scan tick, runs the same equity/GTO engine, and pushes the decision to (a) any connected phone via `📱 Эфир` (WebSocket) and (b) the user's Telegram, with dedup so it only messages when the recommended action changes.
- **Bluff read** — a heuristic (bet-sizing vs. pot, board texture, number of players, street) that labels a bet "вероятно блеф" / "похоже на вэлью" / "неопределённо". This reads betting patterns, not opponents' cards — always secondary to the equity/pot-odds math.
- **📷 Камера (CameraScan)** — one-shot photo analysis via AI vision (OpenRouter), inactive until `OPENROUTER_API_KEY` is set.
- **Preflop chart** and **History** tabs.

No system can guarantee winning every hand — poker has hidden information and variance. The goal here is decisions close to optimal (GTO + solid math), not certainty.

## User preferences

_Populate as you build — explicit user instructions worth remembering across sessions._

## Gotchas

_Populate as you build — sharp edges, "always run X before Y" rules._

## Pointers

- See the `pnpm-workspace` skill for workspace structure, TypeScript setup, and package details

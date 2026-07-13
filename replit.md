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
- Required env: `OPENROUTER_API_KEY` — needed for the screen/card scanner (`POST /api/scan-cards`), which calls `google/gemma-4-31b-it:free` via OpenRouter. Not yet set.

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

_Describe the high-level user-facing capabilities of this app once they exist._

## User preferences

_Populate as you build — explicit user instructions worth remembering across sessions._

## Gotchas

_Populate as you build — sharp edges, "always run X before Y" rules._

## Pointers

- See the `pnpm-workspace` skill for workspace structure, TypeScript setup, and package details

# stream-reduce on Cloudflare (multi-user, public)

A fully Cloudflare-native rewrite of stream-reduce: a public, multi-user app
where each account has its own library, subscriptions, comments, highlights, and
a personal knowledge graph. Content is **shared and deduped** globally — the
same video added by different people is processed once and appears in every
requester's library.

## Architecture

```
React SPA (Workers static assets)
        │
        ▼
Worker (Hono, TS)  ──►  D1            (users, items, user_item, subs, ...)
  • magic-link auth      Vectorize     (semantic search over chunk embeddings)
  • REST API             R2            (downloaded audio)
  • queue producer       Workers AI    (bge-m3 embeddings)
  • cron (poll/graph)    Email Service (magic-link sign-in)
        │
        ├── Queue ──► Worker queue consumer ──► PipelineContainer (DO)
        │                                              │
        │                                              ▼
        │                                  Python container (yt-dlp, ffmpeg)
        │                                   • metadata + native transcript
        │                                   • OpenRouter Whisper STT
        │                                   • Gemini-proxy summary
        │                                  returns transcript+summary+chunks JSON
        └── persists results, embeds chunks -> Vectorize, stores audio -> R2
```

- **Worker**: `cf/worker` (TypeScript + Hono). API + auth + serves the SPA +
  queue consumer + cron handler. Exports the `PipelineContainer` Durable Object.
- **Container**: `cf/pipeline` (Python + FastAPI). Reuses the repo's
  `app/adapters` for platform handling. Stateless: returns JSON the Worker
  persists.
- **Frontend**: the existing `frontend/` SPA. The global **Browse** view and
  item detail pages are public (no account needed); the per-user **Library**,
  Search, Graph, annotations, queue, subscriptions, and settings require a
  magic-link session.

## Prerequisites

- A **Workers Paid plan** (Containers, Queues, and Email Sending all require it).
- `wrangler` (installed via `npm install` here), Docker running locally (to
  build the container image on deploy).
- A domain on Cloudflare, onboarded in **Email Service → Email Sending** so
  magic-link mail delivers to any recipient (the `EMAIL_FROM` address must be on
  that onboarded domain). This deployment uses `noreply@xgoose.org`. Until a
  sending domain is onboarded, the `send_email` binding can only reach verified
  destination addresses, and an unonboarded/placeholder `EMAIL_FROM` makes
  `/api/auth/request` fail (the route now returns a clear 502 instead of a 500).

## One-time resource creation

```bash
cd cf/worker
npm install

# D1 — copy the returned database_id into wrangler.jsonc.
npx wrangler d1 create stream_reduce

# Vectorize — dimension must match the embedding model (bge-m3 = 1024).
npx wrangler vectorize create stream-reduce-chunks --dimensions=1024 --metric=cosine

# R2 bucket for audio.
npx wrangler r2 bucket create stream-reduce-media

# Queues (pipeline + dead-letter).
npx wrangler queues create stream-reduce-pipeline
npx wrangler queues create stream-reduce-pipeline-dlq
```

Then edit `wrangler.jsonc`:
- set `d1_databases[0].database_id` to the id from `d1 create`,
- set `vars.APP_ORIGIN` to your public origin (e.g. `https://stream-reduce.you.dev`),
- set `vars.EMAIL_FROM` to a verified address on your Email Service domain.

## Secrets

```bash
npx wrangler secret put GEMINI_API_KEY       # bearer for the Gemini summary proxy
npx wrangler secret put OPENROUTER_API_KEY   # OpenRouter Whisper key
```

## Migrate the database

```bash
npx wrangler d1 migrations apply stream_reduce --remote
```

## Deploy with GitHub Actions

Production deploys should go through the repository workflow:
`.github/workflows/deploy-cloudflare.yml`.

The workflow runs automatically on pushes to `main` that touch `cf/**`,
`frontend/**`, `app/**`, or the workflow file itself. It can also be started
manually from the GitHub Actions tab with `workflow_dispatch`.

The deploy job performs the full Cloudflare release sequence:

1. Build the React SPA in `frontend/` so the Worker can upload
   `frontend/dist` as static assets.
2. Install Worker dependencies in `cf/worker/`.
3. Apply remote D1 migrations with
   `wrangler d1 migrations apply stream_reduce --remote`.
4. Deploy the Worker, static assets, queues, cron triggers, Durable Object, and
   pipeline Container with `wrangler deploy`.

Required GitHub repository secrets:

- `CLOUDFLARE_API_TOKEN`
- `CLOUDFLARE_ACCOUNT_ID`
- `GEMINI_API_KEY`
- `OPENROUTER_API_KEY`
- `GEMINI_IMAGE_API_KEY`
- `ADMIN_TOKEN`

This is preferred over deploying from a laptop because the workflow provides a
consistent Node/Wrangler/Docker environment and avoids depending on local Docker
Desktop state.

## Manual deploy fallback

```bash
# From the repository root:

# 1. Build the frontend; the Worker serves ../../frontend/dist as static assets.
cd frontend && npm install && npm run build

# 2. Apply pending remote D1 migrations.
cd ../cf/worker
npx wrangler d1 migrations apply stream_reduce --remote

# 3. Deploy the Worker + Container.
# Docker must be running locally because Wrangler builds cf/pipeline/Dockerfile.
npx wrangler deploy
```

`wrangler deploy` builds `cf/pipeline/Dockerfile` from the repo root, pushes it
to the Cloudflare registry, provisions the `PipelineContainer` Durable Object,
and wires the queue + cron triggers.

## Local development

```bash
cd cf/worker
cp .dev.vars.example .dev.vars   # fill in secrets
npx wrangler d1 migrations apply stream_reduce --local
npx wrangler dev                 # serves the API + (built) SPA locally
```

Note: Containers run in local dev only if Docker is available; otherwise the
ingest pipeline calls will fail locally but the rest of the API works.

## How the core requirements map to the code

| Requirement | Where |
| --- | --- |
| Email-only magic-link accounts | `src/auth.ts`, `src/routes/auth.ts` (Email Service `EMAIL` binding) |
| Individual library / browse-all / add | `src/routes/items.ts` (`/api/items` global, `/api/items/library` personal) |
| Per-user comments + highlights | `src/routes/annotations.ts` (every row carries `user_id`) |
| Per-user knowledge graph | `src/routes/graph.ts` (filters the global graph by the user's `user_item`) |
| Shared channel catalog + per-user follows | `migrations/0010_channels.sql`, `src/lib/channels.ts`, `src/routes/channels.ts`; the legacy `subscription` row remains the per-user follow so folders, poll cursors, comments, and highlights keep their IDs |
| Follow = subscribe, two-month backfill by default | `src/lib/channels.ts` (`defaultWindowDays`, `vars.SUBSCRIPTION_WINDOW_DAYS = 60`), `src/pipeline/subscriptions.ts`. Every follow polls — there is no separate auto-update flag — and a poll skips anything shorter than `SUBSCRIPTION_MIN_DURATION_S`, looking the duration up at the source when the feed omits it |
| Metadata-first ingest | `src/pipeline/consumer.ts` (`fetchMetadata` before `runPipeline`) |
| Item → channel attribution | `src/lib/itemChannel.ts` (`attachItemChannel`): the single derivation used by manual adds, subscription polls and finished pipeline runs, so every item writes both `channel_item` and `item_feed`. A finished run re-attributes the item, which self-heals adds whose metadata prefetch failed |
| Prioritization (views + subscribers + requesters/interest) | `src/lib/priority.ts`, `src/lib/ingest.ts` (`recomputePriority`); subscriber demand uses the global `item_feed` link (`migrations/0002_item_feed.sql`) so manually-added videos still credit their channel's subscribers |
| Dedup (one item, many libraries, waiting/done) | `src/lib/ingest.ts` + `user_item` join in `migrations/0001_init.sql`; the per-user `waiting` badge surfaces in Browse/Library (`components/ItemCard.tsx`, `pages/Browse.tsx`) |
| Gemini summary endpoint | `vars.LLM_BASE_URL` + `GEMINI_API_KEY` (used in `cf/pipeline/llm.py`) |
| OpenRouter STT (unchanged) | `cf/pipeline/llm.py` `transcribe_chunk` |

Existing URL-keyed subscriptions are migrated after `0010_channels.sql` is
deployed. Admins first call
`POST /api/admin/migrate-channels?dry_run=true&limit=100&after_id=0`, then repeat
without `dry_run` using the returned cursor. The companion
`POST /api/admin/backfill-channel-items` route links historical `item_feed`
records to the shared catalog. Both operations are bounded and idempotent.

Items that never got a channel (added before `attachItemChannel`, or whose
metadata prefetch failed) are repaired with the routes in
`src/routes/adminChannelLink.ts`:

- `GET /api/admin/channel-link-audit` explains the gap: unchanneled items bucketed
  by platform and reason, plus poll health for every channel with no items (which
  separates "polling is broken" from "nothing new inside the window").
- `POST /api/admin/backfill-item-channels?phase=a` rebuilds channels from the
  item's existing `item_feed` rows and drops the malformed YouTube-template rows
  the pipeline used to write for non-YouTube platforms.
- `POST /api/admin/backfill-item-channels?phase=b&limit=25` goes back to each
  item's `source_url` for the rest. It needs the network (and the container's WARP
  egress for Bilibili), so it runs in small batches; `dry_run=true`, `limit` and
  `after_item_id` bound every call and re-running is idempotent.

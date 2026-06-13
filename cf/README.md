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
- **Frontend**: the existing `frontend/` SPA, now auth-gated with a Login page,
  a global **Browse** view, and a per-user **Library**.

## Prerequisites

- A **Workers Paid plan** (Containers, Queues, and Email Sending all require it).
- `wrangler` (installed via `npm install` here), Docker running locally (to
  build the container image on deploy).
- A domain on Cloudflare, onboarded in **Email Service** so magic-link mail
  delivers (the `EMAIL_FROM` address must be on that domain).

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
npx wrangler secret put SESSION_SECRET       # long random string
```

## Migrate the database

```bash
npx wrangler d1 migrations apply stream_reduce --remote
```

## Build the SPA + deploy

```bash
# 1. Build the frontend (the Worker serves ../../frontend/dist as static assets)
cd ../../frontend && npm install && npm run build

# 2. Deploy the Worker + Container (Docker must be running to build the image)
cd ../cf/worker && npx wrangler deploy
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
| Subscriptions, last-3-months default | `src/routes/subscriptions.ts` (`window_days = 90`), `src/pipeline/subscriptions.ts` |
| Metadata-first ingest | `src/pipeline/consumer.ts` (`fetchMetadata` before `runPipeline`) |
| Prioritization (views + subscribers + requesters) | `src/lib/priority.ts`, `src/lib/ingest.ts` (`recomputePriority`) |
| Dedup (one item, many libraries, waiting/done) | `src/lib/ingest.ts` + `user_item` join in `migrations/0001_init.sql` |
| Gemini summary endpoint | `vars.LLM_BASE_URL` + `GEMINI_API_KEY` (used in `cf/pipeline/llm.py`) |
| OpenRouter STT (unchanged) | `cf/pipeline/llm.py` `transcribe_chunk` |

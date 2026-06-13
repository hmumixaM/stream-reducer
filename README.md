# stream-reduce

**Website:** https://hmumixam.github.io/stream-reduce/

> **`dev` branch — public, multi-user, Cloudflare-native rewrite.** This branch
> adds a fully Cloudflare-hosted edition under [`cf/`](cf/README.md): a Worker
> (API + magic-link auth + SPA) backed by D1, Vectorize, R2, Queues, Cron, and a
> pipeline Container that reuses the Python `app/adapters`. Each account gets its
> own library, subscriptions, comments, highlights, and personal knowledge graph;
> content is shared and deduped globally. See [`cf/README.md`](cf/README.md) for
> the architecture and deploy steps. The original self-hosted NAS stack
> (Docker Compose + the static Cloudflare Pages mirror) documented below remains
> on `main`.

Self-hosted media summarizer. Turns videos and podcasts into source-traceable
summaries and keeps them in a searchable library.

- **Sources**: YouTube, Bilibili, Apple Podcasts, 小宇宙 (Xiaoyuzhou), and any
  RSS / RSSHub feed.
- **Playlists / collections / shows**: paste a YouTube `playlist?list=…`, a
  Bilibili 合集/系列 (`space.bilibili.com/<mid>/lists?sid=…`), an Apple Podcasts
  show (`podcasts.apple.com/.../id…`), or a Xiaoyuzhou podcast
  (`xiaoyuzhoufm.com/podcast/…`) URL to ingest every episode at once. They land
  in a shared folder in the Library. Apple shows expand to the full episode list
  (via the iTunes API); Xiaoyuzhou returns the most recent episodes embedded in
  the page. A bare `watch?v=…&list=…` or a single-episode URL stays a single
  item.
- **Pipeline**: native transcript first → OpenRouter Whisper transcription →
  Gemini summarization (Gemini models served by a LiteLLM proxy over its
  OpenAI-compatible API). Lossless, timestamp-cited summaries that link back to
  the source.
- **Semantic search**: every transcript and summary is chunked and embedded
  with `text-embedding-005` (via the same LiteLLM proxy) into a `sqlite-vec`
  index, so you can search by meaning and jump straight to the source passage —
  from the UI, the REST API, or an AI agent.
- **Knowledge graph**: every summary paragraph (overview, key points,
  walkthrough, …) becomes a node, and paragraphs are linked by the cosine
  similarity of their embeddings — an interactive, Obsidian-style graph (colored
  by Louvain community). Click a paragraph to read it and jump to connected
  paragraphs; each article page recommends related articles. Filterable in the
  live app and unified in the static mirror.
- **Subscriptions**: poll feeds on a schedule and auto-summarize new items.
- **MCP**: a minimal [Model Context Protocol](https://modelcontextprotocol.io)
  server is mounted at `/mcp` so AI agents can operate the app (add content,
  search the library, read summaries).
- **Queue + Stats**: live processing queue and a dashboard of time / requests /
  tokens / cost per stage.

Built with FastAPI + SQLite + Redis/RQ on the backend and React + Vite +
Tailwind on the frontend. Runs entirely on a NAS (no GPU required).

## Architecture

```
React SPA ──► FastAPI (REST + serves SPA) ──► SQLite
                  │                              ▲
                  ├── enqueue ──► Redis (RQ) ──► Worker
                  │                              │
                  └── APScheduler ──────────────┤  ├─ yt-dlp / iTunes API / RSS
                      (poll feeds,               │  ├─ OpenRouter Whisper (STT)
                       nightly graph)            │  ├─ Gemini via LiteLLM (summary)
                                                 │  ├─ text-embedding-005 (embed)
                                                 │  └─ graph build (link paragraphs)
                                                 ▼
                                       sqlite-vec index (semantic search)
                                       + paragraph knowledge graph
```

## Configuration

Copy `.env.example` to `.env` and fill in the keys:

```bash
cp .env.example .env
```

| Variable | Purpose |
| --- | --- |
| `LLM_BASE_URL` | LiteLLM proxy OpenAI-compatible endpoint, e.g. `https://nas.../v1` |
| `LLM_API_KEY` | LiteLLM virtual key (`sk-...`) |
| `LLM_MODEL` | default summary model, e.g. `gemini-3.5-flash` (overridable in Settings) |
| `OPENROUTER_API_KEY` | OpenRouter key (`sk-or-v1-...`) |
| `STT_MODEL` | default transcription model: `openai/whisper-large-v3-turbo`, `google/chirp-3`, `openai/gpt-4o-transcribe`, ... (overridable in Settings) |
| `TRANSCRIBE_RATE_LIMIT` | Max STT requests/minute (rate-limit guard) |
| `TRANSCRIBE_CHUNK_SECONDS` | Audio chunk length for timestamps |
| `ENABLE_EMBEDDINGS` | Toggle semantic-search embeddings (default `true`) |
| `EMBEDDING_MODEL` | Embedding model on the LiteLLM proxy (default `text-embedding-005`) |
| `EMBEDDING_BASE_URL` / `EMBEDDING_API_KEY` | Override embedding endpoint/key (blank = reuse `LLM_*`) |
| `EMBED_CHUNK_CHARS` / `EMBED_BATCH_SIZE` | Chunk size + request batch (kept small for low-RAM hosts) |

The OpenRouter key is also expected in your shell (`.zshrc`) as
`OPENROUTER_API_KEY` for local runs.

## Deploy (Docker)

`docker compose` pulls a prebuilt multi-arch image
(`maximumh/stream-reduce:latest`, linux/amd64 + linux/arm64) — no building on
the host (handy for a slow NAS). The repo is private, so log in first:

```bash
docker login                       # Docker Hub creds (one-time)
cp .env.example .env               # then edit secrets
docker compose pull                # fetch the prebuilt image
docker compose up -d
```

Open http://localhost:8010 (the published host port; set `WEB_PORT` in `.env`
to change it — the container always serves on 8000). Pin a specific image tag
with `SR_IMAGE=maximumh/stream-reduce:<sha>` in `.env` if you don't want
`:latest`.

### Building & publishing the image

CI builds and pushes the public multi-arch image automatically via
[`.github/workflows/docker.yml`](.github/workflows/docker.yml):

- push to `main` → `:latest`, `:main`, `:sha-<short>`
- push a tag `vX.Y.Z` → `:X.Y.Z`, `:X.Y`, `:latest`

One-time setup — add two repository secrets under **Settings → Secrets and
variables → Actions**:

| Secret | Value |
| --- | --- |
| `DOCKERHUB_USERNAME` | Docker Hub account that owns the image (e.g. `maximumh`) |
| `DOCKERHUB_TOKEN` | Docker Hub access token with read/write scope |

To build and push manually from a dev machine instead (not the NAS):

```bash
docker buildx build --builder multiarch \
  --platform linux/amd64,linux/arm64 \
  -t maximumh/stream-reduce:latest \
  -t maximumh/stream-reduce:"$(git rev-parse --short HEAD)" \
  --push .
```

Then on the NAS: `docker compose pull && docker compose up -d`.

Services: `web` (API + UI + scheduler), `worker` (pipeline jobs), `redis`.
To also run a local RSSHub instance:

```bash
docker compose --profile rsshub up -d
```

Data (SQLite DB + downloaded media) is stored in the `app-data` volume. The
downloaded audio for each item is **retained** under `/data/media` and shown on
the item page as a downloadable link, with a delete button to remove just that
file (useful for debugging a bad download — deleting it lets a single Retry
re-fetch a clean copy).
Bilibili / gated content: export your logged-in cookies in Netscape format
(e.g. with a "Get cookies.txt" browser extension while signed in to bilibili.com)
and drop the file into `./cookies/`. Any `*.txt` there is auto-detected — no env
var needed (you can still pin one explicitly via `YT_DLP_COOKIES_FILE`). Cookies
unlock gated/high-quality streams and reduce throttling. Downloads are also
hardened with chunked reads + retries to survive flaky Bilibili CDNs.

### Image size

The image is built in multiple stages (Node SPA build → `uv` deps → slim
runtime). The final image is based on `python:3.12-slim` and ships only the
venv, app code, the built SPA, and static `ffmpeg`/`ffprobe` binaries — no Node,
no apt, and no build toolchain. Result: ~660MB (vs ~1.2GB for a naive build with
the full apt `ffmpeg`).

## Public mirror (Cloudflare Pages)

A **read-only static mirror** of the library can be published to Cloudflare
Pages (free tier) to share summaries publicly — without exposing the NAS, any
write actions, or the settings / queue / stats internals.

The mirror reuses the same React SPA, built with `VITE_MIRROR=1`. In that mode
the app reads pre-exported JSON under `/data` instead of the live API, hides
every write/admin surface (add, settings, stats, queue, subscriptions, folder
editing, favorite, archive, comments), and replaces semantic search with an
in-browser keyword index ([`minisearch`](https://github.com/lucaong/minisearch))
— so there is no backend, database, or secret to host. The knowledge **Graph**
ships too as a unified `graph.json` (paragraph nodes + similarity edges; filters
are a live-only feature), and each item carries its related-article
recommendations inline.

```
NAS API (:8010 via SSH tunnel) ──► mirror/export.py ──► mirror/dist/data/*.json
                                                              │
            frontend (VITE_MIRROR=1 build) ──► mirror/dist ◄──┘
                                                              │
                                          wrangler pages deploy
                                                              ▼
                                   https://stream-reduce-mirror.pages.dev
```

One command syncs content and deploys (uses the local `CLOUDFLARE_ACCOUNT_ID` /
`CLOUDFLARE_API_TOKEN`, and `NAS_PASSWORD` for the SSH tunnel):

```bash
uv run python -m mirror.sync                 # tunnel -> build -> export -> deploy
uv run python -m mirror.sync --no-deploy     # dry run: build + export only
uv run python -m mirror.sync --base-url http://localhost:8010 --no-tunnel
```

Re-run it any time to refresh the public copy with the latest summaries.
Syncing + deploying is done locally from the laptop (it needs SSH access to the
NAS), so there is no CI/CD deploy for the mirror — just re-run the command above.

The landing site at <https://hmumixam.github.io/stream-reduce/> links to the mirror
and invites visitors to [open an issue](https://github.com/hmumixaM/stream-reduce/issues/new?template=summarize-request.yml)
to request that a video/podcast be summarized and added to the queue.

## Local development

Backend:

```bash
uv sync
uv run uvicorn app.main:app --reload      # API on :8000
uv run python -m worker.run               # worker (needs Redis running)
```

Frontend (proxies `/api` to :8000):

```bash
cd frontend && npm install && npm run dev  # UI on :5173
```

## Testing

```bash
uv run pytest                 # unit tests (no network)
uv run ruff check .           # lint
uv run ruff format .          # format
```

Live smoke tests (need real keys, run manually):

```bash
uv run python tests/scripts/test_llm.py          # LiteLLM Gemini connectivity
uv run python tests/scripts/test_transcribe.py   # OpenRouter Whisper round-trip
```

## MCP (AI agents)

A minimal MCP server is mounted on the web app at `/mcp` (Streamable HTTP), so
any MCP-capable agent (Cursor, Claude, etc.) can drive stream-reduce. Point the
client at `http://<host>:8010/mcp/`. Tools:

| Tool           | Purpose                                                            |
| -------------- | ----------------------------------------------------------------- |
| `add_content`    | Queue URLs (video, episode, playlist, or whole podcast show)       |
| `list_items`     | Filter the library by title / status / platform                    |
| `search_content` | Semantic search across all transcripts + summaries; returns the matching chunk text, a similarity score, and a deep-link/timestamp back to the source |
| `get_item`       | Read one item's summary (markdown + structured) and metadata       |

Example Cursor/Claude config:

```json
{ "mcpServers": { "stream-reduce": { "url": "http://localhost:8010/mcp/" } } }
```

It can also run as a local stdio server: `uv run python -m app.mcp_server`. Set
`ENABLE_MCP=false` to disable the mounted endpoint.

## Semantic search & embeddings

Each item's transcript and summary are split into small chunks (transcript
windows keep their `start/end` timestamps; summaries are split by field —
TL;DR, key points, quotes, outline, plus the rendered markdown). Every chunk is
embedded with `text-embedding-005` through the existing LiteLLM proxy and stored
in a `sqlite-vec` virtual table (`chunk_vec`) keyed to a `chunk` row that carries
the original text and its locator. Vectors are unit-normalized so the index's L2
distance ranks like cosine similarity.

This is **memory-light on a NAS**: the embedding model runs remotely (no local
model), only a small batch of vectors is ever in flight, and each 768-dim vector
is ~3 KB on disk. The genuinely heavy stages remain transcription/decoding.

- **Automatic**: a new `embed` pipeline stage runs after summarization (and on
  re-summarize), so new content is searchable without any extra step. It is
  idempotent — unchanged content is never re-embedded.
- **Backfill once** for content that predates this feature:

  ```bash
  uv run python -m app.pipeline.embed_backfill        # embed items missing chunks
  uv run python -m app.pipeline.embed_backfill --all  # force re-embed everything
  ```

- **Use it**: the **Search** page in the UI, `GET /api/search?q=...&k=...&source=transcript|summary&item_id=...`,
  or the `search_content` MCP tool. Results link back to the exact source span.

Everything is additive and backward compatible: the `chunk`/`chunk_vec` tables
are created automatically on startup, existing items/transcripts/summaries are
never modified, and only derived chunk rows are (re)written. Set
`ENABLE_EMBEDDINGS=false` to turn the feature off entirely.

## Knowledge graph of paragraphs

The summary embeddings power an **Obsidian-style graph of paragraphs**, built
with no new heavy dependencies (just `numpy` + `networkx`):

- **Nodes are summary paragraphs**, not keywords. Only the *main* summary fields
  count (`tldr` / overview, `key_point`, `walkthrough`, `outline`, `quote`,
  `background`); transcript chunks, raw markdown, danmaku, and single-word
  entities are excluded — so an article contributes ~10 meaningful nodes.
- **Edges are embedding similarity**: paragraphs are linked by the cosine
  similarity of their vectors (an exact kNN). Because the node set is small (only
  summary paragraphs), the build loads the vectors into a numpy matrix and
  computes the kNN in one pass — fast, and free of the "a paragraph's nearest
  neighbors are just its own transcript chunks" problem. **Louvain** communities
  (`networkx`) only color the nodes; summed cross-article edge weights give
  per-item related-article recommendations.
- **Derived tables** (`graphparagraph`, `graphlink`, `itemrecommendation`) are
  wiped + rewritten each build; the unfiltered graph is pre-serialized into a
  `graphcache` blob so the common read is **zero compute**. A chunk fingerprint
  lets an unchanged build exit early.
- **Schedule**: a nightly APScheduler job (`GRAPH_REBUILD_HOURS`) enqueues a
  rebuild on the existing worker/queue; `POST /api/graph/rebuild` triggers one
  manually. Run once for existing content with
  `uv run python -m app.pipeline.graph_build --force`.
- **Use it**: the **Graph** page (filter by favorite / archived / folder /
  platform; search to jump to a paragraph; click a node to read it + its
  connected paragraphs), the related-articles grid at the bottom of each item, or
  the REST API (`GET /api/graph`, `GET /api/items/{id}/related`). All of it works
  in the static mirror too (a unified `graph.json` + `related` embedded in each
  item).

Tunables live in `app/config.py` (`GRAPH_KNN_K`, `GRAPH_SIM_THRESHOLD`,
`GRAPH_LOUVAIN_RESOLUTION`, `GRAPH_MAX_CHUNKS`, …). Set `ENABLE_GRAPH=false` to
turn it off.

## How summarization stays source-traceable

Transcripts keep `{start, end, text}` segments. The summarizer runs a
map-reduce: each chunk is summarized losslessly with its `[HH:MM:SS]` markers,
then merged into a structured summary (TL;DR, timestamped outline, key points,
quotes, entities). Timestamps render as deep links for YouTube/Bilibili and as
`HH:MM:SS` references otherwise, so every claim traces back to the source.

The output language follows the source: Chinese-dominant transcripts are
summarized in 简体中文 (English proper nouns/terms preserved), everything else in
its own language. Downloads whose decodable audio is far shorter than the
expected duration (a common flaky-CDN truncation that still reports the full
length in the container header) are rejected so the item can be retried instead
of being summarized from only the first few minutes.

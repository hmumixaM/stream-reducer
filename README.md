# stream-reduce

Self-hosted media summarizer. Turns videos and podcasts into source-traceable
summaries and keeps them in a searchable library.

- **Sources**: YouTube, Bilibili, Apple Podcasts, 小宇宙 (Xiaoyuzhou), and any
  RSS / RSSHub feed.
- **Pipeline**: native transcript first → OpenRouter Whisper transcription →
  Gemini summarization (Gemini models served by a LiteLLM proxy over its
  OpenAI-compatible API). Lossless, timestamp-cited summaries that link back to
  the source.
- **Subscriptions**: poll feeds on a schedule and auto-summarize new items.
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
                  └── APScheduler (poll feeds)   ├─ yt-dlp / iTunes API / RSS
                                                 ├─ OpenRouter Whisper (STT)
                                                 └─ Gemini via LiteLLM (summary)
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

Build for both architectures and push from a dev machine (not the NAS):

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

Data (SQLite DB + downloaded media) is stored in the `app-data` volume.
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

## How summarization stays source-traceable

Transcripts keep `{start, end, text}` segments. The summarizer runs a
map-reduce: each chunk is summarized losslessly with its `[HH:MM:SS]` markers,
then merged into a structured summary (TL;DR, timestamped outline, key points,
quotes, entities). Timestamps render as deep links for YouTube/Bilibili and as
`HH:MM:SS` references otherwise, so every claim traces back to the source.

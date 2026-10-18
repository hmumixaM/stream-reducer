# Independent RSS reader

`/rss` is an authenticated article reader, with its own articles, bulletin and
sources views. It uses `rss_*` D1 tables, `rss/` R2 objects and the two-consumer
`stream-reduce-rss` queue. It does not add articles to media item tables, media
queues, global Browse, media Bulletin, search or knowledge graphs.

The reader accepts RSS/Atom, website feed discovery, full RSSHub URLs,
`rsshub://` routes, Folo feed/share URLs, and OPML. If direct resolution
fails (including RSSHub 403), public Folo catalog lookup can recover a cached
source using GET requests without subscribing the account. Multiple website feeds are
presented for selection. Follow categories, saved and read state are per user.
The Folo import is bound to `FOLO_OWNER_EMAIL` and only imports public feeds in
Articles (view 0). New follows exist exclusively in reducer; the integration
never calls Folo subscription creation or changes its read state. A free Folo
session can read entries of public feeds it does not follow, verified on
2026-10-18. Anonymous entry-list requests return 401. Do not assume every Folo
endpoint is available on a free account; denied readability requests fall back
to original web extraction. Authentication and membership restrictions are not
bypassed.

## Deployment

The main Cloudflare workflow applies `0028_rss_reader.sql`, builds the frontend,
and deploys the RSS container alongside the existing media container. Before
first deploy, create the queue:

```bash
cd cf/worker
npx wrangler queues create stream-reduce-rss
```

Configure `RSS_ENABLED`, `RSS_CONTAINER_GEN`, `RSSHUB_BASE_URL` and
`FOLO_OWNER_EMAIL` in Wrangler. Store the session only with
`wrangler secret put FOLO_TOKEN`; do not commit it or put it in frontend config.
For an authorized connection, `npm exec --yes --package=folocli -- folo login`
uses Folo's official browser callback. Transfer its token via stdin, not shell
arguments or logs. Existing secrets persist across deploys. Set a new token with
the same secret command if Folo reports 401. RSS and stored-body reading continue
without it. `POST /api/rss/import/folo` previews public subscriptions;
`{"execute":true}` imports them idempotently. OPML is the credential-free
alternative. The import endpoints never return authentication material.

## Durability and processing

Polling runs every 30 minutes (on the existing 15-minute scheduler), first reads
Folo if a matching cached feed ID is available, and falls back to the original
feed. A separate saved cursor backfills three calendar months, newest first. Folo
names its older-page cursor `publishedAfter`; `publishedBefore` returns newer
entries and must not be used for historical paging (verified against live data).
R2 discovery snapshots and DB links are persisted before advancing that cursor.
The history status `complete` requires reaching the time boundary; exhaustion,
feed-window limitations and stalled timestamp pagination are explicitly `gap`.
A source exposing 100 or more entries at an identical timestamp can stall the
upstream's date-only cursor; it is marked as a gap instead of silently skipping
those entries. Undated entries remain available without claiming dated coverage.

Bodies and HTML snapshots are saved before model requests. Plain-text PDF pages
are preserved, and explicit full-report PDF links are extracted. Scanned or
encrypted PDFs retain failures; no OCR, sign-in or paywall bypass is attempted.
Feed content fields are checked against description, truncation markers and
structure. Unknown bodies try Folo readability then original extraction.
Excerpts get an explicitly labelled bulletin only. No-body items remain listed.

Edition caches include body text and completeness, language and prompt version.
Unchanged content reuses editions; manual body retry and fuller feed updates can
upgrade excerpts. Long documents process every paragraph through persisted
section evidence (at most two new evidence calls per invocation), then synthesize
the two reading layers. Original-language and requested Chinese editions are
stored independently; a Chinese original is reused for the Chinese edition.
Opening a completed article in Chinese queues a missing edition from its saved
body. Verified same-host canonical URLs merge source links, URL aliases and
personal state without losing old article IDs. Briefs can have no explanation section; articles, reports
and digests are classified by information structure, not mandatory word counts.
Bulletins and concise explanations do not require or display paragraph references.
The article source link and saved full body (including PDF page headings) remain
available for tracing the source. Existing editions and saved section evidence
remain compatible and are reused on retry; legacy reference fields are ignored.

DB leases prevent duplicate work; abandoned jobs recover after lease expiry.
Failures back off and stop after four automatic article attempts. Manual retry
resets attempts; the admin can pause all RSS processing without disabling saved
reading. Backfill can be paused independently per source. Four container slots allow two old and two new instances during releases; idle
instances sleep after 30 seconds. Provisioning failures retry without spending
article attempts or source failure counts. Two queue consumers
select newest unprocessed articles before older history. Model calls and token
usage are recorded in `rss_llm_usage`; per-source provider, poll counts, success
counts, errors, authentication state and earliest available date remain visible
in DB/API. `/media/rss/*` is blocked: bodies are only served after verifying the
current user's follows through `/api/rss/articles/:id/body`.

## Validation

```bash
npm --prefix cf/worker run typecheck
npm --prefix cf/worker test
npm --prefix frontend run build
uv run --with-requirements cf/rss/requirements.txt --with pytest --with httpx \
  pytest cf/rss/test_service.py
```

Live checks must cover the deployed container, real imports, an article's saved
body and both generated layers, read/save persistence, anonymous denial, and
existing media reading. A queue submission or health response alone is not an
end-to-end success. Three-month history is an ongoing background job; report
persisted counts and gap states separately from completed generation.

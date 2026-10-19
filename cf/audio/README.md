# Oracle ARM audio preparation

Hosted media downloads stay in the Cloudflare `PipelineContainer` (`basic`).
`cf/pipeline/audio_offload.py` sends audio bytes to this service; only Oracle
performs full-file decoding, mono/16 kHz MP3 encoding and segmentation. Native
transcripts, OpenRouter STT, summaries and timestamps retain their existing path.
The legacy local application still uses `app/pipeline/audio.py`.

Production host: `opc@129.159.85.203`, deployment directory
`/var/oled/stream-reducer-audio`. Endpoint: `https://audio-arm.xgoose.org`.
The dedicated Cloudflare Tunnel is `stream-reducer-audio`, ID
`a77deceb-ee4f-4bb7-a097-d64b5258e658`. Its only published application routes to
`http://audio:8080` inside the isolated Docker network. No inbound public audio
port is needed. The audio container has no external network route.

Compose limits the entire audio service to two CPUs, 1 GiB RAM, 96 processes and
two concurrent encoders. It runs as UID 10001, with a read-only root filesystem,
all capabilities dropped, no-new-privileges, a bounded temporary filesystem and
rotated logs. It has no model, NAS, SSH or Cloudflare API credentials. ffmpeg and
ffprobe accept only file/pipe protocols; no caller-supplied URLs or shell commands.

Provision the host directory owned by its deploy user; `data/` must be owned by
UID/GID 10001. Copy this directory's tracked files to the deployment directory.
Keep `.env` and `tunnel.env` mode 0600, outside Git:

```dotenv
# .env: generate a random bearer value with at least 40 characters
AUDIO_OFFLOAD_TOKEN=<random secret>
```

```dotenv
# tunnel.env: token for this tunnel only, copied from the Cloudflare dashboard
TUNNEL_TOKEN=<tunnel connector token>
```

Install the same `AUDIO_OFFLOAD_TOKEN` as a Worker secret and a GitHub Actions
secret. Set Worker variable `AUDIO_OFFLOAD_URL` to the HTTPS endpoint. The
release workflow carries the secret to the Worker; the Container injects it into
Python. Do not put credentials in URLs, logs, config committed to Git or reports.

```bash
sudo docker compose build audio
sudo docker compose up -d
sudo docker compose ps
```

The protocol uses idempotent content-addressed jobs and 8 MiB upload parts. A
completed upload must match the declared SHA-256 before it is queued. Output
chunks have hashes, sizes and durations, and must cover the probed input duration.
The client verifies every chunk before using it. Input limit: 512 MiB / 12 hours;
ffmpeg timeout: 15 minutes per attempt, at most three processing attempts. At
most eight unfinished jobs and 256 retained jobs; disk reservations reject new
jobs with 503 before exhausting the data filesystem. Completed inputs are removed; hashed output chunks expire after 24 hours.
The encoders recover interrupted jobs after a service restart. Run a single
service replica against this directory; coordination is in-process plus durable
state files, not a distributed queue.

Oracle outages/timeouts are classified as temporary infrastructure failures by
the Worker. They requeue without spending the content retry budget. Invalid
media, authentication failures and exhausted encoding attempts remain explicit
errors. There is **no Cloudflare local encoding fallback**. Availability still
depends on the single Oracle host; restart/retry cannot guarantee zero failures.

Validated on 2026-10-18 with a real 12,120.27-second / 146,154,705-byte MP3:

| Test | Time | Result |
| --- | --- | --- |
| One encoder, one CPU | 43.54 s | 41 chunks; peak process RSS 56.25 MiB |
| One encoder, two CPUs | 43.39 s | No meaningful single-job speedup |
| Two simultaneous service jobs, two CPUs total | 52.3 s each, including output validation | Both complete on attempt 1; all 82 downloads match hashes |

The concurrent service test observed approximately 198 MiB container memory.
Both jobs cover 12,120.34 seconds including MP3 padding. These timings exclude
Internet transfer and model inference. Other formats and higher traffic can
behave differently.

Local validation:

```bash
uv run pytest tests/test_audio_offload.py tests/test_audio.py tests/test_cf_terminal_errors.py
npm --prefix cf/worker run typecheck
npm --prefix cf/worker test
```

Production smoke test: `POST /api/internal/audio-check` requires the audio token
in `x-audio-token` and accepts no caller-specified source. It downloads the fixed
3h22m public podcast in the deployed Cloudflare container, prepares all chunks
through Oracle HTTPS, verifies their hashes, and transcribes only the first
5-minute chunk with the configured STT model. It returns timings and text length,
without creating or modifying user items. One call incurs download/compute and
five minutes of STT usage; it is an operator diagnostic, not a public health probe.

# Oracle ARM audio offload acceptance — 2026-10-18

Implementation: `c5c077ee027b490e2ed27f862334343f3fcbb469`.
Release: https://github.com/hmumixaM/stream-reducer/actions/runs/39184369745
Worker version: `95ac6998-8ac6-4d42-a49d-639744223409`.

The hosted pipeline now uses Oracle for strict full-file decoding, mono 16 kHz
MP3 transcoding and five-minute segmentation. The Cloudflare media container uses
`basic`; no Oracle error falls back to local encoding. See
[operations and security](../cf/audio/README.md).

## Runtime configuration verified after rollout

- Cloudflare application `stream-reduce-pipelinecontainer`, application version
  198: image tag `95ac6998`, 0.25 vCPU, 1 GiB memory, 4 GB disk.
- Rollout `7e2e4397-b00d-443b-b7fa-d8013d7a454b`: completed, nine healthy target
  instances, no rollout errors. Workflow success preceded completion of the
  gradual rollout; acceptance waited for the actual target instances.
- Oracle `129.159.85.203`: audio service healthy, two CPU cap, 1 GiB RAM cap,
  two concurrent encoders, UID/GID 10001, read-only root, capabilities dropped,
  no-new-privileges, isolated Docker network. Internet connection attempts from
  the audio container fail. The dedicated tunnel is healthy.

## Measurements

Input: real public podcast, 12,120.27 seconds (3h22m), 146,154,705 bytes.

| Test | Observed result |
| --- | --- |
| Single encoder / one CPU | 43.54 seconds; 56.25 MiB peak process RSS |
| Single encoder / two CPUs | 43.39 seconds; no meaningful single-job improvement |
| Two simultaneous service jobs / two CPUs total | 52.3 seconds per job including validation; approximately 198 MiB container memory |
| Concurrent output validation | 41 chunks per job; all 82 downloaded chunks match declared sizes and SHA-256 hashes; output coverage 12,120.34 seconds including MP3 padding |
| HTTPS client upload and download | 65-second generated audio -> three chunks, 3.42 seconds |
| Restart | Completed job manifests and chunks remain available |
| Expiry | Only the two completed benchmark jobs were expired; service removed them and API returned 404 before the fresh production test |

Production smoke test `POST /api/internal/audio-check` succeeded with HTTP 200
from the real deployed `basic` container. This was a fresh encode after expiring
benchmark results, not a cached preparation result:

- Download: 9.10 seconds.
- Oracle upload, full encoding/validation, and verified chunk download: 58.01 seconds.
- Output: 41 chunks.
- First five-minute chunk STT: 1,621 text characters; measured provider cost
  $0.00099884682. No full-episode STT rerun.
- Diagnostic work total: 69.07 seconds; client wall time including container
  startup and Worker routing: 77.55 seconds.
- No D1 items, user libraries or existing transcripts were modified by this test.
- Anonymous diagnostic calls and anonymous Oracle requests return 401.
- LiteLLM liveness during Oracle encoding: HTTP 200 in 0.0131 seconds. This
  verifies liveness, not a model-generation latency benchmark.

## Validation and limits

Release CI passed frontend build, Worker typecheck, 234 Worker tests (four
external tests skipped), 54 RSS tests, six audio service/client tests, and D1
migration checks. Local relevant Python suite: 29 passed. Python lint passed.

The service retains output jobs for 24 hours, deletes completed inputs, checks
available disk before admission, bounds upload size/duration and process time,
retries processing up to three times, and recovers interrupted jobs on restart.
Transient Oracle availability failures requeue without consuming content retry
budget. Invalid media, bad credentials and exhausted processing retries stay
visible as errors; this is not a guarantee that the Oracle host can never fail.
A single MP3 benchmark does not establish performance for every codec or load.

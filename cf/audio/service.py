"""Authenticated, durable, single-encoder audio service. No model credentials or URL fetching."""

from __future__ import annotations

import hashlib
import hmac
import json
import math
import os
import re
import shutil
import subprocess
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

PART_BYTES = 8 * 1024 * 1024
MAX_BYTES = 512 * 1024 * 1024
MAX_DURATION = 12 * 3600
TTL = 24 * 3600
ROOT = Path(os.environ.get("AUDIO_DATA_DIR", "/data"))
LOCK = threading.RLock()
WAKE = threading.Event()
TOKEN = os.environ.get("AUDIO_OFFLOAD_TOKEN", "")


class Rejected(Exception):
    def __init__(self, status, message):
        self.status, self.message = status, message


def save(folder, job):
    tmp = folder / "state.tmp"
    with tmp.open("w") as f:
        json.dump(job, f)
        f.flush()
        os.fsync(f.fileno())
    tmp.replace(folder / "state.json")


def load(folder):
    try:
        return json.loads((folder / "state.json").read_text())
    except FileNotFoundError:
        raise Rejected(404, "job not found") from None


def digest(path):
    h = hashlib.sha256()
    with path.open("rb") as f:
        for block in iter(lambda: f.read(1024 * 1024), b""):
            h.update(block)
    return h.hexdigest()


def probe(path):
    result = subprocess.run(
        [
            "ffprobe",
            "-v",
            "error",
            "-protocol_whitelist",
            "file,pipe",
            "-show_entries",
            "format=duration",
            "-of",
            "default=nw=1:nk=1",
            str(path),
        ],
        capture_output=True,
        text=True,
        timeout=30,
        check=True,
    )
    duration = float(result.stdout.strip())
    if not math.isfinite(duration) or not 0 < duration <= MAX_DURATION:
        raise ValueError("unsupported audio duration")
    return duration


def decoded_duration(progress):
    # Input MP3 headers can contain estimated durations. Compare segments to
    # the completed decoder timeline instead, while requiring successful EOF.
    fields = dict(line.split("=", 1) for line in progress.read_text().splitlines() if "=" in line)
    if fields.get("progress") != "end":
        raise ValueError("audio decode did not complete")
    duration = int(fields.get("out_time_us", "0")) / 1_000_000
    if not math.isfinite(duration) or not 0 < duration <= MAX_DURATION:
        raise ValueError("unsupported decoded duration")
    return duration


def encode(folder):
    with LOCK:
        job = load(folder)
        job.update(status="processing", attempts=job.get("attempts", 0) + 1)
        save(folder, job)
    try:
        probe(folder / "input")  # Preflight only; headers are not the decoded length.
        (folder / "progress").unlink(missing_ok=True)
        for stale in folder.glob("chunk_*.mp3"):
            stale.unlink()
        # Container has no internet route; whitelist also prevents playlist inputs
        # from reaching HTTP, TCP, local devices or other protocols through ffmpeg.
        with (folder / "error.log").open("w") as stderr:
            subprocess.run(
                [
                    "ffmpeg",
                    "-hide_banner",
                    "-loglevel",
                    "error",
                    "-xerror",
                    "-y",
                    "-progress",
                    str(folder / "progress"),
                    "-nostats",
                    "-protocol_whitelist",
                    "file,pipe",
                    "-threads",
                    "1",
                    "-i",
                    str(folder / "input"),
                    "-map",
                    "0:a:0",
                    "-vn",
                    "-ac",
                    "1",
                    "-ar",
                    "16000",
                    "-threads",
                    "1",
                    "-f",
                    "segment",
                    "-segment_time",
                    str(job["chunk_seconds"]),
                    "-c:a",
                    "libmp3lame",
                    "-q:a",
                    "5",
                    str(folder / "chunk_%04d.mp3"),
                ],
                stdin=subprocess.DEVNULL,
                stdout=subprocess.DEVNULL,
                stderr=stderr,
                timeout=900,
                check=True,
            )
        duration = decoded_duration(folder / "progress")
        chunks = []
        for path in sorted(folder.glob("chunk_*.mp3")):
            chunks.append(
                dict(
                    name=path.name,
                    bytes=path.stat().st_size,
                    sha256=digest(path),
                    duration_s=probe(path),
                )
            )
        actual = sum(c["duration_s"] for c in chunks)
        if not chunks or abs(actual - duration) > max(2, len(chunks) * 0.15):
            raise ValueError("audio coverage validation failed")
        with LOCK:
            job.update(status="done", chunks=chunks, duration_s=duration, completed=time.time())
            save(folder, job)
            # A retry reuses the manifest/chunks; retaining the much larger
            # original would unnecessarily exhaust the small data volume.
            (folder / "input").unlink(missing_ok=True)
    except Exception as exc:
        with LOCK:
            job.update(
                status="queued" if job["attempts"] < 3 else "failed", error=type(exc).__name__
            )
            save(folder, job)


def recover():
    ROOT.mkdir(parents=True, exist_ok=True)
    with LOCK:
        for folder in ROOT.iterdir():
            if not folder.is_dir():
                continue
            job = load(folder)
            if job["status"] == "processing":
                job["status"] = "queued"
                save(folder, job)


def worker():
    while True:
        pending = None
        with LOCK:
            for folder in sorted(ROOT.iterdir(), key=lambda p: p.stat().st_mtime):
                if not folder.is_dir():
                    continue
                job = load(folder)
                if time.time() - job["created"] > TTL and job["status"] != "processing":
                    shutil.rmtree(folder)
                elif job["status"] == "queued" and pending is None:
                    pending = folder
        if pending:
            # Claim under the same lock used to select, before another encoder
            # can see the job. Each worker performs a second check below.
            with LOCK:
                job = load(pending)
                if job["status"] != "queued":
                    continue
                job["status"] = "processing"
                save(pending, job)
            encode(pending)
        else:
            WAKE.wait(5)
            WAKE.clear()


def status(folder):
    job = load(folder).copy()
    job["uploaded_parts"] = [int(p.name[5:]) for p in folder.glob("part_*")]
    if job["status"] == "processing":
        try:
            values = re.findall(r"out_time_us=(\d+)", (folder / "progress").read_text())
            job["processed_s"] = int(values[-1]) / 1e6 if values else 0
        except FileNotFoundError:
            job["processed_s"] = 0
    return job


def create(spec):
    sha, size, seconds = spec.get("sha256"), spec.get("bytes"), spec.get("chunk_seconds")
    if not isinstance(sha, str) or not re.fullmatch(r"[0-9a-f]{64}", sha):
        raise Rejected(400, "invalid digest")
    if type(size) is not int or not 0 < size <= MAX_BYTES:
        raise Rejected(413, "audio exceeds size limit")
    if type(seconds) is not int or not 30 <= seconds <= 1800:
        raise Rejected(400, "invalid chunk duration")
    job_id = hashlib.sha256(f"v1:{sha}:{size}:{seconds}".encode()).hexdigest()
    folder = ROOT / job_id
    if folder.exists():
        return dict(id=job_id, **status(folder))
    # Reserve enough space for all declared inputs plus one assembled copy and
    # outputs. Existing terminal jobs expire; don't evict results still in use.
    jobs = [load(p) for p in ROOT.iterdir() if p.is_dir()]
    active = [j for j in jobs if j["status"] not in ("done", "failed")]
    reserved = sum(j["bytes"] * 2 for j in active)
    if (
        len(jobs) >= 256
        or len(active) >= 8
        or shutil.disk_usage(ROOT).free < reserved + size * 3 + 512 * 1024**2
    ):
        raise Rejected(503, "audio capacity temporarily unavailable")
    folder.mkdir(mode=0o700)
    save(
        folder,
        dict(
            sha256=sha,
            bytes=size,
            chunk_seconds=seconds,
            status="uploading",
            created=time.time(),
            attempts=0,
        ),
    )
    return dict(id=job_id, **status(folder))


def upload(folder, index, data):
    job = load(folder)
    expected = min(PART_BYTES, job["bytes"] - index * PART_BYTES)
    if index < 0 or expected <= 0 or len(data) != expected:
        raise Rejected(400, "invalid upload part")
    if job["status"] != "uploading":
        return
    part = folder / f"part_{index}"
    temp = folder / "upload.tmp"
    temp.write_bytes(data)
    temp.replace(part)


def submit(folder):
    job = load(folder)
    if job["status"] != "uploading":
        return status(folder)
    count = math.ceil(job["bytes"] / PART_BYTES)
    if any(not (folder / f"part_{i}").exists() for i in range(count)):
        raise Rejected(409, "upload incomplete")
    with (folder / "input.tmp").open("wb") as output:
        for i in range(count):
            with (folder / f"part_{i}").open("rb") as part:
                shutil.copyfileobj(part, output, 1024 * 1024)
    if digest(folder / "input.tmp") != job["sha256"]:
        (folder / "input.tmp").unlink()
        # A new request may replace bad parts rather than becoming unrecoverable.
        for part in folder.glob("part_*"):
            part.unlink()
        raise Rejected(409, "audio checksum mismatch; upload again")
    (folder / "input.tmp").replace(folder / "input")
    for part in folder.glob("part_*"):
        part.unlink()
    job["status"] = "queued"
    save(folder, job)
    WAKE.set()
    return status(folder)


class Handler(BaseHTTPRequestHandler):
    server_version = "Audio"
    sys_version = ""

    def log_message(self, *_args):
        pass  # Never log Authorization, file names or job digests.

    def setup(self):
        super().setup()
        self.connection.settimeout(45)

    def body(self, maximum):
        try:
            size = int(self.headers.get("Content-Length", "-1"))
        except ValueError:
            size = -1
        if not 0 <= size <= maximum or self.headers.get("Transfer-Encoding"):
            raise Rejected(413, "bounded Content-Length required")
        data = self.rfile.read(size)
        if len(data) != size:
            raise Rejected(400, "incomplete request")
        return data

    def reply(self, code, value):
        data = json.dumps(value).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(data)))
        self.send_header("Cache-Control", "no-store")
        self.send_header("Connection", "close")
        self.end_headers()
        self.wfile.write(data)

    def dispatch(self):
        try:
            if not hmac.compare_digest(self.headers.get("Authorization", ""), f"Bearer {TOKEN}"):
                raise Rejected(401, "unauthorized")
            if self.command == "GET" and self.path == "/health":
                return self.reply(200, {"status": "ok", "version": 1})
            # Never hold the state lock during network I/O. In particular, a
            # partial/slow upload must not block progress polls or the encoders.
            if self.command == "POST" and self.path == "/jobs":
                spec = json.loads(self.body(2048))
                with LOCK:
                    result = create(spec)
                return self.reply(200, result)
            match = re.fullmatch(
                r"/jobs/([a-f0-9]{64})(?:/(submit|parts/[0-9]{1,3}|chunk_[0-9]{4}\.mp3))?",
                self.path,
            )
            if not match:
                raise Rejected(404, "not found")
            folder, action = ROOT / match[1], match[2]
            with LOCK:
                load(folder)
            if self.command == "GET" and action is None:
                with LOCK:
                    result = status(folder)
                return self.reply(200, result)
            if self.command == "PUT" and action and action.startswith("parts/"):
                data = self.body(PART_BYTES)
                with LOCK:
                    upload(folder, int(action.split("/")[1]), data)
                return self.reply(200, {"ok": True})
            if self.command == "POST" and action == "submit":
                self.body(0)
                with LOCK:
                    result = submit(folder)
                return self.reply(200, result)
            if self.command == "GET" and action and action.startswith("chunk_"):
                with LOCK:
                    job = load(folder)
                    if job["status"] != "done" or action not in {c["name"] for c in job["chunks"]}:
                        raise Rejected(404, "chunk not available")
                    path = folder / action
                    # Open before releasing the lock so expiry cannot race us.
                    stream = path.open("rb")
                    size = os.fstat(stream.fileno()).st_size
                with stream:
                    self.send_response(200)
                    self.send_header("Content-Type", "audio/mpeg")
                    self.send_header("Content-Length", str(size))
                    self.send_header("Cache-Control", "no-store")
                    self.end_headers()
                    shutil.copyfileobj(stream, self.wfile, 65536)
                return
            raise Rejected(405, "method not allowed")
        except Rejected as exc:
            self.reply(exc.status, {"error": exc.message})
        except (ValueError, TypeError, KeyError):
            self.reply(400, {"error": "invalid request"})
        except (BrokenPipeError, ConnectionResetError, TimeoutError):
            pass
        except Exception:
            self.reply(500, {"error": "audio service error"})

    do_GET = dispatch
    do_POST = dispatch
    do_PUT = dispatch


class Server(ThreadingHTTPServer):
    daemon_threads = True
    slots = threading.BoundedSemaphore(16)

    def process_request(self, request, address):
        if not self.slots.acquire(blocking=False):
            self.shutdown_request(request)
            return
        try:
            super().process_request(request, address)
        except Exception:
            self.slots.release()
            raise

    def process_request_thread(self, request, address):
        try:
            super().process_request_thread(request, address)
        finally:
            self.slots.release()


if __name__ == "__main__":
    if len(TOKEN) < 40:
        raise SystemExit("AUDIO_OFFLOAD_TOKEN must be a strong secret")
    os.umask(0o077)
    recover()
    # Four jobs can run at once; each MP3 encoder uses one thread. The entire
    # container is capped at two CPUs by Compose, including validation/upload.
    for _ in range(4):
        threading.Thread(target=worker, daemon=True).start()
    Server(("0.0.0.0", 8080), Handler).serve_forever()

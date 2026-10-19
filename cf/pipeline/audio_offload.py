"""Resumable Oracle audio preparation. Deliberately has no local ffmpeg fallback."""

from __future__ import annotations

import hashlib
import os
import re
import time
from pathlib import Path
from urllib.parse import urlsplit

import httpx

PART_BYTES = 8 * 1024 * 1024


class OracleAudioUnavailable(RuntimeError):
    pass


def _progress(callback, detail, **extra):
    if callback:
        try:
            callback({"stage": "transcribe", "status": "processing", "detail": detail, **extra})
        except Exception:
            pass


def _request(client, method, path, **kwargs):
    for attempt in range(4):
        try:
            response = client.request(method, path, **kwargs)
            if response.status_code not in (429, 500, 502, 503, 504, 520, 522, 524):
                response.raise_for_status()
                return response
        except httpx.TransportError:
            pass
        except httpx.HTTPStatusError as exc:
            # Don't include response URLs/headers or credentials in pipeline logs.
            raise RuntimeError(
                f"Oracle audio rejected request ({exc.response.status_code})"
            ) from None
        if attempt < 3:
            time.sleep(2**attempt)
    raise OracleAudioUnavailable("oracle audio unavailable: request retries exhausted")


def split_audio(path, chunk_seconds, workdir, on_progress=None):
    url = os.environ.get("AUDIO_OFFLOAD_URL", "").rstrip("/")
    token = os.environ.get("AUDIO_OFFLOAD_TOKEN", "")
    parsed = urlsplit(url)
    if (
        parsed.scheme != "https"
        or not parsed.hostname
        or parsed.username
        or parsed.query
        or not token
    ):
        raise RuntimeError("Oracle audio HTTPS URL and token must be configured")
    source = Path(path)
    size = source.stat().st_size
    if not 0 < size <= 512 * 1024 * 1024:
        raise RuntimeError("Oracle audio supports files up to 512 MiB")
    workdir = Path(workdir)
    workdir.mkdir(parents=True, exist_ok=True)
    sha = hashlib.sha256()
    with source.open("rb") as f:
        for block in iter(lambda: f.read(1024 * 1024), b""):
            sha.update(block)
    with httpx.Client(
        base_url=url,
        headers={"Authorization": f"Bearer {token}"},
        timeout=httpx.Timeout(90, connect=15),
        follow_redirects=False,
        trust_env=False,
    ) as client:
        _progress(on_progress, "uploading audio to Oracle ARM", pct=0)
        state = _request(
            client,
            "POST",
            "/jobs",
            json={
                "sha256": sha.hexdigest(),
                "bytes": size,
                "chunk_seconds": chunk_seconds,
            },
        ).json()
        job_id = state.get("id", "")
        if not re.fullmatch(r"[a-f0-9]{64}", job_id):
            raise RuntimeError("invalid Oracle audio job response")
        job_path = f"/jobs/{job_id}"
        if state["status"] == "uploading":
            present = set(state.get("uploaded_parts", []))
            with source.open("rb") as f:
                for index in range((size + PART_BYTES - 1) // PART_BYTES):
                    data = f.read(PART_BYTES)
                    if index not in present:
                        _request(client, "PUT", f"{job_path}/parts/{index}", content=data)
                    _progress(
                        on_progress,
                        "uploading audio to Oracle ARM",
                        pct=round(min((index + 1) * PART_BYTES / size, 1) * 100, 1),
                    )
            state = _request(client, "POST", f"{job_path}/submit", content=b"").json()
        deadline = time.monotonic() + 1800
        while state["status"] not in ("done", "failed"):
            if time.monotonic() > deadline:
                raise OracleAudioUnavailable(
                    "oracle audio unavailable: job still queued; retry later"
                )
            _progress(
                on_progress,
                "Oracle ARM preparing audio chunks",
                processed_s=state.get("processed_s", 0),
            )
            time.sleep(2)
            state = _request(client, "GET", job_path).json()
        if state["status"] == "failed":
            raise RuntimeError("Oracle audio processing failed after three attempts")
        chunks = state.get("chunks", [])
        if not chunks or len(chunks) > 1440:
            raise RuntimeError("invalid Oracle audio chunk manifest")
        paths = []
        for index, chunk in enumerate(chunks):
            name = chunk.get("name", "")
            if name != f"chunk_{index:04d}.mp3" or not 0 < chunk["bytes"] <= 25 * 1024**2:
                raise RuntimeError("invalid Oracle audio chunk metadata")
            target = workdir / name
            # Every chunk is bounded; never trust remote names or partial downloads.
            data = _request(client, "GET", f"{job_path}/{name}").content
            if len(data) != chunk["bytes"] or hashlib.sha256(data).hexdigest() != chunk["sha256"]:
                raise OracleAudioUnavailable("oracle audio unavailable: chunk checksum mismatch")
            target.write_bytes(data)
            paths.append(target)
            _progress(
                on_progress,
                "receiving Oracle ARM audio chunks",
                pct=round((index + 1) / len(chunks) * 100, 1),
            )
        return paths

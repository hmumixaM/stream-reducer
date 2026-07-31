"""ffmpeg-based audio utilities: probing and chunking."""

from __future__ import annotations

import subprocess
import time
from collections.abc import Callable
from pathlib import Path

ProgressCallback = Callable[[dict], None]


def _seconds(value: str) -> float:
    """Parse ffmpeg's HH:MM:SS.microseconds progress value."""
    try:
        hours, minutes, seconds = value.split(":")
        return int(hours) * 3600 + int(minutes) * 60 + float(seconds)
    except (ValueError, TypeError):
        return 0.0


def _emit_progress(
    on_progress: ProgressCallback | None,
    *,
    stage: str,
    detail: str,
    processed_s: float,
    duration_s: float,
) -> None:
    if not on_progress:
        return
    pct = round(min(processed_s / duration_s * 100, 100), 1) if duration_s > 0 else None
    try:
        on_progress({
            "stage": stage,
            "status": "processing",
            "detail": detail,
            "pct": pct,
            "processed_s": round(processed_s, 2),
            "duration_s": round(duration_s, 2) if duration_s > 0 else None,
        })
    except Exception:
        # Progress is observability only; it must never break ffmpeg.
        pass


def _run_ffmpeg_with_progress(
    command: list[str],
    *,
    on_progress: ProgressCallback | None,
    stage: str,
    detail: str,
    duration_s: float,
    check: bool,
) -> float:
    """Run ffmpeg and turn ``-progress`` records into pipeline heartbeats."""
    _emit_progress(
        on_progress,
        stage=stage,
        detail=detail,
        processed_s=0,
        duration_s=duration_s,
    )
    proc = subprocess.Popen(
        command,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
    )
    processed_s = 0.0
    last_emit = 0.0
    assert proc.stdout is not None
    for raw_line in proc.stdout:
        key, separator, value = raw_line.strip().partition("=")
        if not separator:
            continue
        if key == "out_time":
            processed_s = max(processed_s, _seconds(value))
        elif key == "progress":
            now = time.monotonic()
            if value == "end" or now - last_emit >= 2:
                _emit_progress(
                    on_progress,
                    stage=stage,
                    detail=detail,
                    processed_s=processed_s,
                    duration_s=duration_s,
                )
                last_emit = now

    stderr = proc.stderr.read() if proc.stderr is not None else ""
    return_code = proc.wait()
    if check and return_code:
        raise subprocess.CalledProcessError(return_code, command, stderr=stderr)
    return processed_s


def probe_duration(path: str | Path) -> float:
    """Return the container-reported audio duration in seconds (0.0 if unknown).

    This trusts the file header/moov, which can claim the full length even when
    the stream is truncated or corrupt mid-file. Use decodable_duration() when
    you need the *real* playable length.
    """
    out = subprocess.run(
        [
            "ffprobe", "-v", "error",
            "-show_entries", "format=duration",
            "-of", "default=nw=1:nk=1",
            str(path),
        ],
        capture_output=True, text=True, check=False,
    )
    try:
        return float(out.stdout.strip())
    except ValueError:
        return 0.0


def decodable_duration(
    path: str | Path,
    on_progress: ProgressCallback | None = None,
) -> float:
    """Return how many seconds ffmpeg can actually DECODE from the file.

    Unlike probe_duration (which trusts the container header), this fully decodes
    the audio stream and reports how far it got. A byte-complete but mid-stream
    corrupt download — a common Bilibili flaky-CDN failure whose header still
    advertises the full duration — reports its true (short) decodable length here.
    """
    duration_s = probe_duration(path)
    return _run_ffmpeg_with_progress(
        [
            "ffmpeg", "-hide_banner", "-v", "error",
            "-progress", "pipe:1", "-nostats",
            "-i", str(path), "-vn", "-f", "null", "-",
        ],
        on_progress=on_progress,
        stage="download",
        detail="validating downloaded audio",
        duration_s=duration_s,
        check=False,
    )


def split_audio(
    path: str | Path,
    chunk_seconds: int,
    workdir: Path,
    on_progress: ProgressCallback | None = None,
) -> list[Path]:
    """Split audio into mono 16kHz mp3 chunks suitable for STT.

    Mono/16kHz downsampling matches what STT models use and keeps the
    base64 payload (and thus rate-limit pressure) small.
    """
    workdir.mkdir(parents=True, exist_ok=True)
    pattern = str(workdir / "chunk_%04d.mp3")
    duration_s = probe_duration(path)
    _run_ffmpeg_with_progress(
        [
            "ffmpeg", "-hide_banner", "-loglevel", "error", "-y",
            "-progress", "pipe:1", "-nostats",
            "-i", str(path),
            "-vn", "-ac", "1", "-ar", "16000",
            "-f", "segment",
            "-segment_time", str(chunk_seconds),
            "-c:a", "libmp3lame", "-q:a", "5",
            pattern,
        ],
        on_progress=on_progress,
        stage="transcribe",
        detail="preparing audio chunks",
        duration_s=duration_s,
        check=True,
    )
    return sorted(workdir.glob("chunk_*.mp3"))

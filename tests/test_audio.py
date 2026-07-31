"""Unit tests for ffmpeg audio chunking (no network)."""

from __future__ import annotations

import subprocess
from pathlib import Path

import pytest

from app.pipeline.audio import decodable_duration, probe_duration, split_audio


def _make_tone(path: Path, seconds: int) -> None:
    subprocess.run(
        [
            "ffmpeg", "-hide_banner", "-loglevel", "error", "-y",
            "-f", "lavfi", "-i", f"sine=frequency=440:duration={seconds}",
            str(path),
        ],
        check=True,
    )


def test_probe_and_split(tmp_path: Path) -> None:
    src = tmp_path / "tone.wav"
    _make_tone(src, 12)
    assert 11.5 <= probe_duration(src) <= 12.5

    decode_progress: list[dict] = []
    assert 11.5 <= decodable_duration(src, decode_progress.append) <= 12.5
    assert decode_progress
    assert {event["detail"] for event in decode_progress} == {"validating downloaded audio"}

    split_progress: list[dict] = []
    chunks = split_audio(
        src,
        chunk_seconds=5,
        workdir=tmp_path / "chunks",
        on_progress=split_progress.append,
    )
    assert len(chunks) == 3  # 5 + 5 + 2
    assert all(c.suffix == ".mp3" for c in chunks)
    assert all(c.stat().st_size > 0 for c in chunks)
    assert split_progress
    assert {event["stage"] for event in split_progress} == {"transcribe"}
    assert {event["detail"] for event in split_progress} == {"preparing audio chunks"}


def test_split_empty_missing(tmp_path: Path) -> None:
    with pytest.raises(subprocess.CalledProcessError):
        split_audio(tmp_path / "nope.wav", 5, tmp_path / "out")

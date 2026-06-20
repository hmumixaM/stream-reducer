"""Proxy rotation + cookie-cache reset in the shared yt-dlp adapter."""

from __future__ import annotations

from pathlib import Path

import pytest

from app.adapters import ytdlp_base
from app.adapters.youtube import YouTubeAdapter


def test_proxy_candidates_default(monkeypatch):
    monkeypatch.delenv("PROXY_URLS", raising=False)
    assert ytdlp_base._proxy_candidates() == [None]


def test_proxy_candidates_parsing(monkeypatch):
    monkeypatch.setenv("PROXY_URLS", "socks5://127.0.0.1:40000, socks5://127.0.0.1:40001 ,direct")
    assert ytdlp_base._proxy_candidates() == [
        "socks5://127.0.0.1:40000",
        "socks5://127.0.0.1:40001",
        None,
    ]


def test_ydl_opts_injects_active_proxy():
    adapter = YouTubeAdapter()
    adapter._active_proxy = "socks5://127.0.0.1:40000"
    assert adapter._ydl_opts()["proxy"] == "socks5://127.0.0.1:40000"


def test_ydl_opts_no_proxy_when_direct():
    adapter = YouTubeAdapter()
    adapter._active_proxy = None  # explicit "direct"
    assert "proxy" not in adapter._ydl_opts()


def test_download_audio_rotates_to_working_proxy(monkeypatch, tmp_path):
    monkeypatch.setenv("PROXY_URLS", "socks5://127.0.0.1:40000,socks5://127.0.0.1:40001,direct")
    adapter = YouTubeAdapter()
    used: list[object] = []

    def fake_once(url: str, dest_dir: Path, outtmpl: str, logbuf=None, on_progress=None) -> Path:
        used.append(adapter._active_proxy)
        if adapter._active_proxy != "socks5://127.0.0.1:40001":
            raise RuntimeError("HTTP Error 412: Precondition Failed")
        out = dest_dir / "ok.m4a"
        out.write_text("audio")
        return out

    monkeypatch.setattr(adapter, "_download_audio_once", fake_once)
    result = adapter.download_audio("https://example.com/v", tmp_path)

    assert result.name == "ok.m4a"
    # Rotated through the first (failing) proxy then succeeded on the second.
    assert used == ["socks5://127.0.0.1:40000", "socks5://127.0.0.1:40001"]


def test_download_audio_raises_last_error_when_all_fail(monkeypatch, tmp_path):
    monkeypatch.setenv("PROXY_URLS", "socks5://127.0.0.1:40000,direct")
    adapter = YouTubeAdapter()

    def always_fail(url: str, dest_dir: Path, outtmpl: str, logbuf=None, on_progress=None) -> Path:
        raise RuntimeError(f"boom via {adapter._active_proxy}")

    monkeypatch.setattr(adapter, "_download_audio_once", always_fail)
    with pytest.raises(RuntimeError, match="boom via None"):
        adapter.download_audio("https://example.com/v", tmp_path)


def test_reset_cookie_cache(monkeypatch):
    ytdlp_base._COOKIE_HEADER_FILES["X"] = "/tmp/x.txt"
    ytdlp_base.reset_cookie_cache()
    assert ytdlp_base._COOKIE_HEADER_FILES == {}


def test_is_risk_control_classification():
    assert ytdlp_base._is_risk_control(RuntimeError("HTTP Error 412: Precondition Failed"))
    assert ytdlp_base._is_risk_control(RuntimeError("code -352 风控"))
    assert not ytdlp_base._is_risk_control(RuntimeError("video unavailable"))


def test_proxy_candidates_yt_dlp_proxy_fallback(monkeypatch):
    monkeypatch.delenv("PROXY_URLS", raising=False)
    monkeypatch.setenv("YT_DLP_PROXY", "http://proxy.example:8080")
    # YT_DLP_PROXY env wins over the (empty) setting; direct is the fallback.
    assert ytdlp_base._proxy_candidates() == ["http://proxy.example:8080", None]


def test_looks_ip_blocked():
    assert ytdlp_base._looks_ip_blocked("ERROR: Sign in to confirm you're not a bot")
    assert ytdlp_base._looks_ip_blocked("HTTP Error 403: Forbidden")
    assert not ytdlp_base._looks_ip_blocked("video is private")


def test_map_progress():
    evt = ytdlp_base._map_progress(
        {"status": "downloading", "downloaded_bytes": 50, "total_bytes": 200, "speed": 1000, "eta": 3}
    )
    assert evt == {"stage": "download", "status": "downloading", "pct": 25.0,
                   "downloaded": 50, "total": 200, "speed": 1000, "eta": 3}


def test_download_error_ip_block_hint():
    adapter = YouTubeAdapter()
    msg = adapter._download_error(RuntimeError("x"), "ERROR: Sign in to confirm you're not a bot")
    assert "YT_DLP_PROXY" in msg


def test_download_audio_once_uses_audio_only_format(monkeypatch, tmp_path):
    captured: dict = {}

    class _FakeYDL:
        def __init__(self, opts):
            captured.update(opts)

        def __enter__(self):
            return self

        def __exit__(self, *a):
            return False

        def extract_info(self, url, download):
            (tmp_path / "x.m4a").write_text("a")
            return {"id": "x"}

        def prepare_filename(self, info):
            return str(tmp_path / "x.m4a")

    monkeypatch.setattr(ytdlp_base, "YoutubeDL", _FakeYDL)
    adapter = YouTubeAdapter()
    adapter._download_audio_once("u", tmp_path, str(tmp_path / "%(id)s.%(ext)s"), ytdlp_base._CaptureLogger(), None)
    assert captured["format"] == "bestaudio/worst"

"""Proxy rotation + cookie-cache reset in the shared yt-dlp adapter."""

from __future__ import annotations

from pathlib import Path

import pytest

from app.adapters import warp, ytdlp_base
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


def test_force_ipv4_profile_removes_ipv6_routes(tmp_path):
    profile = tmp_path / "warp.conf"
    profile.write_text(
        "[Interface]\n"
        "Address = 172.16.0.2/32\n"
        "Address = 2606:4700:110:8c7d::2/128\n"
        "DNS = 1.1.1.1, 2606:4700:4700::1111\n"
        "[Peer]\n"
        "AllowedIPs = 0.0.0.0/0, ::/0\n"
        "Endpoint = engage.cloudflareclient.com:2408\n"
    )

    warp.force_ipv4_profile(profile)

    assert profile.read_text() == (
        "[Interface]\n"
        "Address = 172.16.0.2/32\n"
        "DNS = 1.1.1.1\n"
        "[Peer]\n"
        "AllowedIPs = 0.0.0.0/0\n"
        "Endpoint = engage.cloudflareclient.com:2408\n"
    )


def test_ydl_opts_injects_active_proxy():
    adapter = YouTubeAdapter()
    adapter._active_proxy = "socks5://127.0.0.1:40000"
    assert adapter._ydl_opts()["proxy"] == "socks5://127.0.0.1:40000"


def test_ydl_opts_no_proxy_when_direct():
    adapter = YouTubeAdapter()
    adapter._active_proxy = None  # explicit "direct"
    assert "proxy" not in adapter._ydl_opts()


def test_youtube_prefers_direct_then_residential_then_warp(monkeypatch):
    monkeypatch.setenv(
        "PROXY_URLS",
        "socks5://127.0.0.1:40000,socks5://127.0.0.1:42000,"
        "socks5://127.0.0.1:40001,direct",
    )
    monkeypatch.setenv("RESIDENTIAL_PROXY_URL", "socks5://127.0.0.1:42000")

    assert YouTubeAdapter()._egress_candidates() == [
        None,
        "socks5://127.0.0.1:42000",
        "socks5://127.0.0.1:40000",
        "socks5://127.0.0.1:40001",
    ]


def test_youtube_uses_login_cookies_only_on_residential_proxy(monkeypatch):
    residential = "socks5://127.0.0.1:42000"
    monkeypatch.setenv("RESIDENTIAL_PROXY_URL", residential)
    monkeypatch.setenv("YOUTUBE_COOKIE", "SID=session; PREF=hl=en")
    ytdlp_base.reset_cookie_cache()
    adapter = YouTubeAdapter()

    adapter._active_proxy = None
    assert "cookiefile" not in adapter._ydl_opts()

    adapter._active_proxy = "socks5://127.0.0.1:40000"
    assert "cookiefile" not in adapter._ydl_opts()

    adapter._active_proxy = residential
    assert adapter._ydl_opts()["cookiefile"].endswith("ytdlp_cookies_YOUTUBE_COOKIE.txt")


def test_youtube_rotates_age_gate_to_authenticated_egress():
    adapter = YouTubeAdapter()
    assert adapter._should_rotate_extraction(
        RuntimeError("Sign in to confirm your age. This video may be inappropriate")
    )


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
    # YouTube tries direct first, then retains both WARP fallbacks.
    assert used == [None, "socks5://127.0.0.1:40000", "socks5://127.0.0.1:40001"]


def test_download_audio_raises_last_error_when_all_fail(monkeypatch, tmp_path):
    monkeypatch.setenv("PROXY_URLS", "socks5://127.0.0.1:40000,direct")
    adapter = YouTubeAdapter()

    def always_fail(url: str, dest_dir: Path, outtmpl: str, logbuf=None, on_progress=None) -> Path:
        raise RuntimeError(f"boom via {adapter._active_proxy}")

    monkeypatch.setattr(adapter, "_download_audio_once", always_fail)
    with pytest.raises(RuntimeError, match="boom via socks5://127.0.0.1:40000"):
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
    msg = adapter._download_error(
        RuntimeError("x"), "ERROR: Sign in to confirm you're not a bot",
        ["socks5://127.0.0.1:41000 (8.8.8.8)", "direct"],
    )
    assert msg.startswith("IP-block")
    # The egress trail is what makes an IP failure actionable.
    assert "8.8.8.8" in msg and "direct" in msg


def test_download_audio_registers_fresh_warp_when_egress_exhausted(monkeypatch, tmp_path):
    monkeypatch.setenv("PROXY_URLS", "socks5://127.0.0.1:40000,direct")
    monkeypatch.setenv("WARP_ROTATE_ATTEMPTS", "2")
    adapter = YouTubeAdapter()
    used: list[object] = []
    monkeypatch.setattr(ytdlp_base, "spawn_fresh_warp", lambda: "socks5://127.0.0.1:41000")

    def fake_once(url: str, dest_dir: Path, outtmpl: str, logbuf=None, on_progress=None) -> Path:
        used.append(adapter._active_proxy)
        if adapter._active_proxy != "socks5://127.0.0.1:41000":
            raise RuntimeError("unable to download video data: HTTP Error 403: Forbidden")
        out = dest_dir / "ok.m4a"
        out.write_text("audio")
        return out

    monkeypatch.setattr(adapter, "_download_audio_once", fake_once)
    assert adapter.download_audio("https://example.com/v", tmp_path).name == "ok.m4a"
    assert used == [None, "socks5://127.0.0.1:40000", "socks5://127.0.0.1:41000"]


def test_download_audio_skips_fresh_warp_for_content_errors(monkeypatch, tmp_path):
    monkeypatch.setenv("PROXY_URLS", "direct")
    adapter = YouTubeAdapter()
    spawned: list[int] = []

    def spy() -> str | None:
        spawned.append(1)
        return "socks5://127.0.0.1:41000"

    monkeypatch.setattr(ytdlp_base, "spawn_fresh_warp", spy)
    monkeypatch.setattr(
        adapter, "_download_audio_once",
        lambda *a, **k: (_ for _ in ()).throw(RuntimeError("Private video. Sign in")),
    )
    with pytest.raises(RuntimeError, match="Private video"):
        adapter.download_audio("https://example.com/v", tmp_path)
    # A private/deleted source is not an egress problem, so don't pay for a
    # WARP registration to learn that again.
    assert spawned == []


def test_age_gate_is_not_an_ip_block():
    msg = "ERROR: [youtube] x: Sign in to confirm your age. This video may be inappropriate"
    assert not ytdlp_base._looks_ip_blocked(msg)
    assert not ytdlp_base._should_rotate_egress(RuntimeError(msg))
    assert ytdlp_base._looks_ip_blocked("Sign in to confirm you're not a bot")


def test_download_error_names_missing_js_runtime():
    adapter = YouTubeAdapter()
    log = (
        "[youtube] No supported JavaScript runtime could be found. Only deno is enabled by default\n"
        "ERROR: unable to download video data: HTTP Error 403: Forbidden"
    )
    msg = adapter._download_error(RuntimeError("403"), log)
    assert "no JS runtime" in msg
    # The 403 is a symptom here, so don't blame the egress.
    assert "IP-block" not in msg


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

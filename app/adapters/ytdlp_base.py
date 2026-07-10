"""Shared yt-dlp adapter logic for YouTube and Bilibili."""

from __future__ import annotations

import collections
import logging
import os
import tempfile
import time
from collections.abc import Callable
from datetime import UTC, datetime
from pathlib import Path

import httpx
from yt_dlp import YoutubeDL

from app.adapters.base import Adapter, ContentMeta, NativeTranscript
from app.adapters.subtitles import parse_json3, parse_vtt
from app.config import get_settings

logger = logging.getLogger(__name__)

BROWSER_UA = (
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/124.0 Safari/537.36"
)

# Where mounted cookie files are looked up when YT_DLP_COOKIES_FILE is unset.
COOKIES_DIR = Path("/cookies")

# Cache of cookie files materialized from a "name=value; …" header env var,
# keyed by the env var name (so we write each one only once per process).
_COOKIE_HEADER_FILES: dict[str, str] = {}

# Sentinel: the adapter hasn't picked a proxy yet, so fall back to the first
# configured candidate.
_PROXY_UNSET = object()

# Substrings that mark a Bilibili (or generic) anti-bot / IP risk-control reject.
# Used only to classify log lines — rotation itself fires on any failure when a
# fallback proxy is available.
_RISK_MARKERS = (
    "412",
    "precondition failed",
    "-352",
    "-403",
    "风控",
    "risk",
    "区域限制",
    "geo restrict",
)


def reset_cookie_cache() -> None:
    """Forget materialized cookie files so a changed cookie env (e.g. a freshly
    refreshed Bilibili cookie passed per-job) is re-materialized on next use."""
    _COOKIE_HEADER_FILES.clear()


def _proxy_candidates() -> list[str | None]:
    """Ordered proxy candidates yt-dlp egresses through, tried in order with
    rotation on failure.

    Sources, in priority:
    - ``PROXY_URLS`` (comma-separated): the WARP SOCKS5 instances + ``direct``
      the container's entrypoint exports.
    - else a single ``YT_DLP_PROXY`` (self-hosted / explicit proxy) followed by
      ``direct`` as a fallback.
    - else ``[None]`` (direct egress, unchanged behaviour).

    Each entry is a proxy URL (``socks5://…`` / ``http://…``) or ``None`` for a
    direct connection (the literal ``direct`` token maps to ``None``).
    """
    raw = os.environ.get("PROXY_URLS", "").strip()
    if not raw:
        single = os.environ.get("YT_DLP_PROXY", "").strip() or (get_settings().yt_dlp_proxy or "").strip()
        if single:
            return [single, None]
        return [None]
    out: list[str | None] = []
    for part in raw.split(","):
        p = part.strip()
        if not p:
            continue
        out.append(None if p.lower() == "direct" else p)
    return out or [None]


def _is_risk_control(exc: Exception) -> bool:
    msg = str(exc).lower()
    return any(marker in msg for marker in _RISK_MARKERS)


def await_warp_ready(timeout: int = 30) -> bool:
    """Block (bounded) until the first configured WARP SOCKS proxy can actually
    pass traffic, so a cold container's first job doesn't race the WireGuard
    handshake (the container now binds :8080 immediately and warms WARP in the
    background). No-op when the first candidate is direct or there's no proxy;
    returns False on timeout (rotation/direct then handles it)."""
    proxy = _proxy_candidates()[0]
    if not proxy or not str(proxy).startswith("socks"):
        return True
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        try:
            resp = httpx.get("https://www.cloudflare.com/cdn-cgi/trace", proxy=proxy, timeout=6)
            if resp.status_code == 200:
                return True
        except Exception:  # noqa: BLE001 — proxy not up yet; keep polling
            pass
        time.sleep(2)
    logger.warning("WARP proxy %s not ready after %ss; proceeding (will rotate)", proxy, timeout)
    return False


# Phrases that mean "this IP is blocked/flagged" (YouTube bot wall, HTTP
# 403/412/429, geo). Used to prefix a clear, actionable hint on the error.
_IP_BLOCK_MARKERS = (
    "sign in to confirm",
    "not a bot",
    "http error 403",
    "http error 412",
    "http error 429",
    "confirm you're not a bot",
    "blocked it in your country",
    "this video is not available",
)


def _looks_ip_blocked(text: str) -> bool:
    t = text.lower()
    return any(m in t for m in _IP_BLOCK_MARKERS)


# Connection/egress failures that a DIFFERENT egress (next WARP instance, then
# direct) might get past — the WARP SOCKS proxy being down mid-session is the
# common one ("[Errno 111] Connection refused" during YouTube API extraction).
_CONNECTION_MARKERS = (
    "connection refused",
    "errno 111",
    "unable to download",
    "timed out",
    "timeout",
    "connection reset",
    "connection aborted",
    "remote end closed",
    "failed to establish",
    "temporary failure",
    "transporterror",
)


def _should_rotate_egress(exc: Exception) -> bool:
    """True when a failure looks like a proxy/IP/egress problem worth retrying
    through the next egress candidate (connection refused, timeouts, bot walls,
    403/412/429, geo/risk control). Genuine content errors (private, deleted,
    members-only) are NOT rotated so they fail fast."""
    msg = str(exc).lower()
    return (
        any(m in msg for m in _CONNECTION_MARKERS)
        or _looks_ip_blocked(msg)
        or _is_risk_control(exc)
    )


class _CaptureLogger:
    """yt-dlp logger that keeps the last N messages in a ring buffer so a
    blocked/failed download surfaces the *real* reason (bot wall, 412/403,
    geo-block) instead of the silence ``quiet=True`` would otherwise leave."""

    def __init__(self, maxlines: int = 40) -> None:
        self.lines: collections.deque[str] = collections.deque(maxlen=maxlines)

    def _add(self, msg: object) -> None:
        for line in str(msg).splitlines():
            line = line.strip()
            if line:
                self.lines.append(line)

    def debug(self, msg: object) -> None:
        # yt-dlp routes normal stdout here too; skip its [debug] spam.
        if not str(msg).startswith("[debug] "):
            self._add(msg)

    def info(self, msg: object) -> None:
        self._add(msg)

    def warning(self, msg: object) -> None:
        self._add(msg)

    def error(self, msg: object) -> None:
        self._add(msg)

    def text(self) -> str:
        return "\n".join(self.lines)


class _DownloadDeadline(Exception):
    """Raised from the progress hook to abort a download that overran its
    wall-clock budget (a slow drip / stalled CDN) so the job fails fast."""


def _map_progress(d: dict) -> dict:
    """Map a yt-dlp progress_hooks dict to a compact progress event."""
    total = d.get("total_bytes") or d.get("total_bytes_estimate")
    downloaded = d.get("downloaded_bytes")
    pct = round(downloaded / total * 100, 1) if (total and downloaded) else None
    return {
        "stage": "download",
        "status": d.get("status"),
        "pct": pct,
        "downloaded": downloaded,
        "total": total,
        "speed": d.get("speed"),
        "eta": d.get("eta"),
    }


def _resolve_cookies_file() -> str | None:
    """Use the configured cookies file, else auto-detect a *.txt in /cookies."""
    configured = get_settings().yt_dlp_cookies_file
    if configured and Path(configured).exists():
        return configured
    if COOKIES_DIR.is_dir():
        txts = sorted(COOKIES_DIR.glob("*.txt"))
        if txts:
            return str(txts[0])
    return None


def _cookie_header_to_file(env_name: str, header: str, domain: str) -> str:
    """Materialize a browser "name=value; …" cookie header into a Netscape
    cookies.txt that yt-dlp can read. Cached per env var for the process.

    The container injects the same Bilibili cookie used by the Worker feed
    APIs (BILIBILI_COOKIE) but yt-dlp only accepts a cookie *file*, not a raw
    header — without it Bilibili's web extractor returns HTTP 412.
    """
    cached = _COOKIE_HEADER_FILES.get(env_name)
    if cached and Path(cached).exists():
        return cached
    lines = ["# Netscape HTTP Cookie File"]
    for pair in header.split(";"):
        pair = pair.strip()
        if not pair or "=" not in pair:
            continue
        name, value = pair.split("=", 1)
        name, value = name.strip(), value.strip()
        if not name:
            continue
        # domain, include_subdomains, path, secure, expiry, name, value.
        # expiry 0 = session cookie (yt-dlp keeps it for the run).
        lines.append("\t".join([domain, "TRUE", "/", "FALSE", "0", name, value]))
    path = Path(tempfile.gettempdir()) / f"ytdlp_cookies_{env_name}.txt"
    path.write_text("\n".join(lines) + "\n")
    _COOKIE_HEADER_FILES[env_name] = str(path)
    return str(path)


class YtDlpAdapter(Adapter):
    name = "yt_dlp"
    # Extra HTTP headers (e.g. Referer) some sites require to avoid bot blocks.
    extra_headers: dict[str, str] = {}
    # When set, a "name=value; …" cookie header is read from this env var and
    # materialized into a yt-dlp cookie file (used when no file is mounted).
    cookie_env: str | None = None
    # Cookie domain written into the generated Netscape file (leading dot =
    # include subdomains).
    cookie_domain: str = ""
    # The proxy yt-dlp egresses through for this adapter's calls. _PROXY_UNSET
    # means "use the first configured candidate"; download_audio rewrites it as
    # it rotates through PROXY_URLS on failure.
    _active_proxy: object = _PROXY_UNSET

    def _cookies_file(self) -> str | None:
        mounted = _resolve_cookies_file()
        if mounted:
            return mounted
        if self.cookie_env:
            header = os.environ.get(self.cookie_env)
            if header:
                return _cookie_header_to_file(self.cookie_env, header, self.cookie_domain)
        return None

    def _ydl_opts(self, extra: dict | None = None) -> dict:
        opts: dict = {
            "quiet": True,
            "no_warnings": True,
            "skip_download": True,
            "noprogress": True,
            # Lean retries so a hard block (bot wall / 412 / dead CDN) surfaces in
            # seconds, not minutes — proxy rotation (download_audio) and the
            # deadline watchdog provide the broader resilience instead of many
            # in-place retries that previously left items stuck in `fetching`.
            "socket_timeout": int(os.environ.get("YT_DLP_SOCKET_TIMEOUT", "30")),
            "retries": int(os.environ.get("YT_DLP_RETRIES", "3")),
            "fragment_retries": int(os.environ.get("YT_DLP_RETRIES", "3")),
            "file_access_retries": 3,
            "extractor_retries": 2,
            "http_headers": {"User-Agent": BROWSER_UA, **self.extra_headers},
        }
        cookies = self._cookies_file()
        if cookies:
            opts["cookiefile"] = cookies
        proxy = self._active_proxy
        if proxy is _PROXY_UNSET:
            proxy = _proxy_candidates()[0]
        if proxy:
            opts["proxy"] = proxy
        if extra:
            opts.update(extra)
        return opts

    def _extract_info(self, url: str, download: bool = False, extra: dict | None = None) -> dict:
        # Metadata / native-caption / feed extraction egresses through the first
        # proxy candidate; when the WARP SOCKS proxy is down it fails with
        # "[Errno 111] Connection refused". Rotate through the remaining
        # candidates (other WARP instances, then direct) on egress failures so a
        # single flaky proxy doesn't fail the whole job. (download_audio has its
        # own rotation for the media download itself.)
        candidates = _proxy_candidates()
        last_exc: Exception | None = None
        for index, proxy in enumerate(candidates):
            self._active_proxy = proxy
            try:
                with YoutubeDL(self._ydl_opts(extra)) as ydl:
                    return ydl.extract_info(url, download=download)
            except Exception as exc:  # noqa: BLE001 — rotate egress, then re-raise
                last_exc = exc
                if index + 1 < len(candidates) and _should_rotate_egress(exc):
                    logger.warning(
                        "extract_info via proxy=%s failed (%s); rotating egress",
                        proxy or "direct", exc,
                    )
                    continue
                raise
        assert last_exc is not None
        raise last_exc

    def extract_feed_entries(self, url: str, limit: int = 300) -> list[dict]:
        """Flat-extract a channel/playlist into feed entries (newest first) with
        duration + publish date, for subscription polling.

        The Worker can't run yt-dlp, and a channel's RSS feed only exposes its
        latest ~15 uploads — so polling routes through here to enumerate the full
        recent back-catalogue. `youtubetab:approximate_date` makes YouTube flat
        entries carry an upload timestamp so the Worker can still apply its
        publish-date window; `duration` lets it apply the min-duration floor
        without scraping each watch page.
        """
        extra: dict = {"extract_flat": "in_playlist", "playlistend": limit}
        if self.name == "youtube":
            # approximate_date: carry an upload timestamp on flat entries.
            # skip=authcheck: the container's YOUTUBE_COOKIE is for one account/
            # channel, so yt-dlp's auth check otherwise 500s on a *different*
            # public channel's tab ("Playlists that require authentication …").
            extra["extractor_args"] = {
                "youtubetab": {"approximate_date": ["true"], "skip": ["authcheck"]}
            }
        info = self._extract_info(url, extra=extra)
        out: list[dict] = []
        for entry in info.get("entries") or []:
            if not entry:
                continue
            entry_url = entry.get("url") or entry.get("webpage_url")
            if not entry_url:
                continue
            ts = entry.get("timestamp")
            out.append({
                "external_id": entry.get("id"),
                "title": entry.get("title"),
                "url": entry_url,
                "duration_s": int(entry["duration"]) if entry.get("duration") else None,
                "published": datetime.fromtimestamp(ts, tz=UTC).isoformat() if ts else None,
            })
        return out

    def extract_entries(self, url: str) -> dict | None:
        """Flat-extract a playlist/collection URL into its entries.

        Returns {"title", "external_id", "entries": [{source_url, title,
        external_id}, ...]} or None when the URL isn't a non-empty playlist.
        """
        extra: dict = {"extract_flat": "in_playlist"}
        if self.name == "youtube":
            # Skip yt-dlp's auth check so a single-account YOUTUBE_COOKIE doesn't
            # 500 when expanding a different public channel's playlist/tab.
            extra["extractor_args"] = {"youtubetab": {"skip": ["authcheck"]}}
        info = self._extract_info(url, extra=extra)
        if info.get("_type") != "playlist":
            return None
        entries: list[dict] = []
        for entry in info.get("entries") or []:
            if not entry:
                continue
            entry_url = entry.get("url") or entry.get("webpage_url")
            if not entry_url:
                continue
            entries.append({
                "source_url": entry_url,
                "title": entry.get("title"),
                "external_id": entry.get("id"),
            })
        if not entries:
            return None
        return {
            "title": info.get("title"),
            "external_id": info.get("id"),
            "entries": entries,
        }

    def fetch_metadata(self, url: str) -> ContentMeta:
        info = self._extract_info(url)
        published = None
        ts = info.get("timestamp")
        if ts:
            published = datetime.fromtimestamp(ts, tz=UTC)
        elif info.get("upload_date"):
            published = datetime.strptime(info["upload_date"], "%Y%m%d").replace(
                tzinfo=UTC
            )
        return ContentMeta(
            title=info.get("title"),
            author=info.get("uploader") or info.get("channel"),
            description=info.get("description"),
            duration_s=int(info["duration"]) if info.get("duration") else None,
            published_at=published,
            thumbnail=info.get("thumbnail"),
            external_id=info.get("id"),
            view_count=info.get("view_count"),
            like_count=info.get("like_count"),
            dislike_count=info.get("dislike_count"),
            channel_id=info.get("channel_id") or info.get("uploader_id"),
        )

    def get_native_transcript(
        self, url: str, language: str | None = None
    ) -> NativeTranscript | None:
        info = self._extract_info(url)
        manual = info.get("subtitles") or {}
        # Drop machine-translated auto-captions (they carry tlang= in the URL):
        # we want the video's actual spoken language, not a translation.
        auto = self._drop_translations(info.get("automatic_captions") or {})

        # Selection priority: explicitly requested language, then the video's
        # own main language, then the configured preferred language (zh), then
        # English, then whatever is left.
        original = (info.get("language") or "").split("-")[0] or None
        prefs = [language, original, get_settings().preferred_language, "en"]

        lang, tracks = self._pick_language(manual, prefs)
        if tracks is None:
            lang, tracks = self._pick_language(auto, prefs)
        if tracks is None:
            return None

        segments = self._download_and_parse(tracks)
        if not segments:
            return None
        if self._is_mislabeled(lang, segments):
            # A track that claims to be Chinese but is actually a non-CJK
            # translation: better to transcribe the real spoken audio.
            logger.info(
                "native subtitle '%s' for %s is not in the expected language; "
                "falling back to audio transcription",
                lang,
                url,
            )
            return None
        return NativeTranscript(language=lang, segments=segments)

    def _pick_language(
        self, table: dict, prefs: list[str | None]
    ) -> tuple[str | None, list | None]:
        if not table:
            return None, None
        keys = list(table.keys())
        ordered: list[str] = []
        for pref in prefs:
            if pref:
                ordered += [k for k in keys if k.startswith(pref)]
        ordered += keys
        for key in dict.fromkeys(ordered):  # de-dupe, keep order
            if table.get(key):
                return key, table[key]
        return None, None

    def _drop_translations(self, table: dict) -> dict:
        """Keep only original (non-machine-translated) caption tracks."""
        out: dict = {}
        for key, tracks in table.items():
            originals = [t for t in tracks if "tlang=" not in (t.get("url") or "")]
            if originals:
                out[key] = originals
        return out

    def _is_mislabeled(self, lang: str | None, segments: list[dict]) -> bool:
        """True if a Chinese-tagged track is actually non-Chinese text."""
        preferred = get_settings().preferred_language
        if not lang or not preferred or not lang.startswith(preferred):
            return False
        if not preferred.startswith("zh"):
            return False
        sample = " ".join((s.get("text") or "") for s in segments[:60])
        cjk = sum(1 for ch in sample if "\u4e00" <= ch <= "\u9fff")
        latin = sum(1 for ch in sample if ch.isascii() and ch.isalpha())
        return cjk < latin * 0.2

    def _download_and_parse(self, tracks: list) -> list[dict]:
        # Prefer json3 (clean) then vtt.
        order = {"json3": 0, "vtt": 1, "srv3": 2, "srv1": 3}
        tracks_sorted = sorted(tracks, key=lambda t: order.get(t.get("ext", ""), 9))
        for track in tracks_sorted:
            ext = track.get("ext")
            track_url = track.get("url")
            if not track_url or ext not in ("json3", "vtt"):
                continue
            try:
                resp = httpx.get(track_url, timeout=30, follow_redirects=True)
                resp.raise_for_status()
                if ext == "json3":
                    segs = parse_json3(resp.text)
                else:
                    segs = parse_vtt(resp.text)
                if segs:
                    return segs
            except Exception:  # noqa: BLE001
                logger.warning("failed to fetch subtitle track ext=%s", ext, exc_info=True)
        return []

    def download_audio(
        self,
        url: str,
        dest_dir: Path,
        on_progress: Callable[[dict], None] | None = None,
    ) -> Path:
        dest_dir.mkdir(parents=True, exist_ok=True)
        outtmpl = str(dest_dir / "%(id)s.%(ext)s")
        # Try each configured proxy in turn (e.g. WARP SOCKS5 instances, then
        # `direct`), rotating to the next on any failure so a single blocked IP
        # doesn't fail the whole download. The proxy also flows into _ydl_opts
        # for the metadata/native calls earlier in the job (first candidate).
        candidates = _proxy_candidates()
        last_exc: Exception | None = None
        last_log = ""
        for index, proxy in enumerate(candidates):
            self._active_proxy = proxy
            logbuf = _CaptureLogger()
            try:
                return self._download_audio_once(url, dest_dir, outtmpl, logbuf, on_progress)
            except Exception as exc:  # noqa: BLE001 — rotate, then raise a rich error
                last_exc = exc
                last_log = logbuf.text()
                more = index + 1 < len(candidates)
                logger.warning(
                    "download_audio via proxy=%s failed (%s%s)%s",
                    proxy or "direct",
                    "risk-control: " if _is_risk_control(exc) else "",
                    exc,
                    "; rotating to next proxy" if more else "; no more proxies",
                )
                if more:
                    continue
                raise RuntimeError(self._download_error(exc, last_log)) from exc
        assert last_exc is not None
        raise RuntimeError(self._download_error(last_exc, last_log)) from last_exc

    def _download_error(self, exc: Exception, log_text: str) -> str:
        """Build a human-readable failure reason from yt-dlp's captured log
        (last few lines) + the exception, prefixing an IP-block hint when the
        cause looks like a bot wall / 403 / 412."""
        tail = [ln for ln in log_text.splitlines() if ln][-6:]
        detail = " | ".join(tail) if tail else str(exc)
        if _looks_ip_blocked(detail) or _is_risk_control(exc):
            return f"IP-block — set YT_DLP_PROXY / rotate WARP: {detail}"
        return detail

    def _download_audio_once(
        self,
        url: str,
        dest_dir: Path,
        outtmpl: str,
        logbuf: _CaptureLogger,
        on_progress: Callable[[dict], None] | None,
    ) -> Path:
        deadline_s = int(os.environ.get("DOWNLOAD_DEADLINE_S", "600"))
        start = time.monotonic()

        def hook(d: dict) -> None:
            if deadline_s and time.monotonic() - start > deadline_s:
                raise _DownloadDeadline(f"download exceeded {deadline_s}s")
            if on_progress:
                try:
                    on_progress(_map_progress(d))
                except _DownloadDeadline:
                    raise
                except Exception:  # noqa: BLE001 — never let reporting break the download
                    logger.debug("on_progress callback failed", exc_info=True)

        opts = self._ydl_opts({
            "skip_download": False,
            # Best *audio-only* track; if none exists fall back to the *smallest*
            # combined stream (worst) rather than a full (4K) video just to strip
            # its audio. We only transcribe speech, so the lowest quality is fine
            # and premium-gated HD video formats are irrelevant.
            "format": "bestaudio/worst",
            # A multi-part (分P) Bilibili video or a ?list= URL otherwise makes
            # yt-dlp iterate the whole set — touching premium-gated sibling parts
            # (the "1080P 高码率 ... premium member" noise) and returning a
            # playlist info dict that doesn't map to a single file. One item = one
            # video here, so download only the single requested video/part.
            "noplaylist": True,
            # A premium-only part has no free format; skip it instead of aborting
            # the whole download.
            "ignore_no_formats_error": True,
            "outtmpl": outtmpl,
            # 10MB HTTP chunks make large DASH audio reads robust against the
            # "Downloaded X, expected Y bytes" / read-timeout failures.
            "http_chunk_size": 10 * 1024 * 1024,
            "concurrent_fragment_downloads": 1,
            "continuedl": True,
            # Capture yt-dlp's own messages (incl. warnings) for the error reason.
            "logger": logbuf,
            "no_warnings": False,
            "progress_hooks": [hook],
        })
        with YoutubeDL(opts) as ydl:
            info = ydl.extract_info(url, download=True)
            # Even with noplaylist a multi-part URL can come back as a one-entry
            # playlist; unwrap to the downloaded entry so prepare_filename maps to
            # the real file (e.g. BVxxx_p2.m4a) instead of the playlist title.
            if info.get("_type") == "playlist":
                entries = [e for e in (info.get("entries") or []) if e]
                info = entries[0] if entries else info
            path = Path(ydl.prepare_filename(info))
        if path.exists():
            return path
        # Postprocessing may have changed the extension, or a part suffix shifted
        # the name. dest_dir is a fresh per-job temp dir holding only this
        # download, so fall back to the newest real media file in it.
        media = [
            p for p in dest_dir.iterdir()
            if p.is_file() and not p.name.endswith((".part", ".ytdl"))
        ]
        if media:
            return max(media, key=lambda p: p.stat().st_mtime)
        raise FileNotFoundError(f"downloaded audio not found for {url}")

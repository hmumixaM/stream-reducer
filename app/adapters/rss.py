"""Generic adapter: direct audio URLs or pages exposing og:audio / enclosure."""

from __future__ import annotations

import re
from pathlib import Path

import httpx

from app.adapters.base import Adapter, ContentMeta
from app.adapters.http_audio import download_url, looks_like_audio

_HEADERS = {"User-Agent": "Mozilla/5.0 stream-reduce"}
_META = re.compile(
    r'<meta[^>]+(?:property|name)=["\']og:([^"\']+)["\'][^>]+content=["\']([^"\']+)["\']',
    re.IGNORECASE,
)
_AUDIO_URL = re.compile(r'https?://[^"\']+\.(?:m4a|mp3|aac|wav|ogg)', re.IGNORECASE)


class GenericAdapter(Adapter):
    name = "rss"

    def __init__(self) -> None:
        self._cache: dict[str, dict] = {}

    def _resolve(self, url: str) -> dict:
        if url in self._cache:
            return self._cache[url]
        if looks_like_audio(url):
            # Direct audio (e.g. a podcast enclosure): no scrapeable metadata.
            # Leave title None so feed-provided metadata (title/description/date)
            # isn't clobbered by the audio file's name.
            result = {"title": None, "audio_url": url}
            self._cache[url] = result
            return result
        # Peek headers first: many podcast enclosures redirect and serve audio
        # without an audio file extension.
        with httpx.stream(
            "GET", url, headers=_HEADERS, follow_redirects=True, timeout=60
        ) as resp:
            resp.raise_for_status()
            ctype = resp.headers.get("content-type", "").lower()
            if ctype.startswith("audio") or "mpeg" in ctype or "octet-stream" in ctype:
                result = {"title": None, "audio_url": str(resp.url)}
                self._cache[url] = result
                return result
            html = resp.read().decode(resp.encoding or "utf-8", errors="replace")
        og = {k.lower(): v for k, v in _META.findall(html)}
        audio = og.get("audio")
        if not audio:
            m = _AUDIO_URL.search(html)
            audio = m.group(0) if m else None
        if not audio:
            raise ValueError(f"could not find audio for {url}")
        result = {
            "title": og.get("title"),
            "description": og.get("description"),
            "thumbnail": og.get("image"),
            "audio_url": audio,
        }
        self._cache[url] = result
        return result

    def fetch_metadata(self, url: str) -> ContentMeta:
        r = self._resolve(url)
        return ContentMeta(
            title=r.get("title"),
            description=r.get("description"),
            thumbnail=r.get("thumbnail"),
        )

    def download_audio(self, url: str, dest_dir: Path) -> Path:
        r = self._resolve(url)
        return download_url(r["audio_url"], dest_dir, r.get("title") or "episode")


class DirectAudioAdapter(Adapter):
    """Used for subscription items where the enclosure URL is already known."""

    name = "rss"

    def __init__(self, audio_url: str | None = None) -> None:
        self.audio_url = audio_url

    def fetch_metadata(self, url: str) -> ContentMeta:
        return ContentMeta(title=Path(url).stem)

    def download_audio(self, url: str, dest_dir: Path) -> Path:
        target = self.audio_url or url
        return download_url(target, dest_dir, Path(url).stem or "episode")

"""Xiaoyuzhou (小宇宙) adapter.

The site is a Next.js SPA, but single-episode pages are server-rendered with
Open Graph / __NEXT_DATA__ metadata that exposes the audio enclosure URL.
"""

from __future__ import annotations

import html as html_lib
import json
import re
from datetime import datetime
from pathlib import Path

import httpx

from app.adapters.base import Adapter, ContentMeta
from app.adapters.http_audio import download_url

_HEADERS = {
    "User-Agent": (
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 "
        "(KHTML, like Gecko) Chrome/124.0 Safari/537.36"
    )
}
_META = re.compile(
    r'<meta[^>]+property=["\']og:([^"\']+)["\'][^>]+content=["\']([^"\']+)["\']',
    re.IGNORECASE,
)
_AUDIO_URL = re.compile(r'https://[^"\']+\.(?:m4a|mp3|aac)', re.IGNORECASE)


def _episode_id(url: str) -> str | None:
    m = re.search(r"/episode/([0-9a-f]+)", url)
    return m.group(1) if m else None


def _podcast_id(url: str) -> str | None:
    m = re.search(r"/podcast/([0-9a-fA-F]+)", url)
    return m.group(1) if m else None


def _html_to_text(raw: str) -> str:
    """Flatten show-notes HTML into readable plain text with line breaks."""
    if not raw:
        return ""
    text = re.sub(r"(?i)<\s*(br|/p|/div|/figure|/li)\s*/?>", "\n", raw)
    text = re.sub(r"(?i)<\s*li[^>]*>", "- ", text)
    text = re.sub(r"<[^>]+>", "", text)
    text = html_lib.unescape(text)
    text = re.sub(r"[ \t]+\n", "\n", text)
    text = re.sub(r"\n{3,}", "\n\n", text)
    return text.strip()


class XiaoyuzhouAdapter(Adapter):
    name = "xiaoyuzhou"

    def __init__(self) -> None:
        self._cache: dict[str, dict] = {}

    def _resolve(self, url: str) -> dict:
        if url in self._cache:
            return self._cache[url]
        resp = httpx.get(url, headers=_HEADERS, follow_redirects=True, timeout=30)
        resp.raise_for_status()
        html = resp.text
        og = {k.lower(): v for k, v in _META.findall(html)}
        result: dict = {
            "title": og.get("title"),
            "description": og.get("description"),
            "thumbnail": og.get("image"),
            "audio_url": og.get("audio"),
            "external_id": _episode_id(url),
        }
        # The full show notes live in __NEXT_DATA__; merge them in (and use them
        # as the description, since og:description is heavily truncated).
        nxt = self._from_next_data(html)
        for key, value in nxt.items():
            if value and not result.get(key):
                result[key] = value
        if nxt.get("description"):
            result["description"] = nxt["description"]
        if not result["audio_url"]:
            m = _AUDIO_URL.search(html)
            if m:
                result["audio_url"] = m.group(0)
        if not result["audio_url"]:
            raise ValueError(f"could not resolve Xiaoyuzhou audio for {url}")
        self._cache[url] = result
        return result

    def _from_next_data(self, html: str) -> dict:
        m = re.search(
            r'<script id="__NEXT_DATA__"[^>]*>(.*?)</script>', html, re.DOTALL
        )
        if not m:
            return {}
        try:
            data = json.loads(m.group(1))
        except json.JSONDecodeError:
            return {}
        episode = _find_episode(data)
        if not episode:
            return {}
        enclosure = episode.get("enclosure") or {}
        published = None
        if episode.get("pubDate"):
            try:
                published = datetime.fromisoformat(
                    episode["pubDate"].replace("Z", "+00:00")
                )
            except ValueError:
                published = None
        # Prefer the full HTML show notes; fall back to the plain description.
        shownotes = _html_to_text(episode.get("shownotes") or "")
        description = shownotes or (episode.get("description") or "").strip() or None
        return {
            "title": episode.get("title"),
            "audio_url": enclosure.get("url"),
            "duration_s": episode.get("duration"),
            "author": (episode.get("podcast") or {}).get("title"),
            "published_at": published,
            "description": description,
            "view_count": episode.get("playCount"),
            "like_count": episode.get("clapCount"),
        }

    def extract_entries(self, url: str) -> dict | None:
        """Expand a Xiaoyuzhou *podcast* page into its episodes.

        The podcast page server-renders its most recent episodes inside
        `__NEXT_DATA__` (props.pageProps.podcast.episodes); deeper history is
        lazy-loaded behind an authenticated API, so this returns the recent
        batch (typically ~15-20). Returns None for episode pages or when no
        episodes are embedded.
        """
        if not _podcast_id(url) or _episode_id(url):
            return None
        resp = httpx.get(url, headers=_HEADERS, follow_redirects=True, timeout=30)
        resp.raise_for_status()
        m = re.search(
            r'<script id="__NEXT_DATA__"[^>]*>(.*?)</script>', resp.text, re.DOTALL
        )
        if not m:
            return None
        podcast = (
            json.loads(m.group(1))
            .get("props", {})
            .get("pageProps", {})
            .get("podcast", {})
        )
        episodes = podcast.get("episodes") or []
        entries = [
            {
                "source_url": f"https://www.xiaoyuzhoufm.com/episode/{ep['eid']}",
                "title": ep.get("title"),
            }
            for ep in episodes
            if ep.get("eid")
        ]
        if not entries:
            return None
        return {
            "external_id": podcast.get("pid") or _podcast_id(url),
            "title": podcast.get("title"),
            "entries": entries,
        }

    def fetch_metadata(self, url: str) -> ContentMeta:
        r = self._resolve(url)
        return ContentMeta(
            title=r.get("title"),
            author=r.get("author"),
            description=r.get("description"),
            duration_s=r.get("duration_s"),
            published_at=r.get("published_at"),
            thumbnail=r.get("thumbnail"),
            external_id=r.get("external_id"),
            view_count=r.get("view_count"),
            like_count=r.get("like_count"),
        )

    def download_audio(self, url: str, dest_dir: Path, on_progress=None) -> Path:
        r = self._resolve(url)
        return download_url(r["audio_url"], dest_dir, r.get("external_id") or "xyz_episode", on_progress)


def _find_episode(data: dict) -> dict | None:
    """Walk the Next.js data tree to find a dict that has an audio enclosure."""
    stack = [data]
    while stack:
        node = stack.pop()
        if isinstance(node, dict):
            enc = node.get("enclosure")
            if isinstance(enc, dict) and enc.get("url"):
                return node
            stack.extend(node.values())
        elif isinstance(node, list):
            stack.extend(node)
    return None

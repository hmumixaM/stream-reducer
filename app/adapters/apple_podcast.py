"""Apple Podcasts adapter: iTunes Lookup API -> episode audio URL."""

from __future__ import annotations

import re
from datetime import UTC, datetime
from email.utils import parsedate_to_datetime
from pathlib import Path
from urllib.parse import urlparse, urlunparse

import feedparser
import httpx

from app.adapters.base import Adapter, ContentMeta
from app.adapters.http_audio import download_url

ITUNES_LOOKUP = "https://itunes.apple.com/lookup"


def _parse_ids(url: str) -> tuple[str | None, str | None]:
    podcast_id = None
    episode_id = None
    m = re.search(r"/id(\d+)", url)
    if m:
        podcast_id = m.group(1)
    m = re.search(r"[?&]i=(\d+)", url)
    if m:
        episode_id = m.group(1)
    return podcast_id, episode_id


class ApplePodcastAdapter(Adapter):
    name = "apple_podcast"

    def __init__(self) -> None:
        self._cache: dict[str, dict] = {}

    def _resolve(self, url: str) -> dict:
        if url in self._cache:
            return self._cache[url]
        podcast_id, episode_id = _parse_ids(url)
        if episode_id:
            result = self._resolve_episode(podcast_id, episode_id)
        elif podcast_id:
            # Bare show URL (no episode): best-effort to the latest episode.
            result = self._resolve_via_feed(podcast_id, None)
        else:
            result = {}
        if not result.get("audio_url"):
            raise ValueError(f"could not resolve Apple Podcast audio for {url}")
        self._cache[url] = result
        return result

    def _resolve_episode(self, podcast_id: str | None, episode_id: str) -> dict:
        # 1. Direct episode lookup: rich metadata, but iTunes doesn't index every
        #    episode this way (some shows return zero results).
        resp = httpx.get(
            ITUNES_LOOKUP,
            params={"id": episode_id, "entity": "podcastEpisode"},
            timeout=30,
        )
        resp.raise_for_status()
        items = [r for r in resp.json().get("results", []) if r.get("episodeUrl")]
        if items:
            return _episode_result(items[0])
        # 2. Fall back to the show's episode list and match by trackId. The batch
        #    endpoint reliably includes the episode + its enclosure even when the
        #    per-episode lookup is empty. (We deliberately do NOT fall back to the
        #    feed's latest entry, which would summarize the wrong episode.)
        if podcast_id:
            resp = httpx.get(
                ITUNES_LOOKUP,
                params={"id": podcast_id, "entity": "podcastEpisode", "limit": 200},
                timeout=30,
            )
            resp.raise_for_status()
            for ep in resp.json().get("results", []):
                if str(ep.get("trackId")) == str(episode_id) and ep.get("episodeUrl"):
                    return _episode_result(ep)
        return {}

    def _resolve_via_feed(self, podcast_id: str, episode_id: str | None) -> dict:
        resp = httpx.get(ITUNES_LOOKUP, params={"id": podcast_id, "entity": "podcast"}, timeout=30)
        resp.raise_for_status()
        results = resp.json().get("results", [])
        feed_url = results[0].get("feedUrl") if results else None
        if not feed_url:
            return {}
        feed = feedparser.parse(feed_url)
        entry = feed.entries[0] if feed.entries else None
        if entry is None:
            return {}
        return _entry_to_result(entry)

    def extract_entries(self, url: str) -> dict | None:
        """Expand an Apple Podcasts *show* URL into all of its episodes.

        Uses the iTunes Lookup API (entity=podcastEpisode), which returns the
        show as the first result followed by its episodes. Each episode becomes
        a canonical `.../id<show>?i=<trackId>` URL so it resolves to full
        per-episode metadata + audio on processing. Returns None for episode
        URLs (those carry `?i=`) or shows with no episodes.
        """
        podcast_id, episode_id = _parse_ids(url)
        if not podcast_id or episode_id:
            return None
        resp = httpx.get(
            ITUNES_LOOKUP,
            params={"id": podcast_id, "entity": "podcastEpisode", "limit": 200},
            timeout=30,
        )
        resp.raise_for_status()
        results = resp.json().get("results", [])
        if not results:
            return None
        show = results[0]
        episodes = [r for r in results if r.get("kind") == "podcast-episode"]
        if not episodes:
            return None
        base = urlunparse(urlparse(url)._replace(query="", fragment=""))
        entries = [
            {"source_url": f"{base}?i={ep['trackId']}", "title": ep.get("trackName")}
            for ep in episodes
            if ep.get("trackId")
        ]
        return {
            "external_id": str(show.get("collectionId") or podcast_id),
            "title": show.get("collectionName") or show.get("trackName"),
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
        )

    def download_audio(self, url: str, dest_dir: Path, on_progress=None) -> Path:
        r = self._resolve(url)
        return download_url(r["audio_url"], dest_dir, r.get("external_id") or "apple_episode", on_progress)


def _episode_result(ep: dict) -> dict:
    """Build a resolved-episode dict from an iTunes podcastEpisode object."""
    return {
        "title": ep.get("trackName"),
        "author": ep.get("collectionName") or ep.get("artistName"),
        "description": ep.get("description") or ep.get("shortDescription"),
        "audio_url": ep.get("episodeUrl"),
        "thumbnail": ep.get("artworkUrl600") or ep.get("artworkUrl100"),
        "duration_s": int(ep["trackTimeMillis"] / 1000)
        if ep.get("trackTimeMillis")
        else None,
        "published_at": _parse_date(ep.get("releaseDate")),
        "external_id": str(ep.get("trackId")),
    }


def _parse_date(value: str | None) -> datetime | None:
    if not value:
        return None
    try:
        return datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError:
        try:
            return parsedate_to_datetime(value)
        except (TypeError, ValueError):
            return None


def _entry_to_result(entry) -> dict:
    audio_url = None
    for enc in getattr(entry, "enclosures", []) or []:
        if enc.get("href"):
            audio_url = enc["href"]
            break
    published = None
    if getattr(entry, "published_parsed", None):
        published = datetime(*entry.published_parsed[:6], tzinfo=UTC)
    return {
        "title": getattr(entry, "title", None),
        "author": getattr(entry, "author", None),
        "description": getattr(entry, "summary", None),
        "audio_url": audio_url,
        "thumbnail": None,
        "duration_s": None,
        "published_at": published,
        "external_id": getattr(entry, "id", None),
    }

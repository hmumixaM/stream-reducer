"""Platform detection and adapter factory."""

from __future__ import annotations

import re
from urllib.parse import parse_qsl, urlencode, urlparse, urlunparse

from app.adapters.apple_podcast import ApplePodcastAdapter
from app.adapters.base import Adapter
from app.adapters.bilibili import BilibiliAdapter
from app.adapters.rss import GenericAdapter
from app.adapters.xiaoyuzhou import XiaoyuzhouAdapter
from app.adapters.youtube import YouTubeAdapter
from app.models import Platform

# Query params that are pure tracking / navigation noise and break dedup.
_TRACKING_PARAMS = {
    "spm_id_from", "vd_source", "from_source", "from_spmid", "from", "spmid",
    "share_source", "share_medium", "share_plat", "share_session_id", "share_tag",
    "share_times", "unique_k", "buvid", "is_story_h5", "p_av_id", "bbid", "ts",
    "utm_source", "utm_medium", "utm_campaign", "utm_term", "utm_content",
    "feature", "ab_channel", "pp", "si", "gclid", "fbclid",
}
_BV_RE = re.compile(r"BV[0-9A-Za-z]{8,}")


def detect_platform(url: str) -> Platform:
    parsed = urlparse(url)
    host = (parsed.hostname or "").lower()
    if any(h in host for h in ("youtube.com", "youtu.be", "youtube-nocookie.com")):
        return Platform.youtube
    if "bilibili.com" in host or host == "b23.tv":
        return Platform.bilibili
    if "podcasts.apple.com" in host or "podcast.apple.com" in host:
        return Platform.apple_podcast
    if "xiaoyuzhoufm.com" in host:
        # Only episode/podcast *pages* use the scraping adapter. Direct audio
        # track URLs (e.g. dts-api.xiaoyuzhoufm.com/track/.../media.xyzcdn.net/x.m4a,
        # common in podcast RSS enclosures) are plain audio — download directly.
        if "/episode/" in parsed.path or "/podcast/" in parsed.path:
            return Platform.xiaoyuzhou
        return Platform.rss
    return Platform.rss


def normalize_url(url: str) -> str:
    """Canonicalize a URL so the same video isn't ingested twice.

    YouTube -> https://www.youtube.com/watch?v=<id>
    Bilibili -> https://www.bilibili.com/video/<BV...>
    Others   -> drop tracking params + fragment, keep meaningful ones.
    """
    url = (url or "").strip()
    if not url:
        return url
    parsed = urlparse(url)
    host = (parsed.hostname or "").lower()
    platform = detect_platform(url)

    if platform == Platform.youtube:
        vid = ""
        if host.endswith("youtu.be"):
            vid = parsed.path.strip("/").split("/")[0]
        elif "/shorts/" in parsed.path:
            vid = parsed.path.split("/shorts/")[1].split("/")[0]
        elif "/embed/" in parsed.path:
            vid = parsed.path.split("/embed/")[1].split("/")[0]
        else:
            vid = dict(parse_qsl(parsed.query)).get("v", "")
        if vid:
            return f"https://www.youtube.com/watch?v={vid}"

    if platform == Platform.bilibili:
        m = _BV_RE.search(parsed.path) or _BV_RE.search(url)
        if m:
            return f"https://www.bilibili.com/video/{m.group(0)}"

    pairs = [
        (k, v) for k, v in parse_qsl(parsed.query) if k.lower() not in _TRACKING_PARAMS
    ]
    cleaned = parsed._replace(query=urlencode(pairs), fragment="")
    return urlunparse(cleaned)


_ADAPTERS = {
    Platform.youtube: YouTubeAdapter,
    Platform.bilibili: BilibiliAdapter,
    Platform.apple_podcast: ApplePodcastAdapter,
    Platform.xiaoyuzhou: XiaoyuzhouAdapter,
    Platform.rss: GenericAdapter,
    Platform.unknown: GenericAdapter,
}


def get_adapter(platform: Platform) -> Adapter:
    return _ADAPTERS.get(platform, GenericAdapter)()

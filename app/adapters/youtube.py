"""YouTube adapter (yt-dlp)."""

from __future__ import annotations

from app.adapters.ytdlp_base import YtDlpAdapter


class YouTubeAdapter(YtDlpAdapter):
    name = "youtube"
    # Logged-in cookies let yt-dlp past YouTube's "Sign in to confirm you're not
    # a bot" wall and age/region gates. Reuse the same pattern as Bilibili: the
    # Worker injects a "name=value; …" cookie header (YOUTUBE_COOKIE secret) into
    # the container, materialized into a Netscape cookie file. A mounted
    # /cookies file or YT_DLP_COOKIES_FILE still wins over this when present.
    cookie_env = "YOUTUBE_COOKIE"
    cookie_domain = ".youtube.com"

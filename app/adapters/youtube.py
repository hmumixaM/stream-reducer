"""YouTube adapter (yt-dlp)."""

from __future__ import annotations

import os

from app.adapters.ytdlp_base import YtDlpAdapter


class YouTubeAdapter(YtDlpAdapter):
    name = "youtube"
    prefer_direct_egress = True
    rotate_authenticated_egress = True
    # Logged-in cookies let yt-dlp past YouTube's "Sign in to confirm you're not
    # a bot" wall and age/region gates. Reuse the same pattern as Bilibili: the
    # Worker injects a "name=value; …" cookie header (YOUTUBE_COOKIE secret) into
    # the container, materialized into a Netscape cookie file. A mounted
    # /cookies file or YT_DLP_COOKIES_FILE still wins over this when present.
    cookie_env = "YOUTUBE_COOKIE"
    cookie_domain = ".youtube.com"

    def _should_use_cookies(self, proxy: str | None) -> bool:
        """Never expose the signed-in account to datacenter or WARP egress.

        YouTube can lock an account when the same cookies jump between distant
        IPs. Once a residential Tailscale fallback is configured, authenticate
        only through that stable home IP; unsigned direct requests remain the
        cheap/default path for public videos.
        """
        residential = os.environ.get("RESIDENTIAL_PROXY_URL", "").strip()
        return not residential or proxy == residential

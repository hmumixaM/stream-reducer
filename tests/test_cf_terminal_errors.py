"""Which download failures are permanent, and therefore must not be retried."""

from __future__ import annotations

import sys
from pathlib import Path

import pytest

# The container runs with cf/pipeline as its root, so the module imports its
# siblings flatly ("import llm"). Reproduce that layout to import it here.
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "cf" / "pipeline"))

from pipeline import _is_gone, _is_members_only  # noqa: E402


@pytest.mark.parametrize(
    "message",
    [
        "DownloadError: ERROR: [BiliBili] 19dZEYhEt7: This video may be deleted or geo-restricted.",
        "ERROR: [youtube] abc: Video unavailable",
        "ERROR: [youtube] abc: Private video. Sign in if you've been granted access",
        "ERROR: unable to download webpage: HTTP Error 404: Not Found",
        "接口返回：啥都木有",
    ],
)
def test_gone_sources_are_terminal(message):
    assert _is_gone(message)


@pytest.mark.parametrize(
    "message",
    [
        # Worth another attempt: the source is fine, the run was not.
        "ERROR: [BiliBili] 1zK4y1F7pk: Unable to extract initial state",
        "DownloadError: HTTP Error 412: Precondition Failed",
        "ReadTimeout: The read operation timed out",
        "Container suddenly disconnected, try again",
    ],
)
def test_transient_failures_stay_retryable(message):
    assert not _is_gone(message)
    assert not _is_members_only(message)


def test_age_gated_is_terminal():
    from pipeline import _is_age_gated

    assert _is_age_gated(
        "DownloadError: ERROR: [youtube] 5rgrlsPibCA: Sign in to confirm your age."
    )
    assert not _is_age_gated("Sign in to confirm you're not a bot")


def test_paid_content_is_still_terminal():
    assert _is_members_only("ERROR: [BiliBili] xyz: 该视频为充电专属视频")

"""Regression tests for partial map-summary detection."""

from app.pipeline.summary_quality import map_notes_issue


def _source(end_minute: int = 12) -> str:
    return "\n".join(
        f"[{minute:02d}:00] source content at minute {minute} " + "detail " * 80
        for minute in range(end_minute + 1)
    )


def test_rejects_short_nonempty_map_response() -> None:
    issue = map_notes_issue("### [00:00] Introduction\nA short fragment.", _source())
    assert issue is not None
    assert "chars" in issue


def test_rejects_substantial_but_disproportionately_short_response() -> None:
    notes = "### [00:00] Introduction\n" + "Opening material. " * 60
    issue = map_notes_issue(notes, _source())
    assert issue is not None
    assert "chars" in issue


def test_accepts_long_map_response_without_a_late_heading() -> None:
    notes = (
        "### [00:00] Introduction\n"
        + "Detailed opening discussion. " * 80
        + "\n### [01:00] First idea\n"
        + "More detail. " * 80
    )
    assert map_notes_issue(notes, _source()) is None


def test_accepts_map_response_with_multiple_source_topics() -> None:
    notes = (
        "### [00:00] Introduction\n"
        + "Detailed opening discussion. " * 80
        + "\n### [10:00] Conclusion\n"
        + "Detailed concluding discussion. " * 80
    )
    assert map_notes_issue(notes, _source()) is None

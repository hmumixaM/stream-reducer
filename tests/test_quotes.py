"""Quote verification and review merging (no network)."""

from __future__ import annotations

from app.pipeline.prompts import QUOTE_REVIEW_TEMPLATE, QUOTES_ENTITIES_TEMPLATE, REDUCE_TEMPLATE
from app.pipeline.quotes import apply_review, format_candidates, quote_weight, verified_quotes

NOTES = (
    "### [05:00] 算力与电力\n\n"
    "主持人认为美国电网老化严重。他直言“算力的尽头是电力，芯片领先不代表 AI 领先”，"
    "又调侃“草包”一词。嘉宾回忆：“每小时都会有东西坏掉好几次。”\n"
    'The guest added, "If deploying scares you, you will deploy less."\n'
)


def test_weight_separates_claims_from_labels():
    assert quote_weight("草包") < 10
    assert quote_weight("Amazing") < 10
    assert quote_weight("早就 game over 了") < 10
    assert quote_weight("Move fast and break things") >= 10
    assert quote_weight("习近平是中国最大的对台鸽派") >= 10


def test_keeps_only_text_inside_quotation_marks():
    kept = verified_quotes(
        [
            {"text": "算力的尽头是电力，芯片领先不代表 AI 领先", "speaker": "主持人", "claim": "x"},
            {"text": "主持人认为美国电网老化严重。"},  # narration
            {"text": "草包"},  # inside quotes but a label
            {"text": "If deploying scares you, you will deploy less."},
            {"text": "算力的尽头就是电力，芯片领先不等于 AI 领先"},  # reworded
        ],
        NOTES,
    )
    assert [q["text"] for q in kept] == [
        "算力的尽头是电力，芯片领先不代表 AI 领先",
        "If deploying scares you, you will deploy less.",
    ]
    assert kept[0]["claim"] == "x"


def test_tolerates_punctuation_drift_and_wrapping_quotes():
    kept = verified_quotes([{"text": "“每小时都会有东西坏掉好几次”"}], NOTES)
    assert kept == [{"text": "每小时都会有东西坏掉好几次"}]


def test_drops_duplicates_and_contained_excerpts():
    kept = verified_quotes(
        [
            {"text": "算力的尽头是电力，芯片领先不代表 AI 领先"},
            {"text": "算力的尽头是电力，芯片领先不代表AI领先。"},
            {"text": "芯片领先不代表 AI 领先"},
        ],
        NOTES,
    )
    assert len(kept) == 1


def test_review_order_limit_and_trimming():
    cands = [
        {"text": "所以说，算力的尽头是电力，芯片领先不代表 AI 领先", "timestamp": 300, "speaker": "A", "claim": "c"},
        {"text": "If deploying scares you, you will deploy less.", "timestamp": 310, "speaker": None},
        {"text": "每小时都会有东西坏掉好几次", "timestamp": 320, "speaker": "B"},
    ]
    picks = [
        {"id": 2, "text": "If deploying scares you, you will deploy less."},
        {"id": 1, "text": "算力的尽头是电力，芯片领先不代表 AI 领先"},
        {"id": 1, "text": "dup"},
        {"id": 9},
        {"id": 3, "text": "a reworded version that is not in the candidate"},
    ]
    out = apply_review(cands, picks, limit=3)
    assert out == [
        {"text": "If deploying scares you, you will deploy less.", "timestamp": 310, "speaker": None},
        {"text": "算力的尽头是电力，芯片领先不代表 AI 领先", "timestamp": 300, "speaker": "A"},
        {"text": "每小时都会有东西坏掉好几次", "timestamp": 320, "speaker": "B"},
    ]
    assert len(apply_review(cands, picks, limit=1)) == 1
    assert apply_review(cands, []) == []


def test_review_drops_quotes_too_long_to_print_unless_trimmed():
    long_text = "这一句话非常长而且一直在讲，" * 9
    cands = [{"text": long_text, "timestamp": 1, "speaker": None}]
    assert apply_review(cands, [{"id": 1, "text": long_text}]) == []
    trimmed = apply_review(cands, [{"id": 1, "text": "这一句话非常长而且一直在讲"}])
    assert trimmed == [{"text": "这一句话非常长而且一直在讲", "timestamp": 1, "speaker": None}]


def test_candidates_render_with_numbers_and_points():
    text = format_candidates([{"text": "q one", "speaker": "A", "claim": "point"}, {"text": "q two"}])
    assert text == "[1] “q one” — A\n    Speaker's point: point\n[2] “q two”"


def test_templates_format_cleanly():
    QUOTES_ENTITIES_TEMPLATE.format(context="c", source="s", language_instruction="l")
    QUOTE_REVIEW_TEMPLATE.format(context="c", candidates="[1] “q”", limit=8)
    REDUCE_TEMPLATE.format(context="c", notes="n", language_instruction="l")

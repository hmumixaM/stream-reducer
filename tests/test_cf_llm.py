"""Regression tests for the container's Gemini response validation."""

from __future__ import annotations

import httpx
import pytest

from cf.pipeline import llm


def _response(content: object) -> dict:
    return {
        "choices": [{"message": {"content": content}}],
        "usage": {"total_tokens": 1},
    }


@pytest.mark.parametrize(
    "content",
    [
        "",
        "   \n",
        "Gemini returns no response",
        "⚠️ Upstream Gemini returned an empty response. Google may be blocking the egress IP.",
    ],
)
def test_rejects_empty_or_diagnostic_chat_content(content: str) -> None:
    with pytest.raises(httpx.RemoteProtocolError):
        llm._validated_chat_content(_response(content), "primary")


def test_rejects_malformed_chat_response() -> None:
    with pytest.raises(httpx.RemoteProtocolError):
        llm._validated_chat_content({"choices": []}, "primary")


def test_accepts_real_content_that_mentions_no_response() -> None:
    text = "The insulin-resistant cell produces no response to the initial signal."
    assert llm._validated_chat_content(_response(text), "primary") == text


def test_generate_text_falls_back_after_unusable_primary(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("GEMINI_API_KEY", "test")
    monkeypatch.setenv("GEMINI_MODEL", "primary")
    monkeypatch.setenv("GEMINI_MODEL_FALLBACK", "fallback")
    calls: list[str] = []

    def fake_chat(
        model: str,
        messages: list[dict],
        temperature: float,
        max_tokens: int | None,
        key: str,
    ) -> llm.LlmResult:
        calls.append(model)
        if model == "primary":
            raise httpx.RemoteProtocolError("empty")
        return llm.LlmResult(text="usable summary")

    monkeypatch.setattr(llm, "_chat_once", fake_chat)
    assert llm.generate_text("prompt").text == "usable summary"
    assert calls == ["primary", "fallback"]

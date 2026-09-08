"""RightCode Draw API behavior for Cloudflare pipeline infographics."""

from __future__ import annotations

import base64
import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "cf" / "pipeline"))

import llm  # noqa: E402


class FakeResponse:
    def __init__(
        self,
        payload: dict | None = None,
        *,
        content: bytes = b"",
        content_type: str = "application/json",
    ):
        self.payload = payload
        self.content = content
        self.headers = {"content-type": content_type}

    def raise_for_status(self) -> None:
        return None

    def json(self) -> dict:
        assert self.payload is not None
        return self.payload


class FakeClient:
    submitted: dict

    def __init__(self, **_kwargs):
        self.poll_count = 0

    def __enter__(self):
        return self

    def __exit__(self, *_args):
        return None

    def post(self, url: str, *, json: dict) -> FakeResponse:
        assert url == "https://www.rightapi.ai/draw/v1/images/generations"
        FakeClient.submitted = json
        return FakeResponse({"task_id": "task-1", "status": "processing"})

    def get(self, url: str) -> FakeResponse:
        if url == "https://www.rightapi.ai/v1/tasks/task-1":
            self.poll_count += 1
            if self.poll_count == 1:
                return FakeResponse({"task_id": "task-1", "status": "processing"})
            return FakeResponse(
                {
                    "task_id": "task-1",
                    "status": "completed",
                    "data": [{"url": "https://image.example/poster.png"}],
                }
            )
        assert url == "https://image.example/poster.png"
        return FakeResponse(content=b"poster", content_type="image/png")


def test_generate_image_uses_rightcode_vip_4k(monkeypatch: pytest.MonkeyPatch):
    monkeypatch.setenv("RIGHTCODE_API_KEY", "test-key")
    monkeypatch.setattr(llm.httpx, "Client", FakeClient)
    monkeypatch.setattr(llm.time, "sleep", lambda _seconds: None)

    result = llm.generate_image("article facts", system="design rules")

    assert FakeClient.submitted == {
        "model": "gpt-image-2-vip",
        "prompt": "design rules\n\narticle facts",
        "n": 1,
        "size": "16:9",
        "imageSize": "4K",
        "async": True,
    }
    assert base64.b64decode(result.image_b64) == b"poster"
    assert result.mime_type == "image/png"
    assert result.model == "gpt-image-2-vip"
    assert result.total_tokens == 0
    assert result.cost_usd == 0.13


def test_image_task_failure_is_reported(monkeypatch: pytest.MonkeyPatch):
    class FailedClient(FakeClient):
        def get(self, url: str) -> FakeResponse:
            assert url == "https://www.rightapi.ai/v1/tasks/task-1"
            return FakeResponse(
                {
                    "task_id": "task-1",
                    "status": "failed",
                    "error": {"message": "provider rejected request"},
                }
            )

    monkeypatch.setenv("RIGHTCODE_API_KEY", "test-key")
    monkeypatch.setattr(llm.httpx, "Client", FailedClient)
    monkeypatch.setattr(llm.time, "sleep", lambda _seconds: None)

    with pytest.raises(RuntimeError, match="provider rejected request"):
        llm.generate_image("article facts")

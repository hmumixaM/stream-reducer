"""Oracle service boundary: auth, resumable uploads, integrity and restart recovery."""

import hashlib
import importlib.util
import socket
import subprocess
import sys
import threading
from pathlib import Path

import httpx
import pytest

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "cf" / "pipeline"))
import audio_offload as client_module  # noqa: E402

spec = importlib.util.spec_from_file_location("audio_service", ROOT / "cf/audio/service.py")
service = importlib.util.module_from_spec(spec)
spec.loader.exec_module(service)


@pytest.fixture
def api(tmp_path, monkeypatch):
    monkeypatch.setattr(service, "ROOT", tmp_path / "data")
    monkeypatch.setattr(service, "TOKEN", "x" * 48)
    service.recover()
    server = service.Server(("127.0.0.1", 0), service.Handler)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    with httpx.Client(
        base_url=f"http://127.0.0.1:{server.server_port}",
        headers={"Authorization": "Bearer " + "x" * 48},
    ) as client:
        yield client
    server.shutdown()
    server.server_close()


def register(api, data, seconds=30):
    return api.post(
        "/jobs",
        json={
            "sha256": hashlib.sha256(data).hexdigest(),
            "bytes": len(data),
            "chunk_seconds": seconds,
        },
    ).json()


def test_auth_and_path_boundary(api):
    assert api.get("/health", headers={"Authorization": "bad"}).status_code == 401
    assert api.get("/health").status_code == 200
    assert api.get("/jobs/../../etc/passwd").status_code == 404
    assert (
        api.post("/jobs", json={"sha256": "../../etc", "bytes": 1, "chunk_seconds": 30}).status_code
        == 400
    )
    assert (
        api.post(
            "/jobs", json={"sha256": "a" * 64, "bytes": service.MAX_BYTES + 1, "chunk_seconds": 30}
        ).status_code
        == 413
    )


def test_resume_integrity_and_restart(api):
    data = b"valid input"
    job = register(api, data)
    path = "/jobs/" + job["id"]
    assert api.post(path + "/submit", content=b"").status_code == 409
    assert api.put(path + "/parts/0", content=b"bad").status_code == 400
    assert api.put(path + "/parts/0", content=b"x" * len(data)).status_code == 200
    assert api.post(path + "/submit", content=b"").status_code == 409
    assert api.put(path + "/parts/0", content=data).status_code == 200
    assert register(api, data)["uploaded_parts"] == [0]
    assert api.post(path + "/submit", content=b"").json()["status"] == "queued"
    folder = service.ROOT / job["id"]
    state = service.load(folder)
    state["status"] = "processing"
    service.save(folder, state)
    service.recover()
    assert service.load(folder)["status"] == "queued"
    # Duplicate submission and creation preserve the existing job/input.
    assert register(api, data)["id"] == job["id"]
    assert api.post(path + "/submit", content=b"").status_code == 200


def test_real_transcode_and_download(api, tmp_path):
    tone = tmp_path / "tone.wav"
    subprocess.run(
        ["ffmpeg", "-v", "error", "-f", "lavfi", "-i", "sine=frequency=440:duration=65", str(tone)],
        check=True,
    )
    data = tone.read_bytes()
    job = register(api, data)
    path = "/jobs/" + job["id"]
    api.put(path + "/parts/0", content=data).raise_for_status()
    api.post(path + "/submit", content=b"").raise_for_status()
    service.encode(service.ROOT / job["id"])
    result = api.get(path).json()
    assert result["status"] == "done", result
    assert len(result["chunks"]) == 3
    assert abs(sum(c["duration_s"] for c in result["chunks"]) - 65) < 1
    for chunk in result["chunks"]:
        audio = api.get(path + "/" + chunk["name"]).content
        assert hashlib.sha256(audio).hexdigest() == chunk["sha256"]
    assert api.get(path + "/chunk_9999.mp3").status_code == 404


def test_client_uses_remote_and_never_local_ffmpeg(api, monkeypatch, tmp_path):
    data = b"fake audio"
    output = b"fake chunk"
    sha = hashlib.sha256(output).hexdigest()
    calls = []

    def handle(request):
        calls.append((request.method, request.url.path))
        assert request.headers["Authorization"] == "Bearer secret"
        if request.url.path == "/jobs":
            value = {"id": "a" * 64, "status": "uploading", "uploaded_parts": []}
        elif request.method == "PUT":
            assert request.content == data
            value = {"ok": True}
        elif request.url.path.endswith("submit"):
            value = {
                "status": "done",
                "chunks": [{"name": "chunk_0000.mp3", "bytes": len(output), "sha256": sha}],
            }
        else:
            return httpx.Response(200, content=output)
        return httpx.Response(200, json=value)

    real_client = httpx.Client
    monkeypatch.setenv("AUDIO_OFFLOAD_URL", "https://audio.example")
    monkeypatch.setenv("AUDIO_OFFLOAD_TOKEN", "secret")
    monkeypatch.setattr(
        client_module.httpx,
        "Client",
        lambda **kw: real_client(transport=httpx.MockTransport(handle), **kw),
    )
    source = tmp_path / "input"
    source.write_bytes(data)
    chunks = client_module.split_audio(source, 300, tmp_path / "chunks")
    assert chunks[0].read_bytes() == output
    assert len(calls) == 4


def test_outage_is_retryable_without_fallback(monkeypatch, tmp_path):
    monkeypatch.setenv("AUDIO_OFFLOAD_URL", "https://audio.example")
    monkeypatch.setenv("AUDIO_OFFLOAD_TOKEN", "secret")
    real_client = httpx.Client
    monkeypatch.setattr(
        client_module.httpx,
        "Client",
        lambda **kw: real_client(
            transport=httpx.MockTransport(lambda _: httpx.Response(503)), **kw
        ),
    )
    monkeypatch.setattr(client_module.time, "sleep", lambda _: None)
    source = tmp_path / "input"
    source.write_bytes(b"audio")
    with pytest.raises(client_module.OracleAudioUnavailable, match="oracle audio unavailable:"):
        client_module.split_audio(source, 300, tmp_path / "chunks")


def test_invalid_media_never_returns_partial_success(api):
    data = b"not an audio file"
    job = register(api, data)
    path = "/jobs/" + job["id"]
    api.put(path + "/parts/0", content=data).raise_for_status()
    api.post(path + "/submit", content=b"").raise_for_status()
    for _ in range(3):
        service.encode(service.ROOT / job["id"])
    state = api.get(path).json()
    assert state["status"] == "failed"
    assert state["attempts"] == 3
    assert "chunks" not in state


def test_slow_upload_does_not_block_other_jobs_or_progress(api, monkeypatch):
    reading = threading.Event()
    original_body = service.Handler.body

    def observed_body(handler, maximum):
        if maximum == service.PART_BYTES:
            reading.set()
        return original_body(handler, maximum)

    monkeypatch.setattr(service.Handler, "body", observed_body)
    job = register(api, b"1234567890")
    path = "/jobs/" + job["id"]
    address = api.base_url
    sock = socket.create_connection((address.host, address.port), timeout=2)
    try:
        headers = (
            f"PUT {path}/parts/0 HTTP/1.0\r\nHost: localhost\r\n"
            f"Authorization: Bearer {'x' * 48}\r\nContent-Length: 10\r\n\r\n1"
        )
        sock.sendall(headers.encode())
        assert reading.wait(2)
        # The original implementation timed out here: receiving the other nine
        # bytes held LOCK, so every other job and the encoders stopped as well.
        assert api.get(path, timeout=1).status_code == 200
        other = register(api, b"different audio")
        assert other["status"] == "uploading"
        api.put("/jobs/" + other["id"] + "/parts/0", content=b"different audio").raise_for_status()
        assert api.get("/jobs/" + other["id"], timeout=1).json()["uploaded_parts"] == [0]
        sock.sendall(b"234567890")
        assert b"200" in sock.recv(4096)
    finally:
        sock.close()


@pytest.mark.parametrize("missing_segment", [False, True])
def test_estimated_duration_and_decoded_coverage(api, tmp_path, monkeypatch, missing_segment):
    tone = tmp_path / 'estimated.wav'
    subprocess.run(['ffmpeg', '-v', 'error', '-f', 'lavfi', '-i', 'sine=duration=65', str(tone)], check=True)
    data = tone.read_bytes()
    job = register(api, data)
    path = '/jobs/' + job['id']
    api.put(path + '/parts/0', content=data).raise_for_status()
    api.post(path + '/submit', content=b'').raise_for_status()
    actual_probe = service.probe
    def reported_duration(p):
        if p.name == 'input':
            return 62  # Simulate an inaccurate source MP3 duration.
        if missing_segment and p.name == 'chunk_0001.mp3':
            return 1
        return actual_probe(p)

    monkeypatch.setattr(service, 'probe', reported_duration)
    service.encode(service.ROOT / job['id'])
    result = api.get(path).json()
    if missing_segment:
        assert result['status'] == 'queued', result
        assert result['error'] == 'ValueError'
        return
    assert result['status'] == 'done', result
    assert abs(result['duration_s'] - 65) < 0.2
    assert len(result['chunks']) == 3


def test_decoder_timeline_requires_complete_eof(tmp_path):
    progress = tmp_path / 'progress'
    progress.write_text('out_time_us=65000000\nprogress=continue\n')
    with pytest.raises(ValueError, match='did not complete'):
        service.decoded_duration(progress)
    progress.write_text('out_time_us=0\nprogress=end\n')
    with pytest.raises(ValueError, match='unsupported decoded'):
        service.decoded_duration(progress)

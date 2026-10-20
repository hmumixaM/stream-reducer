import httpx
import pytest

from app.adapters.http_audio import download_url


def test_podcast_download_identifies_client_and_follows_audio_redirect(monkeypatch, tmp_path):
    def handler(request):
        if not request.headers.get('user-agent', '').startswith('Mozilla/5.0'):
            return httpx.Response(403)
        if request.url.host == 'podcast.example':
            return httpx.Response(302, headers={'location': 'https://audio.example/recording'})
        return httpx.Response(200, headers={'content-type': 'audio/mpeg'}, content=b'podcast audio')

    with httpx.Client(transport=httpx.MockTransport(handler)) as client:
        monkeypatch.setattr(httpx, 'stream', client.stream)
        path = download_url('https://podcast.example/episode.mp3', tmp_path, 'episode')
    assert path == tmp_path / 'episode.mp3'
    assert path.read_bytes() == b'podcast audio'


def test_unavailable_audio_still_fails_without_saving_error_body(monkeypatch, tmp_path):
    with httpx.Client(transport=httpx.MockTransport(lambda _: httpx.Response(403, content=b'blocked'))) as client:
        monkeypatch.setattr(httpx, 'stream', client.stream)
        with pytest.raises(httpx.HTTPStatusError):
            download_url('https://podcast.example/episode.mp3', tmp_path, 'episode')
    assert not list(tmp_path.iterdir())

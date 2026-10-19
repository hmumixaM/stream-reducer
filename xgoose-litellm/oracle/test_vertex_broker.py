"""Security boundary tests; dummy credentials only, no Google requests."""
import http.client
import json
import threading
import unittest
from unittest.mock import patch

from vertex_broker import RIGHTCODE_UPSTREAM, UPSTREAM, VertexRelay


class Credentials:
    valid = True
    token = "dummy-google-access-token-never-return"


class Response:
    status_code = 200
    def __enter__(self):
        return self
    def __exit__(self, *_args):
        pass
    def iter_content(self, **_kwargs):
        yield b'{"choices":[{"message":{"content":"ok"}}]}'


class RelayTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.server = VertexRelay(("127.0.0.1", 0), "relay-secret-for-tests", Credentials(), "dummy-rightcode-key")
        cls.thread = threading.Thread(target=cls.server.serve_forever, daemon=True)
        cls.thread.start()

    @classmethod
    def tearDownClass(cls):
        cls.server.shutdown()
        cls.server.server_close()
        cls.thread.join()

    def request(self, path="/v1/chat/completions", key="relay-secret-for-tests", payload=None):
        body = json.dumps(payload or {"model": "google/gemini-3.8-flash", "messages": [{"role": "user", "content": "hello"}]})
        conn = http.client.HTTPConnection(*self.server.server_address, timeout=5)
        conn.request("POST", path, body, {"Authorization": "Bearer " + key, "Content-Type": "application/json"})
        response = conn.getresponse()
        status, data = response.status, response.read()
        conn.close()
        self.assertNotIn(Credentials.token.encode(), data)
        return status, data

    @patch("vertex_broker.requests.Session.post", return_value=Response())
    def test_unauthorized_request_never_contacts_google(self, post):
        self.assertEqual(self.request(key="wrong")[0], 401)
        post.assert_not_called()

    @patch("vertex_broker.requests.Session.post", return_value=Response())
    def test_no_file_token_or_admin_routes(self, post):
        for path in ["/run/secrets/vertex-adc.json", "/v1/../../run/secrets/vertex-adc.json", "/token", "/config", "/v1/chat/completions?url=https://evil.invalid"]:
            self.assertEqual(self.request(path=path)[0], 404)
        post.assert_not_called()

    @patch("vertex_broker.requests.Session.post", return_value=Response())
    def test_cannot_override_destination_or_credentials(self, post):
        for field in ["api_base", "vertex_credentials", "api_key", "tools"]:
            payload = {"model": "google/gemini-3.8-flash", "messages": [{"role": "user", "content": "hello"}], field: "https://evil.invalid"}
            self.assertEqual(self.request(payload=payload)[0], 400)
        post.assert_not_called()

    @patch("vertex_broker.requests.Session.post", return_value=Response())
    def test_fixed_model_allowlist_and_text_only(self, post):
        for model, content in [("google/other-model", "hello"), ("google/gemini-3.8-flash", [{"type": "image_url", "image_url": {"url": "http://169.254.169.254/"}}])]:
            self.assertEqual(self.request(payload={"model": model, "messages": [{"role": "user", "content": content}]})[0], 400)
        post.assert_not_called()

    @patch("vertex_broker.requests.Session.post", return_value=Response())
    def test_token_only_sent_to_fixed_google_endpoint(self, post):
        status, data = self.request()
        self.assertEqual(status, 200)
        self.assertIn(b'"ok"', data)
        self.assertEqual(post.call_args.args, (UPSTREAM,))
        self.assertFalse(post.call_args.kwargs["allow_redirects"])
        self.assertEqual(post.call_args.kwargs["headers"]["Authorization"], "Bearer " + Credentials.token)

    @patch("vertex_broker.requests.Session.post", return_value=Response())
    def test_legacy_user_attribution_does_not_break_provider_calls(self, post):
        status, _data = self.request(payload={"model": "google/gemini-3.8-flash", "messages": [{"role": "user", "content": "hello"}], "user": "existing-user"})
        self.assertEqual(status, 200)
        self.assertNotIn("user", post.call_args.kwargs["json"])

    @patch("vertex_broker.requests.Session.post", side_effect=RuntimeError(Credentials.token))
    def test_exception_details_are_not_returned(self, _post):
        status, data = self.request()
        self.assertEqual(status, 502)
        self.assertIn(b"temporarily unavailable", data)

    @patch("vertex_broker.requests.Session.post", return_value=Response())
    def test_google_token_never_sent_to_fallback_provider(self, post):
        status, _data = self.request(path="/rightcode/v1/chat/completions", payload={"model": "gemini-3.8-flash", "messages": [{"role": "user", "content": "hello"}]})
        self.assertEqual(status, 200)
        self.assertEqual(post.call_args.args, (RIGHTCODE_UPSTREAM,))
        self.assertEqual(post.call_args.kwargs["headers"]["Authorization"], "Bearer dummy-rightcode-key")

    @patch("vertex_broker.requests.Session.post", return_value=Response())
    def test_provider_error_body_is_never_forwarded(self, post):
        post.return_value.status_code = 403
        post.return_value.text = Credentials.token
        try:
            status, body = self.request()
            self.assertEqual(status, 502)
            self.assertIn(b"Provider request failed", body)
        finally:
            post.return_value.status_code = 200


if __name__ == "__main__":
    unittest.main()

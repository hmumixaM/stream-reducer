"""Private, fixed-destination Vertex relay. Never returns Google credentials.

Only this process mounts the ADC. LiteLLM receives a separate relay key and
cannot select the Google project, destination, model family, or filesystem path.
"""
import hmac
import json
import os
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

import google.auth
from google.auth.transport.requests import Request
import requests

MAX_BODY = 8 * 1024 * 1024
MODELS = {"google/gemini-3.8-flash", "google/gemini-3.5-flash"}
RIGHTCODE_MODELS = {"gemini-3.8-flash", "gemini-3.7-flash"}
RIGHTCODE_UPSTREAM = "https://www.rightapi.ai/gemini/v1/chat/completions"
FIELDS = {
    "model", "messages", "temperature", "top_p", "n", "stream", "stop",
    "max_tokens", "max_completion_tokens", "presence_penalty",
    "frequency_penalty", "response_format", "seed", "stream_options",
    "reasoning_effort", "user",
}
UPSTREAM = (
    "https://aiplatform.googleapis.com/v1/projects/"
    "x-p-x-shared-ai-services-988d/locations/global/endpoints/openapi/chat/completions"
)


def validate_payload(payload, allowed_models=MODELS):
    if not isinstance(payload, dict) or payload.get("model") not in allowed_models:
        raise ValueError("unsupported model")
    if set(payload) - FIELDS:
        raise ValueError("unsupported parameters")
    messages = payload.get("messages")
    if not isinstance(messages, list) or not messages:
        raise ValueError("messages required")
    # The application sends text. Do not allow remote URL/file attachments or
    # tools to broaden the relay's capabilities through this credential.
    for message in messages:
        if not isinstance(message, dict) or set(message) - {"role", "content", "name"}:
            raise ValueError("text messages required")
        if message.get("role") not in {"system", "developer", "user", "assistant"}:
            raise ValueError("unsupported role")
        if not isinstance(message.get("content"), str):
            raise ValueError("text content required")
    if "stream" in payload and not isinstance(payload["stream"], bool):
        raise ValueError("invalid stream")
    # Legacy clients attach their application user ID for gateway accounting.
    # It is not a provider credential or a Google OpenAI parameter we need.
    return {key: value for key, value in payload.items() if key != "user"}


class VertexRelay(ThreadingHTTPServer):
    daemon_threads = True

    def __init__(self, address, key, credentials, rightcode_key=None):
        super().__init__(address, Handler)
        self.key = key
        self.credentials = credentials
        self.rightcode_key = rightcode_key
        self.refresh_lock = threading.Lock()
        self.slots = threading.BoundedSemaphore(16)

    def access_token(self):
        with self.refresh_lock:
            if not self.credentials.valid:
                session = requests.Session()
                session.trust_env = False
                try:
                    self.credentials.refresh(Request(session=session))
                finally:
                    session.close()
            return self.credentials.token


class Handler(BaseHTTPRequestHandler):
    server_version = "VertexRelay"
    sys_version = ""

    def version_string(self):
        return self.server_version

    def setup(self):
        super().setup()
        self.connection.settimeout(130)

    def log_message(self, *_args):
        # No prompts, request paths, headers, credentials, or upstream errors.
        pass

    def error(self, status, message):
        body = json.dumps({"error": {"message": message}}).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        if self.path == "/health/liveliness":
            return self.error(200, "ok")
        self.error(404, "not found")

    def do_POST(self):
        if self.path not in {"/v1/chat/completions", "/rightcode/v1/chat/completions"}:
            return self.error(404, "not found")
        rightcode = self.path == "/rightcode/v1/chat/completions"
        expected = "Bearer " + self.server.key
        if not hmac.compare_digest(self.headers.get("Authorization", ""), expected):
            return self.error(401, "unauthorized")
        if self.headers.get("Transfer-Encoding"):
            return self.error(400, "content length required")
        try:
            length = int(self.headers.get("Content-Length", "0"))
            if length <= 0 or length > MAX_BODY:
                return self.error(413, "request too large or empty")
            payload = validate_payload(json.loads(self.rfile.read(length)), RIGHTCODE_MODELS if rightcode else MODELS)
        except (ValueError, TypeError):
            return self.error(400, "unsupported request")
        if not self.server.slots.acquire(blocking=False):
            return self.error(429, "relay busy")
        started = False
        session = requests.Session()
        session.trust_env = False
        try:
            token = self.server.rightcode_key if rightcode else self.server.access_token()
            if not token:
                return self.error(503, "provider unavailable")
            with session.post(
                RIGHTCODE_UPSTREAM if rightcode else UPSTREAM,
                json=payload,
                headers={"Authorization": "Bearer " + token},
                stream=True,
                timeout=(10, 120),
                allow_redirects=False,
            ) as upstream:
                if upstream.status_code != 200:
                    status = upstream.status_code
                    if status not in {400, 404, 429, 503, 504}:
                        status = 502
                    return self.error(status, "Provider request failed")
                self.send_response(200)
                self.send_header("Content-Type", "text/event-stream" if payload.get("stream") else "application/json")
                self.send_header("Cache-Control", "no-store")
                self.end_headers()
                started = True
                for chunk in upstream.iter_content(chunk_size=4096):
                    if chunk:
                        self.wfile.write(chunk)
                        self.wfile.flush()
        except Exception:
            if not started:
                self.error(502, "Vertex temporarily unavailable")
        finally:
            session.close()
            self.server.slots.release()
            self.close_connection = True


if __name__ == "__main__":
    relay_key = os.environ["VERTEX_RELAY_KEY"]
    if len(relay_key) < 32:
        raise ValueError("relay key too short")
    creds, _ = google.auth.load_credentials_from_file(
        "/run/secrets/vertex-adc.json",
        scopes=["https://www.googleapis.com/auth/cloud-platform"],
    )
    VertexRelay(("0.0.0.0", 8080), relay_key, creds, os.environ.get("RIGHTCODE_API_KEY")).serve_forever()

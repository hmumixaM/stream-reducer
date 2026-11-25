"""Fixed provider destinations for the shared gateway's Hosted model routes."""
import hmac
import json
import os
from urllib.parse import urlsplit

import requests

OPENAI_MODELS = {"gpt-6-luna", "gpt-6.1-sol", "gpt-6.1-terra", "gpt-6-astra", "gpt-6.2-astra"}
ANTHROPIC_MODELS = {"claude-haiku-5-5", "claude-sonnet-5-5"}
ROUTES = {
    "/hosted/openai/v1/chat/completions": ("https://api.openai.com/v1/chat/completions", OPENAI_MODELS, "OPENAI_API_KEY"),
    "/hosted/openai/v1/responses": ("https://api.openai.com/v1/responses", OPENAI_MODELS, "OPENAI_API_KEY"),
    "/hosted/anthropic/v1/messages": ("https://api.anthropic.com/v1/messages", ANTHROPIC_MODELS, "ANTHROPIC_API_KEY"),
    "/hosted/deepseek/chat/completions": ("https://api.deepseek.com/chat/completions", {"deepseek-flash"}, "DEEPSEEK_API_KEY"),
    "/hosted/yeta/v1/responses": ("https://platform.yeta.ai/v1/responses", {"deepseek-v4.1-flash-uncensored"}, "YETA_API_KEY"),
}
MAX_HOSTED_BODY = 16_000_000
ERROR_CODES = {
    "authentication_error", "invalid_api_key", "context_length_exceeded",
    "context_window_exceeded", "invalid_request_error", "not_found_error",
    "rate_limit_error", "overloaded_error", "service_unavailable",
}


def hosted_route(path):
    return ROUTES.get(urlsplit(path).path)


def forward_hosted(handler, route):
    target, models, credential_name = route
    relay_key = os.environ.get("HOSTED_RELAY_KEY")
    supplied_key = handler.headers.get("x-api-key") if credential_name == "ANTHROPIC_API_KEY" else handler.headers.get("Authorization", "").removeprefix("Bearer ")
    if not relay_key or not supplied_key or not hmac.compare_digest(supplied_key, relay_key):
        return handler.error(401, "Unauthorized")
    if not handler.server.hosted_slots.acquire(blocking=False):
        return handler.error(503, "Provider relay busy")
    try:
        return _forward_authorized(handler, target, models, credential_name)
    finally:
        handler.server.hosted_slots.release()
        handler.close_connection = True


def _forward_authorized(handler, target, models, credential_name):
    if handler.headers.get("Transfer-Encoding"):
        return handler.error(400, "Content length required")
    try:
        length = int(handler.headers.get("Content-Length", "0"))
        if not 0 < length <= MAX_HOSTED_BODY:
            return handler.error(413, "Request exceeds relay limit")
        body = handler.rfile.read(length)
        payload = json.loads(body)
        if not isinstance(payload, dict) or payload.get("model") not in models:
            return handler.error(400, "Unsupported model")
    except (ValueError, TypeError):
        return handler.error(400, "Unsupported request")

    key = os.environ.get(credential_name)
    if not key:
        return handler.error(503, "Provider unavailable")
    headers = {"Content-Type": "application/json"}
    if credential_name == "ANTHROPIC_API_KEY":
        headers.update({"x-api-key": key, "anthropic-version": "2023-06-01"})
        if beta := handler.headers.get("anthropic-beta"):
            headers["anthropic-beta"] = beta
    else:
        headers["Authorization"] = "Bearer " + key

    started = False
    try:
        with requests.Session() as session:
            session.trust_env = False
            with session.post(target, data=body, headers=headers, stream=True, timeout=(8, 130), allow_redirects=False) as upstream:
                if not upstream.ok or upstream.is_redirect:
                    code = "service_unavailable"
                    try:
                        error = upstream.json().get("error", {})
                        candidate = error.get("code") or error.get("type")
                        if candidate in ERROR_CODES:
                            code = candidate
                    except (ValueError, AttributeError, TypeError):
                        pass
                    return handler.hosted_error(upstream.status_code if not upstream.is_redirect else 502, code)
                handler.send_response(upstream.status_code)
                handler.send_header("Content-Type", upstream.headers.get("Content-Type", "application/json"))
                handler.send_header("Cache-Control", "no-store")
                handler.end_headers()
                started = True
                for chunk in upstream.iter_content(chunk_size=4096):
                    if chunk:
                        handler.wfile.write(chunk)
                        handler.wfile.flush()
    except (requests.RequestException, OSError):
        if not started:
            handler.hosted_error(503, "service_unavailable")

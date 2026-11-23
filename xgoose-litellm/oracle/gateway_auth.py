"""Keep the Hosted and Stream Reducer model namespaces on separate credentials."""
import hmac
import os

from fastapi import HTTPException, Request
from litellm.proxy._types import UserAPIKeyAuth

REDUCER_MODELS = {"gemini-3.8-flash", "gemini-3.8-flash-rightcode", "gemini-3.7-flash", "gemini-3.5-flash-vertex"}
HOSTED_MODELS = {"luna", "gpt-6.1-sol", "gpt-6.1-terra", "gpt-6-astra", "gpt-6.2-astra", "claude-haiku-5-5", "claude-sonnet-5-5"}
HOSTED_FIELDS = {
    "model", "messages", "tools", "tool_choice", "stream", "stream_options",
    "max_tokens", "parallel_tool_calls", "temperature", "top_p", "user", "reasoning_effort",
}


async def authenticate(request: Request, api_key: str) -> UserAPIKeyAuth:
    hosted_key = os.environ.get("XGOOSE_HOSTED_KEY")
    reducer_key = os.environ.get("LITELLM_MASTER_KEY")
    if not api_key:
        raise HTTPException(401, "Unauthorized")
    if hosted_key and hmac.compare_digest(api_key, hosted_key):
        caller, models = "xgoose-hosted", HOSTED_MODELS
    elif reducer_key and hmac.compare_digest(api_key, reducer_key):
        caller, models = "stream-reducer", REDUCER_MODELS
    else:
        raise HTTPException(401, "Unauthorized")

    endpoint = (request.method, request.url.path)
    if endpoint == ("POST", "/v1/chat/completions"):
        try:
            body = await request.json()
        except ValueError:
            raise HTTPException(400, "Invalid JSON") from None
        model = body.get("model") if isinstance(body, dict) else None
        if not isinstance(model, str) or model not in models:
            raise HTTPException(403, "Model unavailable for this credential")
        if caller == "xgoose-hosted" and set(body) - HOSTED_FIELDS:
            raise HTTPException(403, "Unsupported inference request")
    elif endpoint != ("GET", "/v1/models"):
        raise HTTPException(403, "Inference endpoints only")
    return UserAPIKeyAuth(api_key=api_key, user_id=caller, models=sorted(models))

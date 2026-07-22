"""OpenAI-compatible chat call and shared analyzer-prompt helpers."""

import httpx

from config import (LLM_API_KEY, LLM_BASE_URL, LLM_MAX_TOKENS, LLM_MODEL,
                    LLM_TEMPERATURE, LLM_TIMEOUT_SEC, log)


async def llm_chat(system: str, user: str) -> dict:
    """One chat-completions call to the configured LLM.
    Returns {"result", "model", "usage"}; raises RuntimeError on any failure."""
    body = {
        "messages": [
            {"role": "system", "content": system},
            {"role": "user", "content": user},
        ],
        "temperature": LLM_TEMPERATURE,
        "max_tokens": LLM_MAX_TOKENS,
    }
    if LLM_MODEL:
        body["model"] = LLM_MODEL
    headers = {"Content-Type": "application/json"}
    if LLM_API_KEY:
        headers["Authorization"] = f"Bearer {LLM_API_KEY}"
    try:
        async with httpx.AsyncClient(timeout=LLM_TIMEOUT_SEC) as client:
            resp = await client.post(
                f"{LLM_BASE_URL}/chat/completions", json=body, headers=headers
            )
            resp.raise_for_status()
            data = resp.json()
        return {
            "result": data["choices"][0]["message"]["content"],
            "model": data.get("model", LLM_MODEL),
            "usage": data.get("usage") or {},
        }
    except httpx.HTTPStatusError as exc:
        log.warning("LLM HTTP error: %s %s", exc.response.status_code, exc.response.text[:500])
        raise RuntimeError(f"LLM returned {exc.response.status_code}.") from exc
    except (httpx.HTTPError, KeyError, IndexError, ValueError) as exc:
        log.warning("LLM request failed: %r", exc)
        raise RuntimeError("LLM request failed.") from exc


def chain_suffix(prev_name, prev_result) -> str:
    """Context block appended to a chained analyzer's input: the previous
    analyzer's output, so 'after previous prompt' analyzers can build on it."""
    return (f"\n\n---\nOutput of the previous analyzer "
            f'"{prev_name}":\n{prev_result}')

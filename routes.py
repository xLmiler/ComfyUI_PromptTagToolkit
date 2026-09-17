from __future__ import annotations

import asyncio
import json
import re
from typing import Any

from aiohttp import ClientSession, ClientTimeout, web
from server import PromptServer

from .storage import (
    delete_tag_preview,
    load_library,
    node_asset_path,
    node_asset_thumb_path,
    save_library,
    save_node_asset,
    save_tag_preview,
    tag_preview_path,
    tag_preview_thumb_path,
)

API_PREFIX = "/ptt"
MAX_TRANSLATE_CHARS = 120_000
DEFAULT_SYSTEM_PROMPT = "You are a precise prompt translator. Preserve comma-separated tag structure, weights, punctuation, names, and prompt syntax. Do not add explanations. Return only a JSON array of translated strings in exactly the same order and length as the input segments."
DEFAULT_MESSAGES_TEMPLATE = json.dumps([
    {
        "role": "system",
        "content": "{{system_prompt}}"
    },
    {
        "role": "user",
        "content": "Translate from {{source_language}} to {{target_language}}. Return only a JSON array with exactly the same number of strings as the input segments."
    },
    {
        "role": "user",
        "content": "{{text}}"
    }
], ensure_ascii=False)


def _json_error(message: str, status: int = 400):
    return web.json_response({"success": False, "error": message}, status=status)


def _normalize_base_url(base_url: str) -> str:
    url = str(base_url or "").strip().rstrip("/")
    if not re.match(r"^https?://", url, flags=re.I):
        raise ValueError("API Base URL must start with http:// or https://")
    return url


def _render_messages(template: str, texts: list[str], source: str, target: str, system_prompt: str) -> list[dict[str, str]]:
    try:
        obj = json.loads(template or DEFAULT_MESSAGES_TEMPLATE)
    except Exception as e:
        raise ValueError(f"messages template is invalid JSON: {e}") from e
    if not isinstance(obj, list) or not obj:
        raise ValueError("messages template must be a non-empty JSON array")
    placeholder_count = sum(str(item.get("content", "")).count("{{text}}") for item in obj if isinstance(item, dict))
    if placeholder_count != 1:
        raise ValueError("messages template must contain exactly one {{text}} placeholder")

    text_payload = json.dumps({"segments": texts}, ensure_ascii=False)
    out: list[dict[str, str]] = []
    allowed_roles = {"system", "user", "assistant"}
    for item in obj:
        if not isinstance(item, dict):
            raise ValueError("each message must be an object")
        role = str(item.get("role", "user"))
        if role not in allowed_roles:
            raise ValueError(f"unsupported message role: {role}")
        content = str(item.get("content", ""))
        content = content.replace("{{text}}", text_payload)
        content = content.replace("{{source_language}}", source)
        content = content.replace("{{target_language}}", target)
        content = content.replace("{{system_prompt}}", system_prompt)
        out.append({"role": role, "content": content})
    return out


def _extract_ai_translations(content: str, count: int) -> list[str]:
    text = str(content or "").strip()
    if text.startswith("```"):
        text = re.sub(r"^```(?:json)?\s*", "", text, flags=re.I)
        text = re.sub(r"\s*```$", "", text)
    try:
        parsed = json.loads(text)
        if isinstance(parsed, dict) and isinstance(parsed.get("segments"), list):
            parsed = parsed["segments"]
        if isinstance(parsed, list) and len(parsed) == count:
            return [str(x) for x in parsed]
    except Exception:
        pass
    if count == 1:
        return [text]
    lines = [x.strip() for x in text.splitlines() if x.strip()]
    if len(lines) == count:
        return lines
    raise ValueError("AI response is not a JSON array with the expected segment count")


@PromptServer.instance.routes.get(f"{API_PREFIX}/library")
async def get_library(request):
    del request
    return web.json_response({"success": True, "library": load_library()})


@PromptServer.instance.routes.post(f"{API_PREFIX}/library")
async def update_library(request):
    try:
        payload = await request.json()
        library = payload.get("library", payload)
        expected = payload.get("expected_revision")
        saved = save_library(library, int(expected) if expected is not None else None)
        return web.json_response({"success": True, "library": saved})
    except RuntimeError as e:
        if str(e) == "revision_conflict":
            return web.json_response({"success": False, "error": "revision_conflict", "library": load_library()}, status=409)
        return _json_error(str(e), 500)
    except Exception as e:
        return _json_error(str(e))


@PromptServer.instance.routes.post(f"{API_PREFIX}/tag-preview/upload")
async def upload_tag_preview(request):
    try:
        reader = await request.multipart()
        tag_id = ""
        raw = b""
        while True:
            part = await reader.next()
            if part is None:
                break
            if part.name == "tag_id":
                tag_id = (await part.text()).strip()
            elif part.name == "file":
                raw = await part.read(decode=False)
        if not tag_id or not raw:
            return _json_error("tag_id and file are required")
        filename = await asyncio.to_thread(save_tag_preview, tag_id, raw)
        return web.json_response({"success": True, "filename": filename, "url": f"{API_PREFIX}/tag-preview/{filename}"})
    except Exception as e:
        return _json_error(str(e))


@PromptServer.instance.routes.post(f"{API_PREFIX}/tag-preview/delete")
async def remove_tag_preview(request):
    try:
        data = await request.json()
        delete_tag_preview(str(data.get("filename", "")))
        return web.json_response({"success": True})
    except Exception as e:
        return _json_error(str(e))


@PromptServer.instance.routes.get(f"{API_PREFIX}/tag-preview/{{filename}}")
async def get_tag_preview(request):
    path = tag_preview_path(request.match_info.get("filename", ""))
    if path is None:
        raise web.HTTPNotFound()
    return web.FileResponse(path)


@PromptServer.instance.routes.get(f"{API_PREFIX}/tag-preview-thumb/{{filename}}")
async def get_tag_preview_thumb(request):
    path = await asyncio.to_thread(tag_preview_thumb_path, request.match_info.get("filename", ""))
    if path is None:
        raise web.HTTPNotFound()
    return web.FileResponse(path, headers={"Cache-Control": "private, max-age=86400"})


@PromptServer.instance.routes.post(f"{API_PREFIX}/node-asset/upload")
async def upload_node_asset(request):
    try:
        reader = await request.multipart()
        asset_id = ""
        raw = b""
        while True:
            part = await reader.next()
            if part is None:
                break
            if part.name == "asset_id":
                asset_id = (await part.text()).strip()
            elif part.name == "file":
                raw = await part.read(decode=False)
        if not asset_id or not raw:
            return _json_error("asset_id and file are required")
        filename = await asyncio.to_thread(save_node_asset, asset_id, raw)
        return web.json_response({"success": True, "filename": filename, "url": f"{API_PREFIX}/node-asset/{asset_id}"})
    except Exception as e:
        return _json_error(str(e))


@PromptServer.instance.routes.get(f"{API_PREFIX}/node-asset/{{asset_id}}")
async def get_node_asset(request):
    path = node_asset_path(request.match_info.get("asset_id", ""))
    if path is None:
        raise web.HTTPNotFound()
    return web.FileResponse(path)


@PromptServer.instance.routes.get(f"{API_PREFIX}/node-asset-thumb/{{asset_id}}")
async def get_node_asset_thumb(request):
    path = await asyncio.to_thread(node_asset_thumb_path, request.match_info.get("asset_id", ""))
    if path is None:
        raise web.HTTPNotFound()
    return web.FileResponse(path, headers={"Cache-Control": "private, max-age=86400"})


@PromptServer.instance.routes.post(f"{API_PREFIX}/translate/google")
async def translate_google(request):
    try:
        data = await request.json()
        texts = [str(x or "") for x in data.get("texts", [])]
        source = str(data.get("source", "auto") or "auto")
        target = str(data.get("target", "en") or "en")
        if sum(len(x) for x in texts) > MAX_TRANSLATE_CHARS:
            return _json_error("translation request is too large", 413)

        def _run_google():
            try:
                from deep_translator import GoogleTranslator
            except Exception as e:
                raise RuntimeError("deep-translator is not installed. Run pip install -r requirements.txt") from e
            nonempty_idx = [i for i, t in enumerate(texts) if t.strip()]
            nonempty = [texts[i] for i in nonempty_idx]
            result = ["" for _ in texts]
            if not nonempty:
                return result
            translator = GoogleTranslator(source=source, target=target)
            translated = translator.translate_batch(nonempty)
            if isinstance(translated, str):
                translated = [translated]
            if len(translated) != len(nonempty):
                raise RuntimeError("Google translator returned an unexpected result count")
            for i, value in zip(nonempty_idx, translated):
                result[i] = str(value or "")
            return result

        translations = await asyncio.to_thread(_run_google)
        return web.json_response({"success": True, "translations": translations})
    except Exception as e:
        return _json_error(str(e), 502)


@PromptServer.instance.routes.post(f"{API_PREFIX}/ai/models")
async def ai_models(request):
    try:
        data = await request.json()
        base_url = _normalize_base_url(data.get("base_url", ""))
        api_key = str(data.get("api_key", "") or "")
        headers = {"Accept": "application/json"}
        if api_key:
            headers["Authorization"] = f"Bearer {api_key}"
        timeout = ClientTimeout(total=min(max(int(data.get("timeout", 30)), 5), 120))
        async with ClientSession(timeout=timeout) as session:
            async with session.get(base_url + "/models", headers=headers) as resp:
                body = await resp.text()
                if resp.status >= 400:
                    raise RuntimeError(f"GET /models failed ({resp.status}): {body[:500]}")
                obj = json.loads(body)
        raw_models = obj.get("data", obj.get("models", obj if isinstance(obj, list) else []))
        models = []
        if isinstance(raw_models, list):
            for m in raw_models:
                if isinstance(m, str):
                    models.append(m)
                elif isinstance(m, dict):
                    value = m.get("id") or m.get("name")
                    if value:
                        models.append(str(value))
        models = sorted(dict.fromkeys(models))
        return web.json_response({"success": True, "models": models})
    except Exception as e:
        return _json_error(str(e), 502)


@PromptServer.instance.routes.post(f"{API_PREFIX}/translate/ai")
async def translate_ai(request):
    try:
        data = await request.json()
        texts = [str(x or "") for x in data.get("texts", [])]
        source = str(data.get("source", "auto") or "auto")
        target = str(data.get("target", "en") or "en")
        base_url = _normalize_base_url(data.get("base_url", ""))
        api_key = str(data.get("api_key", "") or "")
        model = str(data.get("model", "") or "").strip()
        system_prompt = str(data.get("system_prompt", "") or DEFAULT_SYSTEM_PROMPT)
        template = str(data.get("messages_template", "") or DEFAULT_MESSAGES_TEMPLATE)
        if not model:
            return _json_error("AI model is empty")
        if sum(len(x) for x in texts) > MAX_TRANSLATE_CHARS:
            return _json_error("translation request is too large", 413)

        nonempty_idx = [i for i, t in enumerate(texts) if t.strip()]
        nonempty = [texts[i] for i in nonempty_idx]
        translations = ["" for _ in texts]
        if not nonempty:
            return web.json_response({"success": True, "translations": translations})

        messages = _render_messages(template, nonempty, source, target, system_prompt)
        headers = {"Content-Type": "application/json", "Accept": "application/json"}
        if api_key:
            headers["Authorization"] = f"Bearer {api_key}"
        body: dict[str, Any] = {
            "model": model,
            "messages": messages,
            "temperature": float(data.get("temperature", 0.1)),
        }
        max_tokens = int(data.get("max_tokens", 4096))
        if max_tokens > 0:
            body["max_tokens"] = min(max_tokens, 32768)
        timeout = ClientTimeout(total=min(max(int(data.get("timeout", 90)), 10), 600))
        async with ClientSession(timeout=timeout) as session:
            async with session.post(base_url + "/chat/completions", headers=headers, json=body) as resp:
                response_text = await resp.text()
                if resp.status >= 400:
                    raise RuntimeError(f"POST /chat/completions failed ({resp.status}): {response_text[:1000]}")
                obj = json.loads(response_text)
        choices = obj.get("choices", [])
        if not choices:
            raise RuntimeError("AI response has no choices")
        message = choices[0].get("message", {})
        content = message.get("content", "")
        if isinstance(content, list):
            # Some OpenAI-compatible providers use typed content parts.
            content = "".join(str(x.get("text", "")) if isinstance(x, dict) else str(x) for x in content)
        parsed = _extract_ai_translations(content, len(nonempty))
        for i, value in zip(nonempty_idx, parsed):
            translations[i] = value
        return web.json_response({"success": True, "translations": translations})
    except Exception as e:
        return _json_error(str(e), 502)

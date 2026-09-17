from __future__ import annotations

import io
import json
import os
import re
import tempfile
import threading
from pathlib import Path
from typing import Any

from PIL import Image, ImageOps

try:
    import folder_paths
except Exception:  # pragma: no cover - only relevant outside ComfyUI
    folder_paths = None

PLUGIN_DIR_NAME = "PromptTagToolkit"
TAG_PREVIEW_MAX_EDGE = 2048
NODE_PREVIEW_MAX_EDGE = 4096
SAFE_ID = re.compile(r"^[A-Za-z0-9_-]{1,128}$")
_LIBRARY_LOCK = threading.RLock()


def _user_dir() -> Path:
    if folder_paths is not None:
        getter = getattr(folder_paths, "get_user_directory", None)
        if callable(getter):
            try:
                return Path(getter())
            except Exception:
                pass
        base_path = getattr(folder_paths, "base_path", None)
        if base_path:
            return Path(base_path) / "user"
    return Path.home() / ".comfyui" / "user"


ROOT = _user_dir() / PLUGIN_DIR_NAME
LIBRARY_FILE = ROOT / "tag_library.json"
TAG_PREVIEW_DIR = ROOT / "tag_previews"
TAG_THUMB_DIR = ROOT / "tag_preview_thumbs"
NODE_ASSET_DIR = ROOT / "node_assets"
NODE_THUMB_DIR = ROOT / "node_asset_thumbs"


def ensure_dirs() -> None:
    ROOT.mkdir(parents=True, exist_ok=True)
    TAG_PREVIEW_DIR.mkdir(parents=True, exist_ok=True)
    TAG_THUMB_DIR.mkdir(parents=True, exist_ok=True)
    NODE_ASSET_DIR.mkdir(parents=True, exist_ok=True)
    NODE_THUMB_DIR.mkdir(parents=True, exist_ok=True)


def _atomic_write_json(path: Path, data: Any) -> None:
    ensure_dirs()
    fd, temp_path = tempfile.mkstemp(prefix=path.name + ".", suffix=".tmp", dir=str(path.parent))
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as f:
            json.dump(data, f, ensure_ascii=False, indent=2)
            f.flush()
            os.fsync(f.fileno())
        os.replace(temp_path, path)
    finally:
        try:
            if os.path.exists(temp_path):
                os.remove(temp_path)
        except Exception:
            pass


def default_library() -> dict[str, Any]:
    return {
        "version": 1,
        "revision": 0,
        "categories": [
            {"id": "default", "name": "用户标签", "order": 0},
        ],
        "tags": [],
    }


def load_library() -> dict[str, Any]:
    ensure_dirs()
    if not LIBRARY_FILE.exists():
        data = default_library()
        _atomic_write_json(LIBRARY_FILE, data)
        return data
    try:
        data = json.loads(LIBRARY_FILE.read_text(encoding="utf-8"))
    except Exception:
        data = default_library()
    if not isinstance(data, dict):
        data = default_library()
    data.setdefault("version", 1)
    data.setdefault("revision", 0)
    data.setdefault("categories", [])
    data.setdefault("tags", [])
    return data


def _validate_library(data: dict[str, Any]) -> dict[str, Any]:
    categories = data.get("categories", [])
    tags = data.get("tags", [])
    if not isinstance(categories, list) or not isinstance(tags, list):
        raise ValueError("categories/tags must be arrays")
    if len(categories) > 500 or len(tags) > 10000:
        raise ValueError("library is too large")

    normalized_categories = []
    seen_categories: set[str] = set()
    for index, c in enumerate(categories):
        if not isinstance(c, dict):
            continue
        cid = str(c.get("id", "")).strip()
        name = str(c.get("name", "")).strip()[:128]
        if not SAFE_ID.fullmatch(cid) or not name or cid in seen_categories:
            continue
        seen_categories.add(cid)
        normalized_categories.append({
            "id": cid,
            "name": name,
            "order": int(c.get("order", index)),
        })

    if not normalized_categories:
        normalized_categories = [{"id": "default", "name": "用户标签", "order": 0}]
        seen_categories = {"default"}

    normalized_tags = []
    seen_tags: set[str] = set()
    for index, t in enumerate(tags):
        if not isinstance(t, dict):
            continue
        tid = str(t.get("id", "")).strip()
        category_id = str(t.get("category_id", "")).strip()
        label = str(t.get("label", "")).strip()[:256]
        text = str(t.get("text", ""))[:100000]
        preview = str(t.get("preview", "")).strip()[:256]
        if not SAFE_ID.fullmatch(tid) or tid in seen_tags or category_id not in seen_categories:
            continue
        if not label:
            label = text.strip()[:64] or "未命名标签"
        if preview and not re.fullmatch(r"[A-Za-z0-9_-]+\.png", preview):
            preview = ""
        seen_tags.add(tid)
        normalized_tags.append({
            "id": tid,
            "category_id": category_id,
            "label": label,
            "text": text,
            "preview": preview,
            "order": int(t.get("order", index)),
        })

    return {
        "version": 1,
        "revision": int(data.get("revision", 0)),
        "categories": normalized_categories,
        "tags": normalized_tags,
    }


def save_library(data: dict[str, Any], expected_revision: int | None = None) -> dict[str, Any]:
    # A revision check without a lock can still lose updates if two browser tabs
    # race between load and replace. Keep the whole compare-and-swap atomic in
    # this ComfyUI process.
    with _LIBRARY_LOCK:
        current = load_library()
        if expected_revision is not None and int(current.get("revision", 0)) != int(expected_revision):
            raise RuntimeError("revision_conflict")
        normalized = _validate_library(data)
        normalized["revision"] = int(current.get("revision", 0)) + 1
        _atomic_write_json(LIBRARY_FILE, normalized)
        return normalized


def _open_valid_image(raw: bytes, max_edge: int) -> Image.Image:
    if len(raw) > 30 * 1024 * 1024:
        raise ValueError("image is too large")
    try:
        im = Image.open(io.BytesIO(raw))
        im.load()
    except Exception as e:
        raise ValueError(f"invalid image: {e}") from e
    im = ImageOps.exif_transpose(im)
    if im.width < 1 or im.height < 1:
        raise ValueError("invalid image dimensions")
    if max(im.size) > max_edge:
        scale = max_edge / float(max(im.size))
        im = im.resize((max(1, round(im.width * scale)), max(1, round(im.height * scale))), Image.Resampling.LANCZOS)
    if "A" in im.getbands():
        return im.convert("RGBA")
    return im.convert("RGB")


def _save_webp_thumb(im: Image.Image, path: Path, max_edge: int = 384) -> None:
    thumb = im.copy()
    if max(thumb.size) > max_edge:
        scale = max_edge / float(max(thumb.size))
        thumb = thumb.resize((max(1, round(thumb.width * scale)), max(1, round(thumb.height * scale))), Image.Resampling.LANCZOS)
    # WebP keeps alpha while being much smaller/faster to decode than a large PNG.
    if "A" in thumb.getbands():
        thumb = thumb.convert("RGBA")
    else:
        thumb = thumb.convert("RGB")
    thumb.save(path, format="WEBP", quality=82, method=3)


def save_tag_preview(tag_id: str, raw: bytes) -> str:
    ensure_dirs()
    if not SAFE_ID.fullmatch(tag_id):
        raise ValueError("invalid tag id")
    im = _open_valid_image(raw, TAG_PREVIEW_MAX_EDGE)
    filename = f"{tag_id}.png"
    # Avoid PNG optimize=True here: it is CPU-heavy and used to block ComfyUI's
    # aiohttp loop during uploads. The route now also runs this in a worker thread.
    im.save(TAG_PREVIEW_DIR / filename, format="PNG", optimize=False, compress_level=3)
    _save_webp_thumb(im, TAG_THUMB_DIR / f"{tag_id}.webp", 384)
    return filename


def delete_tag_preview(filename: str) -> None:
    if not re.fullmatch(r"[A-Za-z0-9_-]+\.png", filename or ""):
        return
    path = TAG_PREVIEW_DIR / filename
    thumb = TAG_THUMB_DIR / f"{Path(filename).stem}.webp"
    for candidate in (path, thumb):
        try:
            candidate.unlink(missing_ok=True)
        except Exception:
            pass


def tag_preview_path(filename: str) -> Path | None:
    if not re.fullmatch(r"[A-Za-z0-9_-]+\.png", filename or ""):
        return None
    path = TAG_PREVIEW_DIR / filename
    return path if path.exists() and path.is_file() else None


def tag_preview_thumb_path(filename: str) -> Path | None:
    full = tag_preview_path(filename)
    if full is None:
        return None
    ensure_dirs()
    thumb = TAG_THUMB_DIR / f"{Path(filename).stem}.webp"
    if not thumb.exists():
        with Image.open(full) as im:
            im.load()
            _save_webp_thumb(ImageOps.exif_transpose(im), thumb, 384)
    return thumb if thumb.exists() and thumb.is_file() else None


def save_node_asset(asset_id: str, raw: bytes) -> str:
    ensure_dirs()
    if not SAFE_ID.fullmatch(asset_id):
        raise ValueError("invalid asset id")
    im = _open_valid_image(raw, NODE_PREVIEW_MAX_EDGE)
    filename = f"{asset_id}.png"
    im.save(NODE_ASSET_DIR / filename, format="PNG", optimize=False, compress_level=2)
    _save_webp_thumb(im, NODE_THUMB_DIR / f"{asset_id}.webp", 512)
    return filename


def node_asset_path(asset_id: str) -> Path | None:
    if not SAFE_ID.fullmatch(asset_id):
        return None
    path = NODE_ASSET_DIR / f"{asset_id}.png"
    return path if path.exists() and path.is_file() else None


def node_asset_thumb_path(asset_id: str) -> Path | None:
    full = node_asset_path(asset_id)
    if full is None:
        return None
    ensure_dirs()
    thumb = NODE_THUMB_DIR / f"{asset_id}.webp"
    if not thumb.exists():
        with Image.open(full) as im:
            im.load()
            _save_webp_thumb(ImageOps.exif_transpose(im), thumb, 512)
    return thumb if thumb.exists() and thumb.is_file() else None

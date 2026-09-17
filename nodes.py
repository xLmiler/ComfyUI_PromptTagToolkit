from __future__ import annotations

import numpy as np
import torch
from PIL import Image, ImageOps

from .storage import node_asset_path

MAX_SEGMENTS = 12

COMMON_SOURCE_LANGUAGES = [
    "自动检测", "简体中文", "繁体中文", "英文", "日语", "韩语",
    "法语", "德语", "西班牙语", "俄语", "葡萄牙语", "意大利语",
    "泰语", "越南语", "印尼语", "阿拉伯语",
]
COMMON_TARGET_LANGUAGES = [x for x in COMMON_SOURCE_LANGUAGES if x != "自动检测"]


def merge_segments(segments: list[str]) -> str:
    """Join non-empty segments. Add a comma between segments only when needed."""
    parts = [str(x or "").strip() for x in segments]
    parts = [x for x in parts if x]
    if not parts:
        return ""
    out = parts[0]
    for part in parts[1:]:
        if not out.rstrip().endswith(","):
            out = out.rstrip() + ","
        out += part
    return out


def load_node_image(asset_id: str):
    path = node_asset_path(str(asset_id or ""))
    if path is None:
        return torch.zeros((1, 1, 1, 3), dtype=torch.float32), torch.zeros((1, 1, 1), dtype=torch.float32)

    im = Image.open(path)
    im = ImageOps.exif_transpose(im)
    rgb = im.convert("RGB")
    image = np.asarray(rgb).astype(np.float32) / 255.0
    image_t = torch.from_numpy(image)[None,]

    if "A" in im.getbands():
        alpha = np.asarray(im.getchannel("A")).astype(np.float32) / 255.0
        mask_t = 1.0 - torch.from_numpy(alpha)[None,]
    else:
        mask_t = torch.zeros((1, rgb.height, rgb.width), dtype=torch.float32)
    return image_t, mask_t


def _base_inputs():
    d = {
        "image_asset_id": ("STRING", {"default": "", "multiline": True}),
        "text_count": ("INT", {"default": 4, "min": 1, "max": MAX_SEGMENTS, "step": 1}),
    }
    return d


class PTTMultiPromptPreview:
    @classmethod
    def INPUT_TYPES(cls):
        required = _base_inputs()
        for i in range(1, MAX_SEGMENTS + 1):
            required[f"text_{i}"] = ("STRING", {"multiline": True, "default": "", "dynamicPrompts": True})
        return {"required": required}

    RETURN_TYPES = ("IMAGE", "MASK", "STRING") + ("STRING",) * MAX_SEGMENTS
    RETURN_NAMES = ("image", "mask", "combined_text") + tuple(f"text_{i}" for i in range(1, MAX_SEGMENTS + 1))
    FUNCTION = "run"
    CATEGORY = "Prompt Tag Toolkit"
    DESCRIPTION = "Persistent preview image + configurable multi-segment prompt text."
    OUTPUT_NODE = True

    def run(self, image_asset_id="", text_count=4, **kwargs):
        count = max(1, min(MAX_SEGMENTS, int(text_count)))
        all_segments = [str(kwargs.get(f"text_{i}", "") or "") for i in range(1, MAX_SEGMENTS + 1)]
        active = all_segments[:count]
        combined = merge_segments(active)
        image, mask = load_node_image(image_asset_id)
        result = (image, mask, combined, *all_segments)
        return {"ui": {"ptt_preview": [combined]}, "result": result}


class PTTMultiPromptTranslate:
    @classmethod
    def INPUT_TYPES(cls):
        required = _base_inputs()
        required.update({
            "translation_mode": ("BOOLEAN", {"default": False, "label_on": "翻译文本", "label_off": "原文本"}),
            "translator": (["Google Free", "OpenAI Compatible"], {"default": "Google Free"}),
            "source_language": (COMMON_SOURCE_LANGUAGES, {"default": "自动检测"}),
            "target_language": (COMMON_TARGET_LANGUAGES, {"default": "英文"}),
        })
        for i in range(1, MAX_SEGMENTS + 1):
            required[f"original_{i}"] = ("STRING", {"multiline": True, "default": "", "dynamicPrompts": True})
        for i in range(1, MAX_SEGMENTS + 1):
            required[f"translated_{i}"] = ("STRING", {"multiline": True, "default": "", "dynamicPrompts": True})
        return {"required": required}

    RETURN_TYPES = ("IMAGE", "MASK", "STRING", "STRING") + ("STRING",) * MAX_SEGMENTS
    RETURN_NAMES = ("image", "mask", "combined_text", "translated_text") + tuple(f"text_{i}" for i in range(1, MAX_SEGMENTS + 1))
    FUNCTION = "run"
    CATEGORY = "Prompt Tag Toolkit"
    DESCRIPTION = "Persistent multi-prompt node with dual original/translated text storage and translation controls."
    OUTPUT_NODE = True

    def run(self, image_asset_id="", text_count=4, translation_mode=False, translator="Google Free", source_language="自动检测", target_language="英文", **kwargs):
        del translator, source_language, target_language
        count = max(1, min(MAX_SEGMENTS, int(text_count)))
        originals = [str(kwargs.get(f"original_{i}", "") or "") for i in range(1, MAX_SEGMENTS + 1)]
        translated = [str(kwargs.get(f"translated_{i}", "") or "") for i in range(1, MAX_SEGMENTS + 1)]
        current = translated if bool(translation_mode) else originals
        combined = merge_segments(current[:count])
        translated_combined = merge_segments(translated[:count])
        image, mask = load_node_image(image_asset_id)
        result = (image, mask, combined, translated_combined, *current)
        return {"ui": {"ptt_preview": [combined], "ptt_translated_preview": [translated_combined]}, "result": result}


NODE_CLASS_MAPPINGS = {
    "PTTMultiPromptPreview": PTTMultiPromptPreview,
    "PTTMultiPromptTranslate": PTTMultiPromptTranslate,
}

NODE_DISPLAY_NAME_MAPPINGS = {
    "PTTMultiPromptPreview": "预览图多段提示词",
    "PTTMultiPromptTranslate": "高级预览图多段提示词（翻译）",
}

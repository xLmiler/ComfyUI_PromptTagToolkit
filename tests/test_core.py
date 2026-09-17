from __future__ import annotations

import io
import json
import sys
import tempfile
import types
import unittest
from pathlib import Path

from PIL import Image


class _Routes:
    def get(self, _path):
        return lambda fn: fn

    def post(self, _path):
        return lambda fn: fn


class _PromptServerInstance:
    routes = _Routes()


class _PromptServer:
    instance = _PromptServerInstance()


_TEST_USER_DIR = tempfile.mkdtemp(prefix="ptt_test_user_")
server_mod = types.ModuleType("server")
server_mod.PromptServer = _PromptServer
sys.modules.setdefault("server", server_mod)

folder_paths_mod = types.ModuleType("folder_paths")
folder_paths_mod.get_user_directory = lambda: _TEST_USER_DIR
sys.modules.setdefault("folder_paths", folder_paths_mod)

ROOT = Path(__file__).resolve().parents[2]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from ComfyUI_PromptTagToolkit import nodes, routes, storage  # noqa: E402


class CoreTests(unittest.TestCase):
    def test_merge_segments(self):
        self.assertEqual(nodes.merge_segments([]), "")
        self.assertEqual(nodes.merge_segments(["a", "b"]), "a,b")
        self.assertEqual(nodes.merge_segments(["a,", "b"]), "a,b")
        self.assertEqual(nodes.merge_segments([" a ", "", " b "]), "a,b")
        self.assertEqual(nodes.merge_segments(["a, ", " b"]), "a,b")

    def test_library_revision_conflict(self):
        first = storage.load_library()
        payload = dict(first)
        payload["categories"] = [{"id": "default", "name": "A", "order": 0}]
        saved = storage.save_library(payload, expected_revision=first["revision"])
        self.assertEqual(saved["revision"], first["revision"] + 1)
        with self.assertRaises(RuntimeError):
            storage.save_library(payload, expected_revision=first["revision"])

    def test_node_image_persists_and_loads(self):
        buf = io.BytesIO()
        Image.new("RGBA", (16, 8), (255, 0, 0, 128)).save(buf, format="PNG")
        storage.save_node_asset("asset_test", buf.getvalue())
        image, mask = nodes.load_node_image("asset_test")
        self.assertEqual(tuple(image.shape), (1, 8, 16, 3))
        self.assertEqual(tuple(mask.shape), (1, 8, 16))


    def test_thumbnail_generation(self):
        buf = io.BytesIO()
        Image.new("RGBA", (900, 300), (20, 40, 60, 180)).save(buf, format="PNG")
        filename = storage.save_tag_preview("tag_thumb_test", buf.getvalue())
        full = storage.tag_preview_path(filename)
        thumb = storage.tag_preview_thumb_path(filename)
        self.assertIsNotNone(full)
        self.assertIsNotNone(thumb)
        self.assertTrue(thumb.exists())
        with Image.open(thumb) as im:
            self.assertLessEqual(max(im.size), 384)

    def test_language_combo_defaults(self):
        inputs = nodes.PTTMultiPromptTranslate.INPUT_TYPES()["required"]
        source_values, source_opts = inputs["source_language"]
        target_values, target_opts = inputs["target_language"]
        self.assertIn("自动检测", source_values)
        self.assertIn("简体中文", source_values)
        self.assertIn("英文", target_values)
        self.assertNotIn("自动检测", target_values)
        self.assertEqual(source_opts["default"], "自动检测")
        self.assertEqual(target_opts["default"], "英文")

    def test_message_template_placeholders(self):
        messages = routes._render_messages(
            routes.DEFAULT_MESSAGES_TEMPLATE,
            ["one", "two"],
            "zh-CN",
            "en",
            "SYSTEM",
        )
        self.assertEqual(messages[0]["content"], "SYSTEM")
        self.assertIn("zh-CN", messages[1]["content"])
        self.assertIn("en", messages[1]["content"])
        self.assertEqual(messages[2]["role"], "user")
        self.assertIn('"segments": ["one", "two"]', messages[2]["content"])

    def test_message_template_requires_single_locked_payload(self):
        with self.assertRaisesRegex(ValueError, "exactly one"):
            routes._render_messages(
                json.dumps([{"role": "system", "content": "no payload"}]),
                ["one"], "auto", "en", "SYSTEM"
            )
        with self.assertRaisesRegex(ValueError, "unsupported message role"):
            routes._render_messages(
                json.dumps([{"role": "tool", "content": "{{text}}"}]),
                ["one"], "auto", "en", "SYSTEM"
            )

    def test_ai_response_parser(self):
        self.assertEqual(routes._extract_ai_translations('["a","b"]', 2), ["a", "b"])
        self.assertEqual(routes._extract_ai_translations(json.dumps({"segments": ["x"]}), 1), ["x"])
        self.assertEqual(routes._extract_ai_translations("plain", 1), ["plain"])


if __name__ == "__main__":
    unittest.main()

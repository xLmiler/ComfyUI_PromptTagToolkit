# ComfyUI Prompt Tag Toolkit

全局提示词标签库 + 多段提示词持久化 / 翻译节点。

Global prompt tag library with persistent multi-segment prompt nodes and built-in translation.

**中文** | [English](#english)

---

## 中文文档

### 简介

Prompt Tag Toolkit 为 ComfyUI 提供一套提示词工作流增强工具：一个可在任意节点间共享的**全局标签库**，以及两个把「预览图 + 多段提示词」固化进工作流的**持久化节点**。图片与文本分开保存，重开 ComfyUI 或重新加载工作流后原样恢复。

### 功能特性

- **全局标签库** —— 按分类管理常用提示词片段，支持预览图与自动缩略图，一键插入到当前聚焦的文本框。
- **多段提示词持久化** —— 最多 12 段文本，配合一张持久化预览图，重新打开工作流后内容不丢失。
- **智能合并输出** —— 多段文本自动合并为逗号分隔的单条提示词，已带逗号的片段不会重复追加。
- **内置翻译** —— 支持 Google 免费翻译（无需 API Key）与任意 OpenAI 兼容接口（可自定义 Base URL、模型、系统提示词与消息模板）。
- **原文 / 译文双份存储** —— 两套文本分别保存，用开关随时切换输出哪一份。
- **安全写入** —— 标签库采用原子写入 + 版本号乐观锁，多个浏览器标签页同时编辑不会互相覆盖。
- **兼容动态提示词** —— 所有文本输入框均启用 `dynamicPrompts`，可直接使用 `{a|b}` 语法。

### 安装

**方式一：ComfyUI Manager** —— 在 Manager 中搜索 `Prompt Tag Toolkit` 安装（若已收录）。

**方式二：手动克隆**

```bash
cd ComfyUI/custom_nodes
git clone https://github.com/xLmiler/ComfyUI_PromptTagToolkit.git
```

**方式三：Windows 一键脚本**

双击 `install_windows.bat`。脚本会自动定位便携版 `python_embeded/python.exe`，找不到时回退到 PATH 中的 `python`。

也可手动安装依赖：

```bash
pip install -r requirements.txt
```

安装完成后**重启 ComfyUI**，并按 **Ctrl+F5** 强制刷新浏览器（否则新前端脚本不会加载）。

### 节点说明

两个节点都位于分类 `Prompt Tag Toolkit` 下。

#### 1. 预览图多段提示词（`PTTMultiPromptPreview`）

在节点上直接上传或粘贴一张图片，图片会持久化到用户目录；工作流里只记录一个 asset id，因此即使清空 ComfyUI 的输入输出缓存也不会丢失。

| 输入 | 说明 |
| --- | --- |
| `image_asset_id` | 预览图资源 ID，由节点 UI 上传后自动写入，一般无需手动填写 |
| `text_count` | 生效的文本段数，范围 1–12，默认 4 |
| `text_1` … `text_12` | 多段提示词文本，支持动态提示词语法 |

| 输出 | 说明 |
| --- | --- |
| `image` | 预览图，`IMAGE` 类型（无图时返回 1×1 占位图） |
| `mask` | 预览图 alpha 通道取反后得到的 `MASK`（无 alpha 时全 0） |
| `combined_text` | 前 `text_count` 段合并后的单条提示词 |
| `text_1` … `text_12` | 各段原文透传 |

#### 2. 高级预览图多段提示词（翻译）（`PTTMultiPromptTranslate`）

在上面的基础上增加原文/译文双份存储与翻译控制。

| 额外输入 | 说明 |
| --- | --- |
| `translation_mode` | 输出开关：`翻译文本` 输出译文，`原文本` 输出原文 |
| `translator` | 翻译后端：`Google Free` 或 `OpenAI Compatible` |
| `source_language` | 源语言，含 `自动检测` |
| `target_language` | 目标语言，共 15 种（不含自动检测） |
| `original_1` … `original_12` | 原文各段 |
| `translated_1` … `translated_12` | 译文各段（由翻译功能写入，也可手动编辑） |

支持的语言：自动检测、简体中文、繁体中文、英文、日语、韩语、法语、德语、西班牙语、俄语、葡萄牙语、意大利语、泰语、越南语、印尼语、阿拉伯语。

| 输出 | 说明 |
| --- | --- |
| `image` / `mask` | 同预览图节点 |
| `combined_text` | 按当前 `translation_mode` 合并的结果 |
| `translated_text` | 始终输出译文的合并结果 |
| `text_1` … `text_12` | 当前生效的各段文本 |

### 翻译后端

#### Google Free

基于 `deep-translator`，**无需 API Key**，开箱即用，但受 Google 的速率限制，适合日常少量翻译。

#### OpenAI 兼容接口

在 **设置 → Prompt Tag Toolkit → AI 翻译 → API 管理器** 中配置，可对接任意 OpenAI 兼容服务（OpenAI、DeepSeek、Ollama、LM Studio、各类中转等）：

- **Base URL**（默认 `https://api.openai.com/v1`）、**API Key**、**模型**（支持从接口拉取模型列表）
- **系统提示词**：默认要求模型保持逗号分隔的标签结构、权重与提示词语法，只返回 JSON 数组
- **消息模板**：JSON 数组，必须**有且仅有一个** `{{text}}` 占位符；另支持 `{{source_language}}`、`{{target_language}}`、`{{system_prompt}}`；角色仅允许 `system` / `user` / `assistant`
- **超时**：默认 90 秒；`max_tokens` 上限 32768，单次翻译输入上限 120000 字符
- 模型返回内容支持三种格式解析：JSON 数组、`{"segments": [...]}` 对象、纯文本

### 标签库

- **快捷键**：默认 `Ctrl+Shift+Space`，可在 **设置 → Prompt Tag Toolkit → 标签库 → 快捷键** 中修改；若与输入法冲突，可使用菜单里的「检查标签库快捷键冲突」排查
- **显示模式**：标签（chips）/ 卡牌（cards）
- **菜单入口**：`Extensions → Prompt Tag Toolkit`，含「打开标签库」「检查标签库快捷键冲突」「打开 AI API 管理器」
- **标签字段**：名称、文本、归属分类、预览图

标签库支持新增/编辑/删除分类与标签、上传预览图、按分类筛选、点击插入到当前聚焦的文本输入框。

### 数据存储位置

所有用户数据都保存在 ComfyUI 的**用户目录**下，**不随插件一起提交**：

```
<ComfyUI user dir>/PromptTagToolkit/
├── tag_library.json          # 标签库（原子写入 + revision 乐观锁）
├── tag_previews/             # 标签预览图 PNG（上限 2048px）
├── tag_preview_thumbs/       # 标签缩略图 WebP（≤384px）
├── node_assets/              # 节点预览图 PNG（上限 4096px）
└── node_asset_thumbs/        # 节点缩略图 WebP（≤512px）
```

### HTTP 接口

后端在 ComfyUI 服务上注册了 `/ptt` 前缀的接口，供前端调用：

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/ptt/library` | 读取标签库 |
| POST | `/ptt/library` | 保存标签库（带 revision 冲突检测） |
| POST | `/ptt/tag-preview/upload` | 上传标签预览图 |
| POST | `/ptt/tag-preview/delete` | 删除标签预览图 |
| GET | `/ptt/tag-preview/{filename}` | 获取标签预览图 |
| GET | `/ptt/tag-preview-thumb/{filename}` | 获取标签缩略图 |
| POST | `/ptt/node-asset/upload` | 上传节点预览图 |
| GET | `/ptt/node-asset/{asset_id}` | 获取节点预览图 |
| GET | `/ptt/node-asset-thumb/{asset_id}` | 获取节点缩略图 |
| POST | `/ptt/translate/google` | Google 免费翻译 |
| POST | `/ptt/ai/models` | 拉取 OpenAI 兼容接口的模型列表 |
| POST | `/ptt/translate/ai` | OpenAI 兼容接口翻译 |

### 目录结构

```
ComfyUI_PromptTagToolkit/
├── __init__.py            # 注册节点与 HTTP 路由，声明 WEB_DIRECTORY
├── nodes.py               # 两个节点类与文本合并逻辑
├── routes.py              # /ptt 系列 HTTP 接口与翻译实现
├── storage.py             # 标签库读写、图片落盘与缩略图生成
├── web/                   # 前端扩展
│   ├── main.js            # 扩展入口、设置项、菜单命令
│   ├── ptt_common.js      # 公共工具函数
│   ├── ptt_nodes.js       # 节点 UI 增强（预览图上传、多段输入）
│   ├── ptt_tag_library.js # 标签库面板
│   └── ptt_ai_manager.js  # AI API 管理器
├── tests/test_core.py     # 单元测试
├── install_windows.bat    # Windows 依赖安装脚本
├── requirements.txt
└── pyproject.toml
```

### 依赖

- Python >= 3.10
- `deep-translator >= 1.11.4, < 2`（唯一需要额外安装的依赖）
- 运行时还依赖 ComfyUI 自带的 `torch`、`numpy`、`Pillow`、`aiohttp`

### 测试

```bash
python tests/test_core.py
```

共 8 个用例，覆盖文本合并、标签库 revision 冲突、图片持久化与缩略图、语言下拉默认值、消息模板校验与 AI 响应解析。测试会自行 mock `server` 与 `folder_paths`，无需启动 ComfyUI。

### 许可证

[MIT](LICENSE)

---

## English

### Overview

Prompt Tag Toolkit adds a shared **global tag library** and two **persistent prompt nodes** to ComfyUI. Images and text are stored separately, so everything survives a ComfyUI restart or a workflow reload.

### Features

- **Global tag library** — organize reusable prompt fragments by category, with preview images, auto-generated thumbnails, and one-click insertion into the focused text field.
- **Persistent multi-segment prompts** — up to 12 text segments plus a persistent preview image that stay intact across sessions.
- **Smart merging** — segments are joined into a single comma-separated prompt, without doubling up commas on fragments that already end with one.
- **Built-in translation** — Google free translation (no API key) or any OpenAI-compatible endpoint (custom base URL, model, system prompt, and message template).
- **Dual storage** — original and translated text are kept separately; a toggle decides which one is output.
- **Safe writes** — the tag library uses atomic writes plus revision-based optimistic locking, so multiple browser tabs can't clobber each other.
- **Dynamic prompts** — every text widget enables `dynamicPrompts`, so `{a|b}` syntax works out of the box.

### Installation

**Option 1 — ComfyUI Manager:** search for `Prompt Tag Toolkit` (if listed).

**Option 2 — Manual clone:**

```bash
cd ComfyUI/custom_nodes
git clone https://github.com/xLmiler/ComfyUI_PromptTagToolkit.git
```

**Option 3 — Windows helper script:** run `install_windows.bat`. It locates the portable `python_embeded/python.exe` and falls back to `python` on `PATH`.

Or install the dependency manually:

```bash
pip install -r requirements.txt
```

Then **restart ComfyUI** and hard-refresh the browser with **Ctrl+F5** (otherwise the new frontend scripts are not loaded).

### Nodes

Both nodes live under the `Prompt Tag Toolkit` category.

#### 1. Preview Multi-Prompt (`PTTMultiPromptPreview`)

Upload or paste an image directly on the node — it is persisted to the user directory and only an asset id is stored in the workflow, so clearing ComfyUI's caches never loses it.

| Input | Description |
| --- | --- |
| `image_asset_id` | Preview asset id, written automatically by the node UI |
| `text_count` | Number of active segments, 1–12, default 4 |
| `text_1` … `text_12` | Prompt segments, dynamic prompt syntax supported |

| Output | Description |
| --- | --- |
| `image` | Preview image as `IMAGE` (a 1×1 placeholder when unset) |
| `mask` | `MASK` from the inverted alpha channel (all zeros when the image has no alpha) |
| `combined_text` | The first `text_count` segments merged into one prompt |
| `text_1` … `text_12` | Each segment passed through |

#### 2. Advanced Preview Multi-Prompt (Translate) (`PTTMultiPromptTranslate`)

Adds dual original/translated storage and translation controls on top of the node above.

| Extra input | Description |
| --- | --- |
| `translation_mode` | Output toggle: `翻译文本` (translated) or `原文本` (original) |
| `translator` | Backend: `Google Free` or `OpenAI Compatible` |
| `source_language` | Source language, including `自动检测` (auto-detect) |
| `target_language` | Target language, 15 choices (no auto-detect) |
| `original_1` … `original_12` | Original segments |
| `translated_1` … `translated_12` | Translated segments (written by the translator, editable by hand) |

Supported languages: auto-detect, Simplified Chinese, Traditional Chinese, English, Japanese, Korean, French, German, Spanish, Russian, Portuguese, Italian, Thai, Vietnamese, Indonesian, Arabic.

| Output | Description |
| --- | --- |
| `image` / `mask` | Same as the preview node |
| `combined_text` | Merge according to the current `translation_mode` |
| `translated_text` | Merged translated text, always |
| `text_1` … `text_12` | The currently active segments |

### Translation backends

#### Google Free

Powered by `deep-translator`. **No API key required**, but subject to Google's rate limits — fine for everyday use.

#### OpenAI-compatible

Configure it in **Settings → Prompt Tag Toolkit → AI 翻译 → API 管理器**. It works with any OpenAI-compatible service (OpenAI, DeepSeek, Ollama, LM Studio, proxies, ...):

- **Base URL** (default `https://api.openai.com/v1`), **API key**, **model** (with a "fetch model list" helper)
- **System prompt** — by default it instructs the model to preserve comma-separated tag structure, weights and prompt syntax, and to return only a JSON array
- **Messages template** — a JSON array that must contain **exactly one** `{{text}}` placeholder; `{{source_language}}`, `{{target_language}}` and `{{system_prompt}}` are also supported; only `system` / `user` / `assistant` roles are allowed
- **Timeout** — 90 s by default; `max_tokens` is clamped to 32768 and a single request is limited to 120000 characters
- Responses are parsed from a JSON array, a `{"segments": [...]}` object, or plain text

### Tag library

- **Hotkey** — `Ctrl+Shift+Space` by default, configurable under **Settings → Prompt Tag Toolkit → 标签库 → 快捷键**. Use "检查标签库快捷键冲突" from the menu if your IME swallows it.
- **View mode** — chips or cards
- **Menu** — `Extensions → Prompt Tag Toolkit` with "打开标签库", "检查标签库快捷键冲突" and "打开 AI API 管理器"
- **Tag fields** — label, text, category, preview image

The library supports creating/editing/deleting categories and tags, uploading preview images, filtering by category, and inserting a tag into the focused text field.

### Where data is stored

All user data lives under ComfyUI's **user directory** and is never committed with the plugin:

```
<ComfyUI user dir>/PromptTagToolkit/
├── tag_library.json          # tag library (atomic writes + revision locking)
├── tag_previews/             # tag previews, PNG up to 2048px
├── tag_preview_thumbs/       # tag thumbnails, WebP up to 384px
├── node_assets/              # node previews, PNG up to 4096px
└── node_asset_thumbs/        # node thumbnails, WebP up to 512px
```

### HTTP endpoints

The backend registers the following routes under the `/ptt` prefix:

| Method | Path | Description |
| --- | --- | --- |
| GET | `/ptt/library` | Read the tag library |
| POST | `/ptt/library` | Save the tag library (revision conflict detection) |
| POST | `/ptt/tag-preview/upload` | Upload a tag preview |
| POST | `/ptt/tag-preview/delete` | Delete a tag preview |
| GET | `/ptt/tag-preview/{filename}` | Fetch a tag preview |
| GET | `/ptt/tag-preview-thumb/{filename}` | Fetch a tag thumbnail |
| POST | `/ptt/node-asset/upload` | Upload a node preview |
| GET | `/ptt/node-asset/{asset_id}` | Fetch a node preview |
| GET | `/ptt/node-asset-thumb/{asset_id}` | Fetch a node thumbnail |
| POST | `/ptt/translate/google` | Translate via Google free |
| POST | `/ptt/ai/models` | List models from an OpenAI-compatible endpoint |
| POST | `/ptt/translate/ai` | Translate via an OpenAI-compatible endpoint |

### Project layout

```
ComfyUI_PromptTagToolkit/
├── __init__.py            # node + route registration, WEB_DIRECTORY
├── nodes.py               # the two node classes and text merging
├── routes.py              # /ptt HTTP endpoints and translation logic
├── storage.py             # library persistence, image storage, thumbnails
├── web/                   # frontend extensions
│   ├── main.js            # extension entry, settings, menu commands
│   ├── ptt_common.js      # shared helpers
│   ├── ptt_nodes.js       # node UI enhancements
│   ├── ptt_tag_library.js # tag library panel
│   └── ptt_ai_manager.js  # AI API manager
├── tests/test_core.py     # unit tests
├── install_windows.bat    # Windows dependency installer
├── requirements.txt
└── pyproject.toml
```

### Requirements

- Python >= 3.10
- `deep-translator >= 1.11.4, < 2` (the only extra dependency)
- `torch`, `numpy`, `Pillow` and `aiohttp` as already provided by ComfyUI

### Tests

```bash
python tests/test_core.py
```

Eight test cases covering text merging, the library revision conflict, image persistence and thumbnails, language combo defaults, message template validation and AI response parsing. The tests mock `server` and `folder_paths`, so ComfyUI does not need to be running.

### License

[MIT](LICENSE)

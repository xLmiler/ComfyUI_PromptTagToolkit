import { app } from "../../scripts/app.js";
import {
  DEFAULT_MESSAGES_TEMPLATE,
  DEFAULT_SYSTEM_PROMPT,
  getSetting,
  injectStyles,
  setSetting,
  toast,
} from "./ptt_common.js";
import { TagLibraryModal } from "./ptt_tag_library.js";
import { enhancePromptNode } from "./ptt_nodes.js";
import { aiManagerSettingRenderer, openAiManager } from "./ptt_ai_manager.js";

injectStyles();

const DEFAULT_HOTKEY = "Ctrl+Shift+Space";
const LEGACY_HOTKEY = "Ctrl+Space";

const CORE_BINDINGS = [
  "Ctrl+Enter", "Ctrl+Shift+Enter", "Ctrl+Alt+Enter", "R", "Q", "W", "N", "M",
  "Ctrl+S", "Ctrl+O", "Backspace", "Ctrl+G", "Ctrl+,", "Alt+=", "Alt+Shift++",
  "Alt++", "Alt+-", ".", "P", "Alt+C", "Ctrl+B", "Ctrl+M", "Ctrl+`", "F",
];
const TEXT_INPUT_RESERVED = [
  "Ctrl+A", "Ctrl+C", "Ctrl+V", "Ctrl+X", "Ctrl+Z", "Ctrl+Y", "Ctrl+P",
  "Enter", "Shift+Enter", "Ctrl+Backspace", "Ctrl+Delete", "Home", "Ctrl+Home", "Ctrl+Shift+Home",
  "End", "Ctrl+End", "Ctrl+Shift+End", "PageUp", "PageDown",
];
const BROWSER_RESERVED = [
  "Ctrl+F", "Ctrl+L", "Ctrl+T", "Ctrl+W", "Ctrl+R", "Ctrl+N", "Ctrl+Shift+N",
  "Ctrl+Shift+T", "Alt+Left", "Alt+Right", "F5", "F11", "F12",
];

function normalizeKeyName(key) {
  const k = String(key || "");
  if (k === " " || k === "Spacebar") return "Space";
  if (k.length === 1) return k.toUpperCase();
  const map = {
    Esc: "Escape", Del: "Delete", Control: "Ctrl", Meta: "Meta",
    Command: "Meta", Cmd: "Meta", Option: "Alt",
  };
  return map[k] || k;
}

function parseHotkey(value) {
  const raw = String(value || "").trim();
  if (!raw) throw new Error("快捷键不能为空");
  const parts = raw.split("+").map((x) => x.trim()).filter(Boolean);
  const combo = { ctrl: false, shift: false, alt: false, meta: false, key: "" };
  for (const part0 of parts) {
    const part = normalizeKeyName(part0);
    const low = part.toLowerCase();
    if (low === "ctrl" || low === "control") combo.ctrl = true;
    else if (low === "shift") combo.shift = true;
    else if (low === "alt" || low === "option") combo.alt = true;
    else if (low === "meta" || low === "cmd" || low === "command") combo.meta = true;
    else if (!combo.key) combo.key = part;
    else throw new Error("快捷键只能包含一个主按键");
  }
  if (!combo.key) throw new Error("缺少主按键，例如 Space / K / F2");
  return combo;
}

function eventCombo(e) {
  let key = normalizeKeyName(e.key);
  if (e.code === "Space" || e.key === " " || e.key === "Spacebar") key = "Space";
  return {
    ctrl: !!e.ctrlKey,
    shift: !!e.shiftKey,
    alt: !!e.altKey,
    meta: !!e.metaKey,
    key,
  };
}

function comboEquals(a, b) {
  return !!a && !!b
    && a.ctrl === b.ctrl
    && a.shift === b.shift
    && a.alt === b.alt
    && a.meta === b.meta
    && String(a.key).toLowerCase() === String(b.key).toLowerCase();
}

function comboString(c) {
  const p = [];
  if (c.ctrl) p.push("Ctrl");
  if (c.shift) p.push("Shift");
  if (c.alt) p.push("Alt");
  if (c.meta) p.push("Meta");
  p.push(normalizeKeyName(c.key));
  return p.join("+");
}

function keybindingToCombo(kb) {
  const c = kb?.combo || kb;
  if (!c?.key) return null;
  return {
    ctrl: !!c.ctrl,
    shift: !!c.shift,
    alt: !!c.alt,
    meta: !!c.meta,
    key: normalizeKeyName(c.key),
  };
}

function scanConflict(combo) {
  const target = comboString(combo).toLowerCase();
  const newBindingsRaw = getSetting("Comfy.Keybinding.NewBindings", []);
  const unsetRaw = getSetting("Comfy.Keybinding.UnsetBindings", []);
  const newBindings = Array.isArray(newBindingsRaw) ? newBindingsRaw : [];
  const unset = Array.isArray(unsetRaw) ? unsetRaw : [];
  const isUnsetCombo = (candidate, commandId = null) => unset.some((u) => {
    const uc = keybindingToCombo(u);
    if (!uc || !comboEquals(uc, candidate)) return false;
    return !commandId || !u.commandId || u.commandId === commandId;
  });

  for (const item of [
    ...TEXT_INPUT_RESERVED.map((x) => ({ source: "常用文本快捷键", value: x })),
    ...BROWSER_RESERVED.map((x) => ({ source: "浏览器保留快捷键", value: x })),
  ]) {
    try {
      if (comboString(parseHotkey(item.value)).toLowerCase() === target) return item;
    } catch { /* ignore malformed fallback */ }
  }

  for (const kb of newBindings) {
    const c = keybindingToCombo(kb);
    if (c && comboEquals(c, combo) && !isUnsetCombo(c, kb.commandId)) {
      return { source: "用户自定义快捷键", value: kb.commandId || "Unknown command" };
    }
  }

  for (const ext of (app.extensions || [])) {
    if (ext?.name === "PromptTagToolkit.Main") continue;
    for (const kb of ext?.keybindings || []) {
      const c = keybindingToCombo(kb);
      if (c && comboEquals(c, combo) && !isUnsetCombo(c, kb.commandId)) {
        return { source: `扩展 ${ext.name || "Unknown"}`, value: kb.commandId || "Unknown command" };
      }
    }
  }

  for (const value of CORE_BINDINGS) {
    try {
      const c = parseHotkey(value);
      if (comboString(c).toLowerCase() === target && !isUnsetCombo(c)) {
        return { source: "ComfyUI 核心快捷键", value };
      }
    } catch { /* ignore */ }
  }
  return null;
}

let activeHotkey = null;
let hotkeyConflict = null;
let currentLibraryModal = null;
let openingLibrary = false;
const handledShortcutEvents = new WeakSet();

function refreshHotkey(showToast = false) {
  try {
    activeHotkey = parseHotkey(getSetting("PromptTagToolkit.Library.Hotkey", DEFAULT_HOTKEY));
    hotkeyConflict = scanConflict(activeHotkey);
    if (showToast) {
      if (hotkeyConflict) {
        toast(
          "warn",
          "检测到快捷键冲突",
          `${comboString(activeHotkey)} 与 ${hotkeyConflict.source} 冲突：${hotkeyConflict.value}。仍会尝试执行；建议换一个组合键。`,
          7000,
        );
      } else {
        toast("success", "快捷键可用", `${comboString(activeHotkey)}（ComfyUI 页面全局）`, 2600);
      }
    }
  } catch (e) {
    activeHotkey = null;
    hotkeyConflict = { source: "格式错误", value: e.message };
    if (showToast) toast("error", "快捷键格式错误", e.message);
  }
}

async function openTagLibraryGlobal() {
  if (openingLibrary) return;
  if (currentLibraryModal?.root?.isConnected) {
    currentLibraryModal.focusSearch?.();
    return;
  }
  openingLibrary = true;
  const modal = new TagLibraryModal({
    onClose: () => {
      if (currentLibraryModal === modal) currentLibraryModal = null;
    },
  });
  currentLibraryModal = modal;
  try {
    await modal.open();
  } catch (e) {
    currentLibraryModal = null;
    toast("error", "打开标签库失败", e.message || String(e));
  } finally {
    openingLibrary = false;
  }
}

function handleShortcutEvent(e) {
  if (handledShortcutEvents.has(e) || !activeHotkey || e.repeat) return;
  if (!comboEquals(eventCombo(e), activeHotkey)) return;
  handledShortcutEvents.add(e);
  e.preventDefault();
  e.stopImmediatePropagation();
  void openTagLibraryGlobal();
}

// Page-global capture: the tag library no longer depends on a focused STRING widget.
window.addEventListener("keydown", handleShortcutEvent, true);
document.addEventListener("keydown", handleShortcutEvent, true);

async function migrateLegacyHotkeyOnce() {
  const migrated = !!getSetting("PromptTagToolkit.Library.HotkeyMigratedV12", false);
  const current = String(getSetting("PromptTagToolkit.Library.Hotkey", LEGACY_HOTKEY) || LEGACY_HOTKEY);
  if (migrated) return;
  if (current === LEGACY_HOTKEY) {
    await setSetting("PromptTagToolkit.Library.Hotkey", DEFAULT_HOTKEY);
    toast(
      "info",
      "标签库快捷键已更新",
      "Ctrl+Space 常被 Windows/输入法在浏览器之前截获，已迁移为 Ctrl+Shift+Space；可在设置中自行修改。",
      6500,
    );
  }
  await setSetting("PromptTagToolkit.Library.HotkeyMigratedV12", true);
}

app.registerExtension({
  name: "PromptTagToolkit.Main",
  settings: [
    {
      id: "PromptTagToolkit.Library.Hotkey",
      category: ["Prompt Tag Toolkit", "标签库", "快捷键"],
      name: "标签库快捷键",
      type: "text",
      defaultValue: DEFAULT_HOTKEY,
      tooltip: "在 ComfyUI 页面任意位置均可触发，不要求先点击 STRING 文本框。Ctrl+Space 可能被系统输入法直接截获。",
      onChange: () => setTimeout(() => refreshHotkey(true), 0),
    },
    {
      id: "PromptTagToolkit.Library.ViewMode",
      category: ["Prompt Tag Toolkit", "标签库", "显示"],
      name: "默认显示模式",
      type: "combo",
      defaultValue: "chips",
      options: [{ text: "标签", value: "chips" }, { text: "卡牌", value: "cards" }],
    },
    {
      id: "PromptTagToolkit.AI.Manager",
      category: ["Prompt Tag Toolkit", "AI 翻译", "API 管理器"],
      name: "AI API 管理器",
      type: aiManagerSettingRenderer,
      defaultValue: "open",
      // Deliberately no tooltip here. Some current settings renderer builds can
      // leave custom-renderer tooltips pinned at the top-left of the viewport.
    },

    { id: "PromptTagToolkit.Library.HotkeyMigratedV12", name: "Hotkey migration", type: "hidden", defaultValue: false },
    { id: "PromptTagToolkit.AI.BaseURL", name: "AI Base URL", type: "hidden", defaultValue: "https://api.openai.com/v1" },
    { id: "PromptTagToolkit.AI.ApiKey", name: "AI API Key", type: "hidden", defaultValue: "" },
    { id: "PromptTagToolkit.AI.Model", name: "AI Model", type: "hidden", defaultValue: "" },
    { id: "PromptTagToolkit.AI.SystemPrompt", name: "AI System Prompt", type: "hidden", defaultValue: DEFAULT_SYSTEM_PROMPT },
    { id: "PromptTagToolkit.AI.MessagesTemplate", name: "AI Messages Template", type: "hidden", defaultValue: DEFAULT_MESSAGES_TEMPLATE },
    { id: "PromptTagToolkit.AI.MessagesConfig", name: "AI Messages Config", type: "hidden", defaultValue: "" },
    { id: "PromptTagToolkit.AI.Timeout", name: "AI Timeout", type: "hidden", defaultValue: 90 },
    { id: "PromptTagToolkit.AI.ModelsCache", name: "AI Models Cache", type: "hidden", defaultValue: "[]" },
  ],
  commands: [
    {
      id: "PromptTagToolkit.OpenLibrary",
      label: "打开标签库",
      function: () => openTagLibraryGlobal(),
    },
    {
      id: "PromptTagToolkit.CheckHotkey",
      label: "检查标签库快捷键冲突",
      function: () => refreshHotkey(true),
    },
    {
      id: "PromptTagToolkit.OpenAIManager",
      label: "打开 AI API 管理器",
      function: () => openAiManager(),
    },
  ],
  menuCommands: [
    { path: ["Extensions", "Prompt Tag Toolkit"], commands: ["PromptTagToolkit.OpenLibrary", "PromptTagToolkit.CheckHotkey", "PromptTagToolkit.OpenAIManager"] },
  ],
  async setup() {
    await migrateLegacyHotkeyOnce();
    refreshHotkey(false);
    setTimeout(() => refreshHotkey(false), 1200);
  },
  async nodeCreated(node) {
    if (node?.comfyClass === "PTTMultiPromptPreview" || node?.comfyClass === "PTTMultiPromptTranslate") {
      enhancePromptNode(node, { fromLoad: !!app.configuringGraph });
    }
  },
  async loadedGraphNode(node) {
    if (node?.comfyClass === "PTTMultiPromptPreview" || node?.comfyClass === "PTTMultiPromptTranslate") {
      enhancePromptNode(node, { fromLoad: true });
    }
  },
  async afterConfigureGraph() {
    const nodes = app.graph?._nodes || app.graph?.nodes || [];
    for (const node of nodes) {
      if (node?.comfyClass === "PTTMultiPromptPreview" || node?.comfyClass === "PTTMultiPromptTranslate") {
        enhancePromptNode(node, { forceOutputSync: true });
      }
    }
  },
});

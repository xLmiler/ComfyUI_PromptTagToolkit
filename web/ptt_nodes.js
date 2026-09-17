import {
  API_PREFIX,
  DEFAULT_MESSAGES_TEMPLATE,
  DEFAULT_SYSTEM_PROMPT,
  MAX_SEGMENTS,
  fetchJson,
  findWidget,
  getSetting,
  getWidgetValue,
  setWidgetValue,
  toast,
  uuid,
} from "./ptt_common.js";

const LANGUAGE_CODE_MAP = Object.freeze({
  "自动检测": "auto",
  "简体中文": "zh-CN",
  "繁体中文": "zh-TW",
  "英文": "en",
  "日语": "ja",
  "韩语": "ko",
  "法语": "fr",
  "德语": "de",
  "西班牙语": "es",
  "俄语": "ru",
  "葡萄牙语": "pt",
  "意大利语": "it",
  "泰语": "th",
  "越南语": "vi",
  "印尼语": "id",
  "阿拉伯语": "ar",
});

function languageCode(value) {
  const raw = String(value || "").trim();
  return LANGUAGE_CODE_MAP[raw] || raw || "auto";
}

function safeResize(node) {
  try {
    const sz = node.computeSize?.();
    if (sz) {
      node.setSize?.([
        Math.max(node.size?.[0] || 360, sz[0] || 360, 390),
        Math.max(sz[1] || 0, 80),
      ]);
    }
    node.setDirtyCanvas?.(true, true);
  } catch { /* ignore */ }
}

function markUiOnly(widget) {
  if (!widget) return widget;
  widget.serialize = false;
  widget.options ??= {};
  widget.options.serialize = false;
  return widget;
}

function hideWidgetVisual(widget) {
  if (!widget || widget._pttHidden) return;
  widget._pttHidden = {
    computeSize: widget.computeSize,
    computeLayoutSize: widget.computeLayoutSize,
    draw: widget.draw,
    drawWidget: widget.drawWidget,
    mouse: widget.mouse,
    onClick: widget.onClick,
    onPointerDown: widget.onPointerDown,
    inputDisplay: widget.inputEl?.style?.display,
    elementDisplay: widget.element?.style?.display,
  };
  widget.computeSize = () => [0, -4];
  widget.computeLayoutSize = () => ({ minHeight: 0, maxHeight: 0, minWidth: 0 });
  widget.draw = () => {};
  widget.drawWidget = () => {};
  widget.mouse = () => false;
  widget.onClick = () => {};
  widget.onPointerDown = () => false;
  if (widget.inputEl?.style) widget.inputEl.style.display = "none";
  if (widget.element?.style) widget.element.style.display = "none";
}

function showWidgetVisual(widget) {
  if (!widget?._pttHidden) return;
  const s = widget._pttHidden;
  for (const key of ["computeSize", "computeLayoutSize", "draw", "drawWidget", "mouse", "onClick", "onPointerDown"]) {
    if (s[key] === undefined) delete widget[key];
    else widget[key] = s[key];
  }
  if (widget.inputEl?.style) widget.inputEl.style.display = s.inputDisplay ?? "";
  if (widget.element?.style) widget.element.style.display = s.elementDisplay ?? "";
  delete widget._pttHidden;
}

function fixedOutputCount(node) {
  return node?.comfyClass === "PTTMultiPromptTranslate" ? 4 : 3;
}

function countLinkedTextOutputs(node) {
  const base = fixedOutputCount(node);
  let highest = 0;
  const outputs = node?.outputs || [];
  for (let index = base; index < outputs.length; index++) {
    const slot = outputs[index];
    if (Array.isArray(slot?.links) && slot.links.length) highest = index - base + 1;
  }
  return highest;
}

function syncDynamicTextOutputs(node, desiredCount, { quiet = false } = {}) {
  if (!node?.outputs) return desiredCount;
  const base = fixedOutputCount(node);
  let desired = Math.max(1, Math.min(MAX_SEGMENTS, Number(desiredCount || 1)));
  const highestLinked = countLinkedTextOutputs(node);

  // Dynamic text outputs are intentionally the trailing outputs. We only ever
  // remove slots from the end, which keeps every retained origin_slot index
  // stable. If a trailing text output is connected, do not remove/reindex it.
  if (highestLinked > desired) {
    desired = highestLinked;
    const countWidget = findWidget(node, "text_count");
    if (countWidget && Number(countWidget.value) !== desired) countWidget.value = desired;
    if (!quiet && node._pttLastOutputClamp !== desired) {
      node._pttLastOutputClamp = desired;
      toast("warn", "无法减少文本输出", `text_${highestLinked} 仍有连接。请先断开该输出，再减少文本框数量。`, 4500);
    }
  } else {
    node._pttLastOutputClamp = null;
  }

  let current = Math.max(0, node.outputs.length - base);
  while (current > desired) {
    const lastIndex = node.outputs.length - 1;
    const slot = node.outputs[lastIndex];
    if (Array.isArray(slot?.links) && slot.links.length) break;
    if (typeof node.removeOutput === "function") node.removeOutput(lastIndex);
    else node.outputs.splice(lastIndex, 1);
    current--;
  }

  while (current < desired) {
    const index = current + 1;
    if (typeof node.addOutput === "function") node.addOutput(`text_${index}`, "STRING");
    else node.outputs.push({ name: `text_${index}`, type: "STRING", links: null });
    current++;
  }

  // Restore canonical names/types in case a legacy workflow serialized stale
  // labels. Indices remain unchanged.
  for (let i = 1; i <= current; i++) {
    const slot = node.outputs[base + i - 1];
    if (!slot) continue;
    slot.name = `text_${i}`;
    slot.label = `text_${i}`;
    slot.type = "STRING";
  }

  safeResize(node);
  return desired;
}

function installCountChangeWatcher(node, countWidget, apply) {
  if (!countWidget || countWidget._pttRobustWatcher) return;
  countWidget._pttRobustWatcher = true;

  const trigger = () => setTimeout(() => apply({ quiet: false }), 0);

  const oldCallback = countWidget.callback;
  countWidget.callback = function(value, ...args) {
    const result = oldCallback?.call(this, value, ...args);
    trigger();
    return result;
  };

  // Current ComfyUI BaseWidget.setValue() calls node.onWidgetChanged after the
  // widget value is committed. Some renderer versions have skipped the legacy
  // widget.callback path, so chain both APIs.
  if (!node._pttWidgetChangedHooked) {
    node._pttWidgetChangedHooked = true;
    const oldNodeWidgetChanged = node.onWidgetChanged;
    node.onWidgetChanged = function(name, value, oldValue, widget) {
      const result = oldNodeWidgetChanged?.apply(this, arguments);
      if (name === "text_count" || name === "translation_mode") setTimeout(() => this._pttApplyVisibility?.({ quiet: false }), 0);
      return result;
    };
  }

  const element = countWidget.element || countWidget.inputEl;
  if (element instanceof HTMLElement && !element._pttCountEvents) {
    element._pttCountEvents = true;
    element.addEventListener("input", trigger, true);
    element.addEventListener("change", trigger, true);
  }

  // Last-resort compatibility watcher. It is intentionally low-frequency and
  // stops when the node is removed. This covers legacy/custom renderers that
  // mutate widget.value directly without emitting either callback.
  let lastValue = Number(countWidget.value);
  node._pttCountPoll = window.setInterval(() => {
    if (!node.graph && !node.is_graph_input) return;
    const current = Number(countWidget.value);
    if (current !== lastValue) {
      lastValue = current;
      apply({ quiet: false });
    }
  }, 220);

  if (!node._pttRemovedHooked) {
    node._pttRemovedHooked = true;
    const oldRemoved = node.onRemoved;
    node.onRemoved = function() {
      if (this._pttCountPoll) window.clearInterval(this._pttCountPoll);
      this._pttCountPoll = null;
      return oldRemoved?.apply(this, arguments);
    };
  }
}

function setupCountVisibility(node, prefix, { deferOutputSync = false } = {}) {
  const countWidget = findWidget(node, "text_count");
  const apply = ({ quiet = false } = {}) => {
    let count = Math.max(1, Math.min(MAX_SEGMENTS, Number(countWidget?.value || 1)));
    if (!deferOutputSync || node._pttGraphConfigured) count = syncDynamicTextOutputs(node, count, { quiet });
    for (let i = 1; i <= MAX_SEGMENTS; i++) {
      const w = findWidget(node, `${prefix}_${i}`);
      if (i <= count) showWidgetVisual(w);
      else hideWidgetVisual(w);
    }
    safeResize(node);
  };

  installCountChangeWatcher(node, countWidget, apply);
  setTimeout(() => apply({ quiet: true }), 40);
  return apply;
}

function addTrailingDomWidget(node, name, element, minHeight = 100) {
  try {
    const w = node.addDOMWidget(name, "ptt_dom", element, {
      serialize: false,
      getValue: () => null,
      setValue: () => {},
      getMinHeight: () => minHeight,
      getMaxHeight: () => minHeight,
      hideOnZoom: false,
    });
    return markUiOnly(w);
  } catch (e) {
    console.warn("[PTT] addDOMWidget failed", e);
    return null;
  }
}

function choosePreviewImage(onFile) {
  const input = document.createElement("input");
  input.type = "file";
  input.accept = "image/png,image/jpeg,image/webp,image/gif";
  input.addEventListener("change", () => {
    const file = input.files?.[0];
    if (file) void onFile?.(file);
  }, { once: true });
  input.click();
}

function extractDroppedImage(e) {
  return [...(e?.dataTransfer?.files || [])].find((file) => String(file.type || "").startsWith("image/")) || null;
}

function bindImageDropTarget(element, onFile) {
  if (!(element instanceof HTMLElement) || element._pttImageDropBound) return;
  element._pttImageDropBound = true;
  for (const eventName of ["dragenter", "dragover"]) {
    element.addEventListener(eventName, (e) => {
      e.preventDefault();
      e.stopPropagation();
      if (e.dataTransfer) e.dataTransfer.dropEffect = "copy";
      element.classList.add("ptt-dragover");
    }, true);
  }
  for (const eventName of ["dragleave", "dragend"]) {
    element.addEventListener(eventName, () => element.classList.remove("ptt-dragover"), true);
  }
  element.addEventListener("drop", (e) => {
    e.preventDefault();
    e.stopPropagation();
    element.classList.remove("ptt-dragover");
    const file = extractDroppedImage(e);
    if (!file) return toast("warn", "请拖入图片文件");
    void onFile?.(file);
  }, true);
}

function configurePersistentImageWidget(node) {
  const widget = findWidget(node, "image_asset_id");
  if (!widget) return;
  const element = widget.element || widget.inputEl;
  let uploadToken = 0;
  let localObjectUrl = null;

  const cleanupLocal = () => {
    if (localObjectUrl) URL.revokeObjectURL(localObjectUrl);
    localObjectUrl = null;
  };

  const uploadFile = async (file, render) => {
    if (!file || !String(file.type || "").startsWith("image/")) {
      toast("warn", "不是图片文件", file?.name || "");
      return;
    }
    const token = ++uploadToken;
    cleanupLocal();
    localObjectUrl = URL.createObjectURL(file);
    render?.({ localUrl: localObjectUrl, uploading: true });

    let assetId = String(getWidgetValue(node, "image_asset_id", "") || "").trim();
    if (!assetId) {
      assetId = uuid("asset");
      setWidgetValue(node, "image_asset_id", assetId, false);
    }
    try {
      const form = new FormData();
      form.append("asset_id", assetId);
      form.append("file", file, file.name);
      await fetchJson(`${API_PREFIX}/node-asset/upload`, { method: "POST", body: form });
      if (token !== uploadToken) return;
      cleanupLocal();
      render?.({ uploading: false });
      toast("success", "预览图已异步缓存", file.name, 2200);
    } catch (e) {
      if (token !== uploadToken) return;
      cleanupLocal();
      render?.({ uploading: false });
      toast("error", "节点预览图上传失败", e.message || String(e));
    }
  };

  if (element instanceof HTMLElement) {
    element.classList.add("ptt-node-image-input");
    element.setAttribute("aria-label", "节点缓存预览图");
    element.title = "点击或拖拽：加载 / 替换预览图；右键：清除当前节点图片引用";
    if ("readOnly" in element) element.readOnly = true;
    if ("spellcheck" in element) element.spellcheck = false;
    widget.options ??= {};
    widget.options.getMinHeight = () => 86;
    widget.options.getMaxHeight = () => 86;
    widget.computeLayoutSize = () => ({ minHeight: 86, maxHeight: 86, minWidth: 0 });

    const render = ({ localUrl = null, uploading = false } = {}) => {
      const assetId = String(getWidgetValue(node, "image_asset_id", "") || "").trim();
      element.classList.toggle("has-image", !!assetId || !!localUrl);
      element.classList.toggle("uploading", !!uploading);
      if (localUrl) {
        element.style.backgroundImage = `url("${localUrl}")`;
        if ("placeholder" in element) element.placeholder = "正在后台缓存…";
      } else if (assetId) {
        element.style.backgroundImage = `url("${API_PREFIX}/node-asset-thumb/${encodeURIComponent(assetId)}?t=${Date.now()}")`;
        if ("placeholder" in element) element.placeholder = "";
      } else {
        element.style.backgroundImage = "none";
        if ("placeholder" in element) element.placeholder = "🖼 点击或拖拽图片到这里\n右键清除";
      }
      safeResize(node);
    };

    if (!element._pttImageBound) {
      element._pttImageBound = true;
      element.addEventListener("click", (e) => {
        e.preventDefault();
        e.stopPropagation();
        choosePreviewImage((file) => uploadFile(file, render));
      });
      element.addEventListener("contextmenu", (e) => {
        e.preventDefault();
        e.stopPropagation();
        cleanupLocal();
        uploadToken++;
        if (!String(getWidgetValue(node, "image_asset_id", "") || "").trim()) return;
        setWidgetValue(node, "image_asset_id", "", false);
        render();
      });
      element.addEventListener("keydown", (e) => e.preventDefault());
      bindImageDropTarget(element, (file) => uploadFile(file, render));
    }
    setTimeout(() => render(), 40);
    return;
  }

  const wrap = document.createElement("div");
  wrap.className = "ptt-node-preview";
  const render = ({ localUrl = null, uploading = false } = {}) => {
    const assetId = String(getWidgetValue(node, "image_asset_id", "") || "").trim();
    wrap.classList.toggle("uploading", !!uploading);
    if (!assetId && !localUrl) {
      wrap.textContent = "点击按钮或拖拽图片到这里";
      return;
    }
    wrap.innerHTML = "";
    const img = document.createElement("img");
    img.alt = "cached preview";
    img.decoding = "async";
    img.src = localUrl || `${API_PREFIX}/node-asset-thumb/${encodeURIComponent(assetId)}?t=${Date.now()}`;
    img.onerror = () => { wrap.textContent = "预览图文件不存在，可重新加载"; };
    wrap.appendChild(img);
  };
  addTrailingDomWidget(node, "ptt_cached_preview", wrap, 84);
  bindImageDropTarget(wrap, (file) => uploadFile(file, render));
  markUiOnly(node.addWidget?.("button", "🖼 加载 / 替换预览图", null, () => choosePreviewImage((file) => uploadFile(file, render)), { serialize: false }));
  markUiOnly(node.addWidget?.("button", "清除节点预览图引用", null, () => {
    cleanupLocal();
    uploadToken++;
    setWidgetValue(node, "image_asset_id", "", false);
    render();
  }, { serialize: false }));
  setTimeout(() => render(), 50);
}

function addRunPreview(node) {
  const box = document.createElement("div");
  box.className = "ptt-node-run-preview";
  box.textContent = "运行后显示所有启用文本框的合并预览";
  addTrailingDomWidget(node, "ptt_run_preview", box, 88);
  const oldExecuted = node.onExecuted;
  node.onExecuted = function(message) {
    const r = oldExecuted?.apply(this, arguments);
    const value = message?.ptt_preview?.[0] ?? message?.text?.[0] ?? "";
    box.textContent = String(value || "");
    safeResize(node);
    return r;
  };
}

function getAiSettings() {
  return {
    base_url: String(getSetting("PromptTagToolkit.AI.BaseURL", "https://api.openai.com/v1") || ""),
    api_key: String(getSetting("PromptTagToolkit.AI.ApiKey", "") || ""),
    model: String(getSetting("PromptTagToolkit.AI.Model", "") || ""),
    system_prompt: String(getSetting("PromptTagToolkit.AI.SystemPrompt", DEFAULT_SYSTEM_PROMPT) || DEFAULT_SYSTEM_PROMPT),
    messages_template: String(getSetting("PromptTagToolkit.AI.MessagesTemplate", DEFAULT_MESSAGES_TEMPLATE) || DEFAULT_MESSAGES_TEMPLATE),
    timeout: Number(getSetting("PromptTagToolkit.AI.Timeout", 90) || 90),
  };
}

async function translateAdvancedNode(node) {
  const count = Math.max(1, Math.min(MAX_SEGMENTS, Number(getWidgetValue(node, "text_count", 1))));
  const originals = [];
  for (let i = 1; i <= count; i++) originals.push(String(getWidgetValue(node, `original_${i}`, "") || ""));
  const provider = String(getWidgetValue(node, "translator", "Google Free") || "Google Free");
  const sourceLabel = String(getWidgetValue(node, "source_language", "自动检测") || "自动检测");
  const targetLabel = String(getWidgetValue(node, "target_language", "英文") || "英文");
  const source = languageCode(sourceLabel);
  const target = languageCode(targetLabel);
  if (!target || target.toLowerCase() === "auto") {
    toast("warn", "目标语言无效", "目标语言不能设为 auto。", 3500);
    return;
  }
  try {
    let result;
    if (provider === "OpenAI Compatible") {
      const settings = getAiSettings();
      if (!settings.model) {
        toast("warn", "尚未选择 AI 模型", "请在 Prompt Tag Toolkit 设置中的“AI API 管理器”拉取并选择模型。", 4500);
        return;
      }
      result = await fetchJson(`${API_PREFIX}/translate/ai`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ texts: originals, source, target, ...settings }),
      });
    } else {
      result = await fetchJson(`${API_PREFIX}/translate/google`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ texts: originals, source, target }),
      });
    }
    const translations = result.translations || [];
    for (let i = 1; i <= count; i++) setWidgetValue(node, `translated_${i}`, translations[i - 1] ?? "", false);
    setWidgetValue(node, "translation_mode", true, true);
    toast("success", "翻译完成", `${provider} · ${sourceLabel} → ${targetLabel}`, 2500);
  } catch (e) {
    toast("error", "翻译失败", e.message || String(e), 6000);
  }
}

function setupTranslationVisibility(node, { deferOutputSync = false } = {}) {
  const mode = findWidget(node, "translation_mode");
  const countWidget = findWidget(node, "text_count");
  const apply = ({ quiet = false } = {}) => {
    const translatedMode = !!mode?.value;
    let count = Math.max(1, Math.min(MAX_SEGMENTS, Number(countWidget?.value || 1)));
    if (!deferOutputSync || node._pttGraphConfigured) count = syncDynamicTextOutputs(node, count, { quiet });
    for (let i = 1; i <= MAX_SEGMENTS; i++) {
      const original = findWidget(node, `original_${i}`);
      const translated = findWidget(node, `translated_${i}`);
      if (i <= count && !translatedMode) showWidgetVisual(original);
      else hideWidgetVisual(original);
      if (i <= count && translatedMode) showWidgetVisual(translated);
      else hideWidgetVisual(translated);
    }
    safeResize(node);
  };

  installCountChangeWatcher(node, countWidget, apply);

  if (mode && !mode._pttTranslationModeHooked) {
    mode._pttTranslationModeHooked = true;
    const old = mode.callback;
    mode.callback = function(value, ...args) {
      const result = old?.call(this, value, ...args);
      setTimeout(() => apply({ quiet: false }), 0);
      return result;
    };
    const element = mode.element || mode.inputEl;
    if (element instanceof HTMLElement) {
      element.addEventListener("input", () => setTimeout(() => apply({ quiet: false }), 0), true);
      element.addEventListener("change", () => setTimeout(() => apply({ quiet: false }), 0), true);
    }
  }
  setTimeout(() => apply({ quiet: true }), 50);
  return apply;
}

function addTranslationButtons(node) {
  markUiOnly(node.addWidget?.("button", "🌐 翻译全部文本框", null, () => translateAdvancedNode(node), { serialize: false }));
  markUiOnly(node.addWidget?.("button", "↔ 交换原语言 / 目标语言", null, () => {
    const source = String(getWidgetValue(node, "source_language", "自动检测") || "自动检测");
    const target = String(getWidgetValue(node, "target_language", "英文") || "英文");
    if (languageCode(source) === "auto") {
      toast("warn", "无法交换自动检测", "自动检测只能作为源语言。请先选择明确的源语言。", 4000);
      return;
    }
    setWidgetValue(node, "source_language", target, false);
    setWidgetValue(node, "target_language", source, false);
    node.setDirtyCanvas?.(true, true);
  }, { serialize: false }));

  const status = document.createElement("div");
  status.className = "ptt-node-status";
  status.textContent = "原文本 / 翻译文本分别持久化；切换模式不会覆盖另一组文本。";
  addTrailingDomWidget(node, "ptt_translate_status", status, 28);
}

function forceOutputSync(node) {
  const count = Math.max(1, Math.min(MAX_SEGMENTS, Number(getWidgetValue(node, "text_count", 1))));
  syncDynamicTextOutputs(node, count, { quiet: true });
}

export function enhancePromptNode(node, options = {}) {
  if (!node) return;

  if (node._pttEnhanced) {
    if (options.forceOutputSync) {
      node._pttGraphConfigured = true;
      forceOutputSync(node);
      node._pttApplyVisibility?.({ quiet: true });
    }
    return;
  }

  node._pttEnhanced = true;
  node._pttGraphConfigured = !options.fromLoad;
  configurePersistentImageWidget(node);
  const deferOutputSync = !!options.fromLoad;
  if (node.comfyClass === "PTTMultiPromptPreview") {
    node._pttApplyVisibility = setupCountVisibility(node, "text", { deferOutputSync });
  } else if (node.comfyClass === "PTTMultiPromptTranslate") {
    node._pttApplyVisibility = setupTranslationVisibility(node, { deferOutputSync });
    addTranslationButtons(node);
  }
  addRunPreview(node);

  if (!deferOutputSync) setTimeout(() => forceOutputSync(node), 100);
  setTimeout(() => safeResize(node), 140);
}

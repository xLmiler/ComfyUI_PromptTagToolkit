import {
  DEFAULT_MESSAGES_TEMPLATE,
  DEFAULT_SYSTEM_PROMPT,
  fetchJson,
  getSetting,
  setSetting,
  toast,
  uuid,
} from "./ptt_common.js";

const SETTINGS = {
  baseUrl: "PromptTagToolkit.AI.BaseURL",
  apiKey: "PromptTagToolkit.AI.ApiKey",
  model: "PromptTagToolkit.AI.Model",
  systemPrompt: "PromptTagToolkit.AI.SystemPrompt",
  messagesTemplate: "PromptTagToolkit.AI.MessagesTemplate",
  messagesConfig: "PromptTagToolkit.AI.MessagesConfig",
  timeout: "PromptTagToolkit.AI.Timeout",
  modelsCache: "PromptTagToolkit.AI.ModelsCache",
};

const LOCKED_KIND = "translation_payload";
const ALLOWED_ROLES = ["system", "user", "assistant"];

function safeParseJson(value, fallback) {
  try {
    const parsed = JSON.parse(String(value ?? ""));
    return parsed ?? fallback;
  } catch {
    return fallback;
  }
}

function normalizeRow(row, index = 0) {
  const locked = row?.kind === LOCKED_KIND || row?.locked === true;
  return {
    id: String(row?.id || uuid("msg")),
    role: ALLOWED_ROLES.includes(String(row?.role || "user")) ? String(row.role) : "user",
    content: locked ? "{{text}}" : String(row?.content ?? ""),
    kind: locked ? LOCKED_KIND : "message",
    locked,
    order: Number.isFinite(Number(row?.order)) ? Number(row.order) : index,
  };
}

function defaultRows() {
  return [
    normalizeRow({
      id: "default_system",
      role: "system",
      content: DEFAULT_SYSTEM_PROMPT,
      kind: "message",
    }, 0),
    normalizeRow({
      id: "default_instruction",
      role: "user",
      content: "Translate from {{source_language}} to {{target_language}}. Return only a JSON array with exactly the same number of strings as the input segments.",
      kind: "message",
    }, 1),
    normalizeRow({
      id: "translation_payload",
      role: "user",
      content: "{{text}}",
      kind: LOCKED_KIND,
      locked: true,
    }, 2),
  ];
}

function migrateLegacyTemplate() {
  const currentSystem = String(getSetting(SETTINGS.systemPrompt, DEFAULT_SYSTEM_PROMPT) || DEFAULT_SYSTEM_PROMPT);
  const legacy = safeParseJson(getSetting(SETTINGS.messagesTemplate, DEFAULT_MESSAGES_TEMPLATE), null);
  if (!Array.isArray(legacy) || !legacy.length) return defaultRows();

  const rows = [];
  let hasLocked = false;
  for (const item of legacy) {
    if (!item || typeof item !== "object") continue;
    let role = ALLOWED_ROLES.includes(String(item.role)) ? String(item.role) : "user";
    let content = String(item.content ?? "").replaceAll("{{system_prompt}}", currentSystem);
    if (content.includes("{{text}}")) {
      const withoutPayload = content.replaceAll("{{text}}", "").replace(/\s+/g, " ").trim();
      if (withoutPayload) rows.push(normalizeRow({ role, content: withoutPayload }));
      rows.push(normalizeRow({ id: "translation_payload", role: "user", kind: LOCKED_KIND, locked: true }));
      hasLocked = true;
    } else {
      rows.push(normalizeRow({ role, content }));
    }
  }
  if (!hasLocked) rows.push(normalizeRow({ id: "translation_payload", role: "user", kind: LOCKED_KIND, locked: true }));
  return rows.length ? rows : defaultRows();
}

export function loadMessageRows() {
  const config = safeParseJson(getSetting(SETTINGS.messagesConfig, ""), null);
  let rows = Array.isArray(config?.rows) ? config.rows.map(normalizeRow) : migrateLegacyTemplate();

  // Exactly one immutable translation payload row is kept. This is important
  // because the backend substitutes {{text}} with the current segment JSON.
  let lockedIndex = rows.findIndex((row) => row.locked || row.kind === LOCKED_KIND);
  if (lockedIndex < 0) {
    rows.push(normalizeRow({ id: "translation_payload", role: "user", kind: LOCKED_KIND, locked: true }));
    lockedIndex = rows.length - 1;
  }
  rows = rows.filter((row, index) => !(index !== lockedIndex && (row.locked || row.kind === LOCKED_KIND)));
  rows = rows.map((row, index) => normalizeRow(row, index));
  return rows;
}

export function compileMessagesTemplate(rows = loadMessageRows()) {
  return JSON.stringify(rows.map((row) => ({ role: row.role, content: row.locked ? "{{text}}" : row.content })));
}

async function persistRows(rows) {
  const normalized = rows.map((row, index) => ({ ...normalizeRow(row, index), order: index }));
  const config = JSON.stringify({ version: 2, rows: normalized });
  await setSetting(SETTINGS.messagesConfig, config);
  await setSetting(SETTINGS.messagesTemplate, compileMessagesTemplate(normalized));

  // Keep the legacy setting meaningful for older workflows/plugin downgrades.
  const firstSystem = normalized.find((row) => row.role === "system" && !row.locked)?.content;
  if (firstSystem) await setSetting(SETTINGS.systemPrompt, firstSystem);
}

function createEl(tag, className = "", text = "") {
  const el = document.createElement(tag);
  if (className) el.className = className;
  if (text) el.textContent = text;
  return el;
}

function field(label, control, hint = "") {
  const wrap = createEl("div", "ptt-ai-field");
  const lab = createEl("label", "ptt-ai-label", label);
  wrap.append(lab, control);
  if (hint) wrap.append(createEl("div", "ptt-ai-hint", hint));
  return wrap;
}

function makeTextInput(value = "", type = "text") {
  const input = createEl("input", "ptt-ai-input");
  input.type = type;
  input.value = String(value ?? "");
  input.autocomplete = "off";
  input.spellcheck = false;
  return input;
}

function makeButton(label, className = "") {
  const button = createEl("button", `ptt-ai-button ${className}`.trim(), label);
  button.type = "button";
  return button;
}

function providerSummary() {
  const base = String(getSetting(SETTINGS.baseUrl, "https://api.openai.com/v1") || "");
  const model = String(getSetting(SETTINGS.model, "") || "");
  let host = base;
  try { host = new URL(base).host || base; } catch { /* keep raw */ }
  return model ? `${host} · ${model}` : `${host} · 未选择模型`;
}

class AiManagerModal {
  constructor() {
    this.rows = loadMessageRows();
    this.models = safeParseJson(getSetting(SETTINGS.modelsCache, "[]"), []);
    if (!Array.isArray(this.models)) this.models = [];
    this.dragIndex = -1;
  }

  open() {
    if (document.querySelector(".ptt-ai-overlay")) return;
    this.overlay = createEl("div", "ptt-ai-overlay");
    this.window = createEl("section", "ptt-ai-window");
    this.overlay.append(this.window);
    document.body.append(this.overlay);

    this.overlay.addEventListener("mousedown", (e) => {
      if (e.target === this.overlay) this.close();
    });
    this._onKey = (e) => { if (e.key === "Escape") this.close(); };
    window.addEventListener("keydown", this._onKey, true);
    this.render();
  }

  close() {
    window.removeEventListener("keydown", this._onKey, true);
    this.overlay?.remove();
  }

  render() {
    this.window.innerHTML = "";
    const header = createEl("header", "ptt-ai-header");
    const titleWrap = createEl("div", "ptt-ai-title-wrap");
    titleWrap.append(createEl("div", "ptt-ai-title", "⚙ API 管理器"), createEl("div", "ptt-ai-subtitle", "OpenAI 兼容翻译服务配置"));
    const close = makeButton("×", "ptt-ai-close");
    close.title = "关闭";
    close.onclick = () => this.close();
    header.append(titleWrap, close);

    const body = createEl("div", "ptt-ai-body");
    const left = createEl("div", "ptt-ai-column ptt-ai-column-left");
    const right = createEl("div", "ptt-ai-column ptt-ai-column-right");
    body.append(left, right);

    this.renderConnection(left);
    this.renderModels(left);
    this.renderMessages(right);

    const footer = createEl("footer", "ptt-ai-footer");
    const note = createEl("div", "ptt-ai-footer-note", "API Key 保存在当前 ComfyUI 用户设置中；翻译请求由本地 ComfyUI 后端转发。" );
    const cancel = makeButton("取消");
    cancel.onclick = () => this.close();
    const save = makeButton("保存配置", "primary");
    save.onclick = () => this.save();
    footer.append(note, cancel, save);

    this.window.append(header, body, footer);
  }

  renderConnection(parent) {
    const card = createEl("section", "ptt-ai-card");
    card.append(createEl("div", "ptt-ai-card-title", "1 连接配置"));

    this.baseUrlInput = makeTextInput(getSetting(SETTINGS.baseUrl, "https://api.openai.com/v1"));
    this.apiKeyInput = makeTextInput(getSetting(SETTINGS.apiKey, ""), "password");
    this.timeoutInput = makeTextInput(getSetting(SETTINGS.timeout, 90), "number");
    this.timeoutInput.min = "10";
    this.timeoutInput.max = "600";

    const keyWrap = createEl("div", "ptt-ai-key-wrap");
    keyWrap.append(this.apiKeyInput);
    const reveal = makeButton("显示", "compact");
    reveal.onclick = () => {
      const show = this.apiKeyInput.type === "password";
      this.apiKeyInput.type = show ? "text" : "password";
      reveal.textContent = show ? "隐藏" : "显示";
    };
    keyWrap.append(reveal);

    card.append(
      field("Base URL", this.baseUrlInput, "例如 https://api.openai.com/v1 或任意 OpenAI 兼容 /v1 地址。"),
      field("API Key", keyWrap),
      field("超时（秒）", this.timeoutInput)
    );
    parent.append(card);
  }

  async fetchModels() {
    const button = this.modelFetchButton;
    const old = button.textContent;
    button.disabled = true;
    button.textContent = "拉取中…";
    try {
      const data = await fetchJson("/ptt/ai/models", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          base_url: this.baseUrlInput.value.trim(),
          api_key: this.apiKeyInput.value,
          timeout: Number(this.timeoutInput.value || 90),
        }),
      });
      this.models = Array.isArray(data.models) ? data.models : [];
      await setSetting(SETTINGS.modelsCache, JSON.stringify(this.models));
      this.renderModelList();
      toast("success", "模型列表已更新", `共 ${this.models.length} 个模型`, 2600);
    } catch (e) {
      toast("error", "拉取模型失败", e.message || String(e), 6000);
    } finally {
      button.disabled = false;
      button.textContent = old;
    }
  }

  renderModels(parent) {
    const card = createEl("section", "ptt-ai-card ptt-ai-model-card");
    const head = createEl("div", "ptt-ai-card-head");
    head.append(createEl("div", "ptt-ai-card-title", "2 模型"));
    this.modelFetchButton = makeButton("↻ 拉取模型", "small");
    this.modelFetchButton.onclick = () => this.fetchModels();
    head.append(this.modelFetchButton);
    card.append(head);

    this.manualModelInput = makeTextInput(this.selectedModel ?? (getSetting(SETTINGS.model, "") || ""));
    this.manualModelInput.placeholder = "当前模型 / 手动输入模型 ID";
    this.manualModelInput.addEventListener("input", () => {
      this.selectedModel = this.manualModelInput.value.trim();
      this.renderModelList();
    });
    card.append(field("当前模型", this.manualModelInput, "可从下方拉取列表选择；不支持 /models 的服务也可以直接手动填写模型 ID。"));

    this.modelSearch = makeTextInput("");
    this.modelSearch.placeholder = "搜索已缓存模型…";
    this.modelSearch.addEventListener("input", () => this.renderModelList());
    card.append(this.modelSearch);

    this.modelList = createEl("div", "ptt-ai-model-list");
    card.append(this.modelList);
    parent.append(card);
    this.renderModelList();
  }

  renderModelList() {
    if (!this.modelList) return;
    this.modelList.innerHTML = "";
    const current = String(this.selectedModel ?? (getSetting(SETTINGS.model, "") || ""));
    const q = String(this.modelSearch?.value || "").trim().toLowerCase();
    const models = this.models.filter((m) => !q || String(m).toLowerCase().includes(q));

    if (!models.length) {
      const empty = createEl("div", "ptt-ai-model-empty", this.models.length ? "没有匹配的模型" : "尚未缓存模型，点击“拉取模型”读取 /models");
      this.modelList.append(empty);
      return;
    }

    for (const model of models) {
      const row = createEl("button", `ptt-ai-model-row${String(model) === current ? " selected" : ""}`);
      row.type = "button";
      row.append(createEl("span", "ptt-ai-model-dot"), createEl("span", "ptt-ai-model-name", String(model)));
      if (String(model) === current) row.append(createEl("span", "ptt-ai-model-check", "✓"));
      row.onclick = () => {
        this.selectedModel = String(model);
        if (this.manualModelInput) this.manualModelInput.value = this.selectedModel;
        this.renderModelList();
      };
      this.modelList.append(row);
    }
  }

  renderMessages(parent) {
    const card = createEl("section", "ptt-ai-card ptt-ai-message-card");
    const head = createEl("div", "ptt-ai-card-head");
    const title = createEl("div", "ptt-ai-card-title", "3 Messages 请求结构");
    const add = makeButton("＋ 添加 Message", "small");
    add.onclick = () => {
      const lockedIndex = this.rows.findIndex((r) => r.locked);
      const row = normalizeRow({ role: "user", content: "" });
      if (lockedIndex >= 0) this.rows.splice(lockedIndex, 0, row); else this.rows.push(row);
      this.renderMessagesOnly();
    };
    head.append(title, add);
    card.append(head);
    card.append(createEl("div", "ptt-ai-message-help", "可使用 {{source_language}}、{{target_language}}。固定的 {{text}} 行由插件注入当前翻译文本，不能修改或删除。拖动左侧把手或使用 ↑ ↓ 调整顺序。"));

    this.messageList = createEl("div", "ptt-ai-message-list");
    card.append(this.messageList);
    parent.append(card);
    this.renderMessagesOnly();
  }

  moveRow(index, delta) {
    const target = index + delta;
    if (target < 0 || target >= this.rows.length) return;
    const [row] = this.rows.splice(index, 1);
    this.rows.splice(target, 0, row);
    this.renderMessagesOnly();
  }

  renderMessagesOnly() {
    if (!this.messageList) return;
    this.messageList.innerHTML = "";
    this.rows.forEach((row, index) => {
      const item = createEl("div", `ptt-ai-message-row${row.locked ? " locked" : ""}`);
      item.draggable = true;
      item.dataset.index = String(index);

      const drag = createEl("div", "ptt-ai-drag", "⋮⋮");
      drag.title = "拖动排序";
      const role = createEl("select", "ptt-ai-role");
      for (const value of ALLOWED_ROLES) {
        const option = document.createElement("option");
        option.value = value;
        option.textContent = value;
        role.append(option);
      }
      role.value = row.role;
      role.disabled = row.locked;
      role.onchange = () => { row.role = role.value; };

      const content = createEl("textarea", "ptt-ai-message-content");
      content.value = row.locked ? "{{text}}" : row.content;
      content.placeholder = row.locked ? "当前翻译文本占位" : "Message content";
      content.readOnly = row.locked;
      content.oninput = () => { if (!row.locked) row.content = content.value; };

      const actions = createEl("div", "ptt-ai-message-actions");
      const up = makeButton("↑", "icon");
      const down = makeButton("↓", "icon");
      up.title = "上移";
      down.title = "下移";
      up.disabled = index === 0;
      down.disabled = index === this.rows.length - 1;
      up.onclick = () => this.moveRow(index, -1);
      down.onclick = () => this.moveRow(index, 1);
      actions.append(up, down);
      if (row.locked) {
        const lock = createEl("span", "ptt-ai-lock", "🔒 固定占位");
        actions.append(lock);
      } else {
        const del = makeButton("✕", "icon danger");
        del.title = "删除 Message";
        del.onclick = () => {
          this.rows.splice(index, 1);
          this.renderMessagesOnly();
        };
        actions.append(del);
      }

      item.append(drag, role, content, actions);
      item.addEventListener("dragstart", (e) => {
        this.dragIndex = index;
        item.classList.add("dragging");
        e.dataTransfer.effectAllowed = "move";
        e.dataTransfer.setData("text/plain", String(index));
      });
      item.addEventListener("dragend", () => {
        this.dragIndex = -1;
        item.classList.remove("dragging");
      });
      item.addEventListener("dragover", (e) => { e.preventDefault(); e.dataTransfer.dropEffect = "move"; });
      item.addEventListener("drop", (e) => {
        e.preventDefault();
        const from = Number(e.dataTransfer.getData("text/plain"));
        const to = index;
        if (!Number.isInteger(from) || from === to || from < 0 || from >= this.rows.length) return;
        const [moved] = this.rows.splice(from, 1);
        this.rows.splice(to, 0, moved);
        this.renderMessagesOnly();
      });
      this.messageList.append(item);
    });
  }

  async save() {
    const baseUrl = this.baseUrlInput.value.trim();
    if (!/^https?:\/\//i.test(baseUrl)) {
      toast("error", "Base URL 无效", "必须以 http:// 或 https:// 开头。", 4000);
      return;
    }
    const lockedCount = this.rows.filter((row) => row.locked || row.kind === LOCKED_KIND).length;
    if (lockedCount !== 1) {
      toast("error", "Message 结构无效", "必须且只能有一个固定翻译文本占位行。", 4500);
      return;
    }
    if (!this.rows.some((row) => !row.locked && row.content.trim())) {
      toast("error", "Message 结构为空", "至少需要一个可编辑的 system / user / assistant Message。", 4500);
      return;
    }
    if (this.rows.some((row) => !row.locked && row.content.includes("{{text}}"))) {
      toast("error", "{{text}} 只能使用固定占位行", "普通 Message 请不要再写 {{text}}；翻译文本由带锁图标的固定行注入。", 5000);
      return;
    }

    await setSetting(SETTINGS.baseUrl, baseUrl.replace(/\/$/, ""));
    await setSetting(SETTINGS.apiKey, this.apiKeyInput.value);
    await setSetting(SETTINGS.timeout, Math.max(10, Math.min(600, Number(this.timeoutInput.value || 90))));
    const selectedModel = String(
      this.manualModelInput
        ? this.manualModelInput.value.trim()
        : (this.selectedModel ?? (getSetting(SETTINGS.model, "") || ""))
    );
    await setSetting(SETTINGS.model, selectedModel);
    await persistRows(this.rows);
    document.querySelectorAll(".ptt-ai-setting-summary").forEach((el) => {
      el.textContent = providerSummary();
    });
    toast("success", "AI 翻译配置已保存", providerSummary(), 3000);
    this.close();
  }
}

export function openAiManager() {
  new AiManagerModal().open();
}

export function aiManagerSettingRenderer(name) {
  const wrap = createEl("div", "ptt-ai-setting-renderer");
  const text = createEl("div", "ptt-ai-setting-copy");
  text.append(createEl("div", "ptt-ai-setting-title", name || "AI API 管理器"));
  const summary = createEl("div", "ptt-ai-setting-summary", providerSummary());
  text.append(summary);
  const button = makeButton("打开 API 管理器", "primary");
  button.onclick = () => openAiManager();
  wrap.append(text, button);
  return wrap;
}

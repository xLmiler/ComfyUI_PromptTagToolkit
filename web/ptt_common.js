import { app } from "../../scripts/app.js";
import { api } from "../../scripts/api.js";

export const EXT_NAME = "PromptTagToolkit.Main";
export const API_PREFIX = "/ptt";
export const MAX_SEGMENTS = 12;

export const DEFAULT_SYSTEM_PROMPT = "You are a precise prompt translator. Preserve comma-separated tag structure, weights, punctuation, names, and prompt syntax. Do not add explanations. Return only a JSON array of translated strings in exactly the same order and length as the input segments.";

export const DEFAULT_MESSAGES_TEMPLATE = JSON.stringify([
  { role: "system", content: "{{system_prompt}}" },
  { role: "user", content: "Translate from {{source_language}} to {{target_language}}. Return only a JSON array with exactly the same number of strings as the input segments." },
  { role: "user", content: "{{text}}" }
]);

export function uuid(prefix = "id") {
  const c = globalThis.crypto;
  if (c?.randomUUID) return `${prefix}_${c.randomUUID().replaceAll("-", "")}`;
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 12)}`;
}

export function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

export function toast(severity, summary, detail = "", life = 3500) {
  try {
    app.extensionManager?.toast?.add({ severity, summary, detail, life });
  } catch {
    if (severity === "error") console.error(`[PTT] ${summary}`, detail);
    else console.log(`[PTT] ${summary}`, detail);
  }
}

export async function fetchJson(path, options = {}) {
  const response = await api.fetchApi(path, options);
  let data = null;
  try {
    data = await response.json();
  } catch {
    data = { success: false, error: await response.text().catch(() => "Unknown error") };
  }
  if (!response.ok || data?.success === false) {
    const error = new Error(data?.error || `${response.status} ${response.statusText}`);
    error.status = response.status;
    error.payload = data;
    throw error;
  }
  return data;
}

export function getSetting(id, fallback = undefined) {
  try {
    const v = app.extensionManager?.setting?.get(id);
    return v === undefined ? fallback : v;
  } catch {
    return fallback;
  }
}

export async function setSetting(id, value) {
  try {
    await app.extensionManager?.setting?.set(id, value);
  } catch (e) {
    console.warn("[PTT] Could not update setting", id, e);
  }
}

export function findWidget(node, name) {
  return node?.widgets?.find((w) => w?.name === name) || null;
}

export function setWidgetValue(node, name, value, invokeCallback = true) {
  const widget = findWidget(node, name);
  if (!widget) return false;
  widget.value = value;
  try { widget.options?.setValue?.(value); } catch { /* ignore */ }
  const element = widget.element || widget.inputEl;
  if (element && "value" in element && element.value !== value) {
    try { element.value = value; } catch { /* ignore */ }
  }
  if (invokeCallback && typeof widget.callback === "function") {
    try { widget.callback(value, app.canvas, node, null, null); } catch { /* ignore */ }
  }
  node?.setDirtyCanvas?.(true, true);
  return true;
}

export function getWidgetValue(node, name, fallback = "") {
  const widget = findWidget(node, name);
  return widget ? widget.value : fallback;
}

export function injectStyles() {
  if (document.getElementById("ptt-styles")) return;
  const style = document.createElement("style");
  style.id = "ptt-styles";
  style.textContent = `
:root {
  --ptt-bg: #17181b;
  --ptt-panel: #1f2024;
  --ptt-panel-2: #25262b;
  --ptt-border: #36383f;
  --ptt-border-strong: #4b4e57;
  --ptt-text: #ececf1;
  --ptt-muted: #9a9ca5;
  --ptt-accent: #62a8ff;
  --ptt-accent-soft: rgba(98,168,255,.16);
  --ptt-danger: #ff6b75;
  --ptt-shadow: 0 20px 70px rgba(0,0,0,.45);
}
.ptt-overlay { position: fixed; inset: 0; z-index: 100000; background: rgba(0,0,0,.28); display:flex; align-items:flex-start; justify-content:center; padding-top:min(10vh,90px); font: 13px/1.4 Inter, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; color:var(--ptt-text); }
.ptt-window { width:min(920px, 92vw); height:min(650px, 78vh); min-width:620px; min-height:420px; background:var(--ptt-bg); border:1px solid var(--ptt-border-strong); border-radius:10px; box-shadow:var(--ptt-shadow); overflow:hidden; display:flex; flex-direction:column; }
.ptt-header { height:48px; flex:0 0 auto; display:flex; align-items:center; gap:10px; padding:0 12px; border-bottom:1px solid var(--ptt-border); background:#1a1b1f; }
.ptt-title { display:flex; align-items:center; gap:8px; font-weight:650; min-width:150px; }
.ptt-title svg { width:17px; height:17px; fill:none; stroke:currentColor; stroke-width:1.7; }
.ptt-search { flex:1; max-width:420px; margin-left:auto; height:30px; border-radius:15px; border:1px solid transparent; outline:none; padding:0 13px; background:#24252a; color:var(--ptt-text); transition:.15s; }
.ptt-search:focus { border-color:#4e515a; box-shadow:0 0 0 2px rgba(98,168,255,.12); }
.ptt-icon-btn { width:30px; height:30px; display:grid; place-items:center; border:0; border-radius:7px; background:transparent; color:#c8cad1; cursor:pointer; }
.ptt-icon-btn:hover { background:#2c2e34; color:#fff; }
.ptt-icon-btn svg { width:16px; height:16px; fill:none; stroke:currentColor; stroke-width:1.8; stroke-linecap:round; stroke-linejoin:round; }
.ptt-tabsbar { min-height:46px; flex:0 0 auto; display:flex; align-items:stretch; gap:4px; padding:0 10px; border-bottom:1px solid var(--ptt-border); background:#1b1c20; overflow-x:auto; }
.ptt-tab { position:relative; display:flex; align-items:center; gap:6px; padding:0 12px; border:0; background:transparent; color:#aeb0b8; cursor:pointer; white-space:nowrap; font-size:13px; }
.ptt-tab:hover { color:#fff; background:rgba(255,255,255,.035); }
.ptt-tab.active { color:#fff; font-weight:600; }
.ptt-tab.active::after { content:""; position:absolute; left:8px; right:8px; bottom:0; height:2px; border-radius:2px; background:var(--ptt-accent); }
.ptt-tab-add { align-self:center; width:28px; height:28px; border-radius:50%; border:0; background:transparent; color:#858892; font-size:20px; cursor:pointer; }
.ptt-tab-add:hover { background:#2b2d33; color:#fff; }
.ptt-toolbar { display:flex; align-items:center; gap:8px; padding:9px 12px; border-bottom:1px solid #2b2d32; }
.ptt-mode-btn { border:1px solid var(--ptt-border); background:#222329; color:#bfc1c8; border-radius:7px; padding:5px 9px; cursor:pointer; }
.ptt-mode-btn.active { border-color:#4c78a8; color:#fff; background:var(--ptt-accent-soft); }
.ptt-primary { margin-left:auto; border:1px solid #4d79a7; background:#284e76; color:#fff; border-radius:7px; padding:6px 11px; cursor:pointer; }
.ptt-primary:hover { background:#315d8d; }
.ptt-content { position:relative; flex:1; min-height:0; overflow:auto; padding:12px; }
.ptt-chip-grid { display:flex; flex-wrap:wrap; align-content:flex-start; gap:9px 10px; }
.ptt-chip { position:relative; display:inline-flex; align-items:center; min-height:30px; padding:5px 32px 5px 11px; border-radius:16px; border:1px solid #3b3d44; background:#2a2b30; color:#f2f2f5; cursor:pointer; user-select:none; transition:.13s; max-width:100%; }
.ptt-chip:hover { background:#33353b; border-color:#50535d; transform:translateY(-1px); }
.ptt-chip-label { overflow:hidden; text-overflow:ellipsis; white-space:nowrap; max-width:240px; }
.ptt-edit { position:absolute; right:6px; top:50%; width:22px; height:22px; transform:translateY(-50%); border:0; border-radius:50%; display:none; place-items:center; background:#3c3e45; color:#fff; cursor:pointer; }
.ptt-chip:hover .ptt-edit, .ptt-card:hover .ptt-edit { display:grid; }
.ptt-edit:hover { background:#4d515b; }
.ptt-edit svg { width:12px; height:12px; fill:none; stroke:currentColor; stroke-width:2; }
.ptt-card-grid { display:grid; grid-template-columns:repeat(auto-fill, minmax(138px, 1fr)); gap:14px; align-content:start; }
.ptt-card { position:relative; height:146px; border:1px solid #373941; border-radius:9px; background:#24252a; overflow:hidden; cursor:pointer; transform-origin:center; transition:transform .16s ease, border-color .16s ease, box-shadow .16s ease; }
.ptt-card:hover { transform:rotate(-1.2deg) scale(1.02); border-color:#555a66; box-shadow:0 8px 25px rgba(0,0,0,.25); }
.ptt-card-preview { height:108px; display:flex; align-items:center; justify-content:center; background:transparent; border-bottom:1px solid #33353a; overflow:hidden; }
.ptt-card-preview img { width:100%; height:100%; object-fit:contain; object-position:center; transition:opacity .12s ease; }
.ptt-card-preview img:not([src]) { opacity:0; }
.ptt-card-placeholder { color:#666a75; font-size:11px; }
.ptt-card-label { height:37px; display:flex; align-items:center; justify-content:center; padding:0 8px; text-align:center; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
.ptt-card .ptt-edit { top:9px; right:9px; transform:none; background:rgba(18,19,22,.82); }
.ptt-preview-float { position:fixed; z-index:100002; width:260px; height:200px; pointer-events:none; border:1px solid #4b4e57; border-radius:8px; background:#1d1e22; box-shadow:0 12px 38px rgba(0,0,0,.45); padding:7px; display:none; }
.ptt-preview-float img { width:100%; height:100%; object-fit:contain; object-position:center; }
.ptt-empty { height:100%; display:grid; place-items:center; color:#777a84; text-align:center; }
.ptt-dialog-overlay { position:fixed; inset:0; z-index:100003; background:rgba(0,0,0,.45); display:grid; place-items:center; }
.ptt-dialog { width:min(520px, 90vw); max-height:86vh; overflow:auto; border:1px solid var(--ptt-border-strong); border-radius:10px; background:#1c1d21; box-shadow:var(--ptt-shadow); padding:16px; }
.ptt-dialog h3 { margin:0 0 14px; font-size:15px; }
.ptt-field { margin:10px 0; }
.ptt-field label { display:block; margin:0 0 5px; color:#b9bbc3; font-size:12px; }
.ptt-field input, .ptt-field textarea, .ptt-field select { width:100%; box-sizing:border-box; border:1px solid #3d4048; border-radius:7px; background:#25262b; color:#f3f3f5; outline:none; padding:8px 9px; }
.ptt-field textarea { min-height:105px; resize:vertical; }
.ptt-field input:focus, .ptt-field textarea:focus, .ptt-field select:focus { border-color:#5e8fc4; box-shadow:0 0 0 2px rgba(98,168,255,.1); }
.ptt-preview-editor { height:150px; border:1px dashed #454850; border-radius:8px; display:flex; align-items:center; justify-content:center; overflow:hidden; background:transparent; transition:border-color .12s ease, background .12s ease, box-shadow .12s ease; }
.ptt-preview-editor img { width:100%; height:100%; object-fit:contain; }
.ptt-preview-editor.dragover { border-color:#62a8ff; background:rgba(98,168,255,.08); box-shadow:0 0 0 2px rgba(98,168,255,.12) inset; }
.ptt-preview-editor.uploading { opacity:.8; }
.ptt-preview-drop-hint { color:#777b86; text-align:center; padding:12px; pointer-events:none; }
.ptt-dialog-actions { display:flex; gap:8px; justify-content:flex-end; margin-top:14px; }
.ptt-btn { border:1px solid #41444c; border-radius:7px; background:#2a2c31; color:#dddfe5; padding:7px 11px; cursor:pointer; }
.ptt-btn:hover { background:#35373e; }
.ptt-btn.danger { color:#ff9aa1; border-color:#614048; margin-right:auto; }
.ptt-btn.primary { background:#2b5681; border-color:#4d7baa; color:#fff; }
.ptt-node-preview { width:100%; min-height:96px; max-height:190px; border:1px dashed #44474f; border-radius:7px; display:flex; align-items:center; justify-content:center; overflow:hidden; background:transparent; box-sizing:border-box; color:#767983; font:12px sans-serif; }
.ptt-node-preview img { width:100%; height:100%; max-height:184px; object-fit:contain; object-position:center; display:block; }
.ptt-node-preview.ptt-dragover, .ptt-node-image-input.ptt-dragover { border-color:#62a8ff !important; box-shadow:0 0 0 2px rgba(98,168,255,.16) inset !important; }
.ptt-node-preview.uploading, .ptt-node-image-input.uploading { opacity:.78; }
.ptt-node-run-preview { width:100%; min-height:72px; max-height:145px; overflow:auto; white-space:pre-wrap; word-break:break-word; border:1px solid #3e4148; border-radius:6px; padding:7px; box-sizing:border-box; color:#d6d8df; background:#232429; font:12px/1.35 monospace; }
.ptt-node-status { font:11px/1.3 sans-serif; color:#9699a4; padding:2px 0; }
.ptt-node-image-input { box-sizing:border-box !important; width:calc(100% - 72px) !important; height:78px !important; min-height:78px !important; max-height:78px !important; margin-left:36px !important; margin-right:36px !important; transform:translateY(-8px) !important; resize:none !important; cursor:pointer !important; overflow:hidden !important; color:transparent !important; caret-color:transparent !important; text-shadow:none !important; background-color:#17181c !important; background-repeat:no-repeat !important; background-position:center !important; background-size:contain !important; border:1px solid #3b3e46 !important; border-radius:7px !important; text-align:center !important; }
.ptt-node-image-input::placeholder { color:#8b8e98 !important; opacity:1 !important; white-space:pre-line; }
.ptt-node-image-input.has-image { border-color:#4b5260 !important; }

/* Dedicated AI manager shown from the ComfyUI settings custom renderer. */
.ptt-ai-setting-renderer { width:100%; min-width:360px; box-sizing:border-box; display:flex; align-items:center; gap:18px; justify-content:space-between; padding:10px 12px; border:1px solid #34363d; border-radius:8px; background:#1d1e22; color:var(--ptt-text); }
.ptt-ai-setting-copy { min-width:0; }
.ptt-ai-setting-title { font-size:13px; font-weight:650; color:#f0f1f4; }
.ptt-ai-setting-summary { margin-top:3px; font-size:11px; color:#8f929c; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; max-width:620px; }
.ptt-ai-overlay { position:fixed; inset:0; z-index:100020; display:grid; place-items:center; padding:28px; box-sizing:border-box; background:rgba(0,0,0,.58); color:var(--ptt-text); font:13px/1.4 Inter,system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif; }
.ptt-ai-window { width:min(1120px,96vw); height:min(780px,92vh); min-width:760px; min-height:560px; overflow:hidden; display:flex; flex-direction:column; border:1px solid #454851; border-radius:10px; background:#18191d; box-shadow:0 28px 90px rgba(0,0,0,.58); }
.ptt-ai-header { flex:0 0 62px; display:flex; align-items:center; justify-content:space-between; gap:16px; padding:0 18px; border-bottom:1px solid #33353c; background:#1b1c20; }
.ptt-ai-title-wrap { min-width:0; }
.ptt-ai-title { font-size:16px; font-weight:700; color:#f4f4f7; }
.ptt-ai-subtitle { margin-top:2px; color:#8d909a; font-size:11px; }
.ptt-ai-close { width:34px !important; min-width:34px !important; height:34px !important; padding:0 !important; font-size:25px !important; line-height:1 !important; background:transparent !important; border-color:transparent !important; }
.ptt-ai-close:hover { background:#2b2d33 !important; }
.ptt-ai-body { flex:1; min-height:0; display:grid; grid-template-columns:minmax(310px,38%) minmax(430px,62%); }
.ptt-ai-column { min-height:0; overflow:auto; padding:16px; box-sizing:border-box; }
.ptt-ai-column-left { border-right:1px solid #303239; background:#191a1e; }
.ptt-ai-column-right { background:#18191d; }
.ptt-ai-card { border:1px solid #34363d; border-radius:9px; background:#202126; padding:14px; margin-bottom:14px; box-sizing:border-box; }
.ptt-ai-card:last-child { margin-bottom:0; }
.ptt-ai-card-head { display:flex; align-items:center; gap:10px; margin-bottom:11px; }
.ptt-ai-card-title { font-weight:700; font-size:13px; color:#e9eaee; }
.ptt-ai-card-head .ptt-ai-button { margin-left:auto; }
.ptt-ai-field { margin:11px 0; }
.ptt-ai-label { display:block; margin-bottom:5px; color:#b8bbc4; font-size:11px; font-weight:600; }
.ptt-ai-hint { margin-top:5px; color:#777b86; font-size:10.5px; }
.ptt-ai-input, .ptt-ai-role, .ptt-ai-message-content { box-sizing:border-box; width:100%; border:1px solid #3b3e47; border-radius:7px; outline:none; background:#17181c; color:#f0f0f3; font:12px/1.35 Inter,system-ui,sans-serif; }
.ptt-ai-input { height:34px; padding:0 9px; }
.ptt-ai-input:focus, .ptt-ai-role:focus, .ptt-ai-message-content:focus { border-color:#5688bf; box-shadow:0 0 0 2px rgba(86,136,191,.14); }
.ptt-ai-key-wrap { display:flex; gap:6px; }
.ptt-ai-key-wrap .ptt-ai-input { flex:1; min-width:0; }
.ptt-ai-button { border:1px solid #434650; border-radius:7px; background:#292b31; color:#dadce2; padding:7px 11px; cursor:pointer; font:12px/1.2 Inter,system-ui,sans-serif; white-space:nowrap; }
.ptt-ai-button:hover:not(:disabled) { background:#34373e; color:#fff; }
.ptt-ai-button:disabled { opacity:.45; cursor:not-allowed; }
.ptt-ai-button.primary { border-color:#4e7eb5; background:#315f96; color:#fff; }
.ptt-ai-button.primary:hover:not(:disabled) { background:#3970ad; }
.ptt-ai-button.small { padding:5px 9px; font-size:11px; }
.ptt-ai-button.compact { padding:0 9px; height:34px; }
.ptt-ai-button.icon { width:27px; min-width:27px; height:27px; padding:0; display:grid; place-items:center; }
.ptt-ai-button.danger { color:#ff939b; border-color:#604148; }
.ptt-ai-model-card { min-height:250px; }
.ptt-ai-model-card > .ptt-ai-input { margin-bottom:8px; }
.ptt-ai-model-list { height:210px; overflow:auto; border:1px solid #34363e; border-radius:7px; background:#17181c; padding:4px; box-sizing:border-box; }
.ptt-ai-model-row { width:100%; min-height:31px; display:flex; align-items:center; gap:8px; border:0; border-radius:5px; background:transparent; color:#cfd1d7; text-align:left; cursor:pointer; padding:5px 8px; }
.ptt-ai-model-row:hover { background:#27292f; }
.ptt-ai-model-row.selected { background:rgba(79,132,198,.2); color:#fff; }
.ptt-ai-model-dot { width:7px; height:7px; border-radius:50%; background:#555a65; flex:0 0 auto; }
.ptt-ai-model-row.selected .ptt-ai-model-dot { background:#6ba9f5; box-shadow:0 0 0 3px rgba(107,169,245,.12); }
.ptt-ai-model-name { flex:1; min-width:0; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; font-size:11px; }
.ptt-ai-model-check { color:#7bb4f8; }
.ptt-ai-model-empty { min-height:100%; display:grid; place-items:center; text-align:center; color:#747883; font-size:11px; padding:14px; box-sizing:border-box; }
.ptt-ai-message-card { min-height:100%; display:flex; flex-direction:column; }
.ptt-ai-message-help { margin:-2px 0 10px; color:#7f838e; font-size:10.5px; }
.ptt-ai-message-list { flex:1; min-height:0; overflow:auto; display:flex; flex-direction:column; gap:8px; padding-right:2px; }
.ptt-ai-message-row { display:grid; grid-template-columns:24px 92px minmax(0,1fr) 92px; gap:7px; align-items:start; border:1px solid #373941; border-radius:8px; background:#1a1b1f; padding:8px; }
.ptt-ai-message-row.locked { border-color:#4b5360; background:#1d2025; }
.ptt-ai-message-row.dragging { opacity:.55; }
.ptt-ai-drag { height:30px; display:grid; place-items:center; color:#747883; cursor:grab; user-select:none; letter-spacing:-2px; }
.ptt-ai-role { height:30px; padding:0 6px; }
.ptt-ai-message-content { min-height:62px; resize:vertical; padding:7px 8px; }
.ptt-ai-message-content[readonly] { color:#9da9b8; background:#171a1f; cursor:default; }
.ptt-ai-message-actions { min-height:30px; display:flex; align-items:center; justify-content:flex-end; gap:4px; flex-wrap:wrap; }
.ptt-ai-lock { width:100%; text-align:right; color:#8490a0; font-size:9.5px; white-space:nowrap; }
.ptt-ai-footer { flex:0 0 58px; display:flex; align-items:center; gap:8px; padding:0 16px; border-top:1px solid #33353c; background:#1b1c20; }
.ptt-ai-footer-note { flex:1; min-width:0; color:#777b85; font-size:10.5px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
@media (max-width:900px) {
  .ptt-ai-overlay { padding:10px; }
  .ptt-ai-window { min-width:0; width:98vw; height:95vh; }
  .ptt-ai-body { grid-template-columns:1fr; overflow:auto; }
  .ptt-ai-column { overflow:visible; }
  .ptt-ai-column-left { border-right:0; border-bottom:1px solid #303239; }
  .ptt-ai-message-row { grid-template-columns:20px 82px minmax(0,1fr); }
  .ptt-ai-message-actions { grid-column:2 / 4; justify-content:flex-start; }
}

`;
  document.head.appendChild(style);
}

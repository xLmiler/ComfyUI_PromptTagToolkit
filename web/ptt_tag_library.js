import { app } from "../../scripts/app.js";
import { API_PREFIX, escapeHtml, fetchJson, getSetting, setSetting, toast, uuid } from "./ptt_common.js";

const ICONS = {
  bookmark: `<svg viewBox="0 0 24 24"><path d="M6 4.8A2.8 2.8 0 0 1 8.8 2h6.4A2.8 2.8 0 0 1 18 4.8V22l-6-4-6 4V4.8Z"/></svg>`,
  close: `<svg viewBox="0 0 24 24"><path d="m6 6 12 12M18 6 6 18"/></svg>`,
  refresh: `<svg viewBox="0 0 24 24"><path d="M20 6v5h-5M4 18v-5h5"/><path d="M18.5 9A7 7 0 0 0 6.2 6.2L4 8M5.5 15A7 7 0 0 0 17.8 17.8L20 16"/></svg>`,
  edit: `<svg viewBox="0 0 24 24"><path d="M4 20h4L19 9l-4-4L4 16v4Z"/><path d="m13.5 6.5 4 4"/></svg>`
};

function el(tag, className = "", html = "") {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (html) node.innerHTML = html;
  return node;
}

function makeButton(className, title, html) {
  const b = el("button", className, html);
  b.type = "button";
  if (title) b.title = title;
  return b;
}

function sortByOrder(items) {
  return [...items].sort((a, b) => (Number(a.order) || 0) - (Number(b.order) || 0));
}

export class TagLibraryModal {
  constructor(options = {}) {
    this.options = options || {};
    this.library = null;
    this.activeCategory = null;
    this.search = "";
    this.viewMode = getSetting("PromptTagToolkit.Library.ViewMode", "chips") || "chips";
    this.root = null;
    this.previewFloat = null;
    this.lazyObserver = null;
    this._esc = (e) => { if (e.key === "Escape") this.close(); };
  }

  async open() {
    await this.reload();
    this.build();
    document.addEventListener("keydown", this._esc, true);
  }

  close() {
    document.removeEventListener("keydown", this._esc, true);
    this.lazyObserver?.disconnect?.();
    this.lazyObserver = null;
    this.previewFloat?.remove();
    this.root?.remove();
    this.root = null;
    try { this.options?.onClose?.(); } catch { /* ignore */ }
  }

  focusSearch() {
    try { this.searchInput?.focus?.({ preventScroll: true }); } catch { this.searchInput?.focus?.(); }
  }

  async reload() {
    const data = await fetchJson(`${API_PREFIX}/library`);
    this.library = data.library;
    const cats = sortByOrder(this.library.categories || []);
    if (!this.activeCategory || !cats.some((c) => c.id === this.activeCategory)) {
      this.activeCategory = cats[0]?.id || null;
    }
  }

  async save() {
    try {
      const data = await fetchJson(`${API_PREFIX}/library`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ library: this.library, expected_revision: this.library.revision })
      });
      this.library = data.library;
      this.renderTabs();
      this.renderContent();
      return true;
    } catch (e) {
      if (e.status === 409 && e.payload?.library) {
        this.library = e.payload.library;
        toast("warn", "标签库已被其他页面修改", "已重新加载最新版本，请重试刚才的操作。", 5000);
        this.renderTabs();
        this.renderContent();
        return false;
      }
      toast("error", "保存标签库失败", e.message || String(e));
      return false;
    }
  }

  build() {
    this.root = el("div", "ptt-overlay");
    const win = el("div", "ptt-window");
    this.root.appendChild(win);

    const header = el("div", "ptt-header");
    const title = el("div", "ptt-title", `${ICONS.bookmark}<span>用户标签</span>`);
    header.appendChild(title);
    this.searchInput = el("input", "ptt-search");
    this.searchInput.placeholder = "搜索标签...";
    this.searchInput.addEventListener("input", () => {
      this.search = this.searchInput.value.trim().toLowerCase();
      this.renderContent();
    });
    header.appendChild(this.searchInput);
    const refresh = makeButton("ptt-icon-btn", "刷新", ICONS.refresh);
    refresh.addEventListener("click", async () => { await this.reload(); this.renderTabs(); this.renderContent(); });
    const close = makeButton("ptt-icon-btn", "关闭", ICONS.close);
    close.addEventListener("click", () => this.close());
    header.append(refresh, close);
    win.appendChild(header);

    this.tabs = el("div", "ptt-tabsbar");
    win.appendChild(this.tabs);

    const toolbar = el("div", "ptt-toolbar");
    this.chipsBtn = makeButton("ptt-mode-btn", "标签模式", "标签");
    this.cardsBtn = makeButton("ptt-mode-btn", "卡牌模式", "卡牌");
    this.chipsBtn.addEventListener("click", () => this.setViewMode("chips"));
    this.cardsBtn.addEventListener("click", () => this.setViewMode("cards"));
    const editCat = makeButton("ptt-mode-btn", "编辑当前分类", "编辑分类");
    editCat.addEventListener("click", () => this.editCategory());
    const addTag = makeButton("ptt-primary", "添加标签", "+ 添加标签");
    addTag.addEventListener("click", () => this.editTag(null));
    toolbar.append(this.chipsBtn, this.cardsBtn, editCat, addTag);
    win.appendChild(toolbar);

    this.content = el("div", "ptt-content");
    win.appendChild(this.content);

    this.previewFloat = el("div", "ptt-preview-float");
    this.previewFloat.innerHTML = `<img alt="preview">`;
    document.body.appendChild(this.previewFloat);

    this.root.addEventListener("mousedown", (e) => {
      if (e.target === this.root) this.close();
    });
    document.body.appendChild(this.root);
    this.renderTabs();
    this.setViewMode(this.viewMode, false);
    setTimeout(() => this.searchInput.focus(), 0);
  }

  setViewMode(mode, persist = true) {
    this.viewMode = mode === "cards" ? "cards" : "chips";
    this.chipsBtn?.classList.toggle("active", this.viewMode === "chips");
    this.cardsBtn?.classList.toggle("active", this.viewMode === "cards");
    if (persist) setSetting("PromptTagToolkit.Library.ViewMode", this.viewMode);
    this.renderContent();
  }

  renderTabs() {
    if (!this.tabs) return;
    this.tabs.innerHTML = "";
    for (const cat of sortByOrder(this.library?.categories || [])) {
      const b = makeButton(`ptt-tab${cat.id === this.activeCategory ? " active" : ""}`, cat.name, escapeHtml(cat.name));
      b.addEventListener("click", () => {
        this.activeCategory = cat.id;
        this.renderTabs();
        this.renderContent();
      });
      b.addEventListener("dblclick", () => this.editCategory(cat));
      this.tabs.appendChild(b);
    }
    const add = makeButton("ptt-tab-add", "创建分类", "+");
    add.addEventListener("click", () => this.editCategory(null));
    this.tabs.appendChild(add);
  }

  filteredTags() {
    let tags = sortByOrder(this.library?.tags || []);
    if (this.search) {
      tags = tags.filter((t) => `${t.label} ${t.text}`.toLowerCase().includes(this.search));
    } else if (this.activeCategory) {
      tags = tags.filter((t) => t.category_id === this.activeCategory);
    }
    return tags;
  }

  renderContent() {
    if (!this.content || !this.library) return;
    this.lazyObserver?.disconnect?.();
    this.lazyObserver = null;
    this.content.innerHTML = "";
    const tags = this.filteredTags();
    if (!tags.length) {
      const empty = el("div", "ptt-empty", `<div>${this.search ? "没有匹配的标签" : "当前分类还没有标签"}<br><small>点击“添加标签”开始创建</small></div>`);
      this.content.appendChild(empty);
      return;
    }
    if (this.viewMode === "cards") this.renderCards(tags);
    else this.renderChips(tags);
  }

  renderChips(tags) {
    const grid = el("div", "ptt-chip-grid");
    for (const tag of tags) {
      const chip = el("div", "ptt-chip");
      chip.title = tag.text || tag.label;
      const label = el("span", "ptt-chip-label");
      label.textContent = tag.label;
      const edit = makeButton("ptt-edit", "编辑", ICONS.edit);
      edit.addEventListener("click", (e) => { e.stopPropagation(); this.editTag(tag); });
      chip.append(label, edit);
      chip.addEventListener("click", () => this.insertTag(tag));
      this.bindPreviewHover(chip, tag);
      grid.appendChild(chip);
    }
    this.content.appendChild(grid);
  }

  renderCards(tags) {
    const grid = el("div", "ptt-card-grid");
    for (const tag of tags) {
      const card = el("div", "ptt-card");
      const preview = el("div", "ptt-card-preview");
      if (tag.preview) {
        const img = document.createElement("img");
        img.alt = "";
        img.loading = "lazy";
        img.decoding = "async";
        img.dataset.src = `${API_PREFIX}/tag-preview-thumb/${encodeURIComponent(tag.preview)}`;
        preview.appendChild(img);
        this.observeLazyImage(img);
      } else preview.innerHTML = `<div class="ptt-card-placeholder">无预览图</div>`;
      const label = el("div", "ptt-card-label");
      label.textContent = tag.label;
      const edit = makeButton("ptt-edit", "编辑", ICONS.edit);
      edit.addEventListener("click", (e) => { e.stopPropagation(); this.editTag(tag); });
      card.append(preview, label, edit);
      card.addEventListener("click", () => this.insertTag(tag));
      this.bindPreviewHover(card, tag);
      grid.appendChild(card);
    }
    this.content.appendChild(grid);
  }

  observeLazyImage(img) {
    if (!(img instanceof HTMLImageElement) || !img.dataset.src) return;
    if (!("IntersectionObserver" in window)) {
      img.src = img.dataset.src;
      delete img.dataset.src;
      return;
    }
    if (!this.lazyObserver) {
      this.lazyObserver = new IntersectionObserver((entries, observer) => {
        for (const entry of entries) {
          if (!entry.isIntersecting) continue;
          const target = entry.target;
          if (target instanceof HTMLImageElement && target.dataset.src) {
            target.src = target.dataset.src;
            delete target.dataset.src;
          }
          observer.unobserve(target);
        }
      }, { root: this.content, rootMargin: "180px 0px", threshold: 0.01 });
    }
    this.lazyObserver.observe(img);
  }

  bindPreviewHover(node, tag) {
    if (!tag.preview) return;
    node.addEventListener("mouseenter", () => {
      const img = this.previewFloat.querySelector("img");
      if (img.dataset.preview !== tag.preview) {
        img.dataset.preview = tag.preview;
        img.src = `${API_PREFIX}/tag-preview-thumb/${encodeURIComponent(tag.preview)}`;
        const full = new Image();
        full.decoding = "async";
        full.src = `${API_PREFIX}/tag-preview/${encodeURIComponent(tag.preview)}`;
        full.onload = () => {
          if (img.dataset.preview === tag.preview) img.src = full.src;
        };
      }
      this.previewFloat.style.display = "block";
    });
    node.addEventListener("mousemove", (e) => {
      const pad = 14;
      let x = e.clientX + pad;
      let y = e.clientY - 215;
      if (x + 270 > innerWidth) x = e.clientX - 274;
      if (y < 8) y = e.clientY + pad;
      this.previewFloat.style.left = `${x}px`;
      this.previewFloat.style.top = `${y}px`;
    });
    node.addEventListener("mouseleave", () => { this.previewFloat.style.display = "none"; });
  }

  async insertTag(tag) {
    const value = String(tag.text || tag.label || "");
    if (!value) return;
    try {
      if (navigator.clipboard?.writeText && window.isSecureContext) {
        await navigator.clipboard.writeText(value);
      } else {
        const area = document.createElement("textarea");
        area.value = value;
        area.setAttribute("readonly", "");
        area.style.position = "fixed";
        area.style.opacity = "0";
        area.style.pointerEvents = "none";
        document.body.appendChild(area);
        area.select();
        const ok = document.execCommand?.("copy");
        area.remove();
        if (!ok) throw new Error("浏览器拒绝访问剪贴板");
      }
      toast("success", "已复制提示词", tag.label, 1500);
    } catch (e) {
      toast("error", "复制失败", e.message || String(e));
    }
  }

  editCategory(category = undefined) {
    if (category === undefined) category = this.library.categories.find((c) => c.id === this.activeCategory) || null;
    const overlay = el("div", "ptt-dialog-overlay");
    const dialog = el("div", "ptt-dialog");
    const editing = !!category;
    dialog.innerHTML = `<h3>${editing ? "编辑分类" : "创建分类"}</h3>`;
    const field = el("div", "ptt-field");
    field.innerHTML = `<label>分类名称</label><input type="text" maxlength="128" value="${escapeHtml(category?.name || "")}">`;
    dialog.appendChild(field);
    const actions = el("div", "ptt-dialog-actions");
    if (editing) {
      const del = makeButton("ptt-btn danger", "删除分类", "删除分类");
      del.addEventListener("click", async () => {
        const tagCount = this.library.tags.filter((t) => t.category_id === category.id).length;
        if (!confirm(`删除分类“${category.name}”以及其中 ${tagCount} 个标签？`)) return;
        const removedPreviews = this.library.tags.filter((t) => t.category_id === category.id && t.preview).map((t) => t.preview);
        this.library.categories = this.library.categories.filter((c) => c.id !== category.id);
        this.library.tags = this.library.tags.filter((t) => t.category_id !== category.id);
        const next = sortByOrder(this.library.categories)[0];
        this.activeCategory = next?.id || null;
        if (await this.save()) {
          overlay.remove();
          for (const filename of removedPreviews) {
            fetchJson(`${API_PREFIX}/tag-preview/delete`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ filename }) }).catch(() => {});
          }
        }
      });
      actions.appendChild(del);
    }
    const cancel = makeButton("ptt-btn", "取消", "取消");
    cancel.addEventListener("click", () => overlay.remove());
    const ok = makeButton("ptt-btn primary", "保存", "保存");
    ok.addEventListener("click", async () => {
      const name = field.querySelector("input").value.trim();
      if (!name) return toast("warn", "请输入分类名称");
      if (editing) category.name = name;
      else {
        const id = uuid("cat");
        this.library.categories.push({ id, name, order: this.library.categories.length });
        this.activeCategory = id;
      }
      if (await this.save()) overlay.remove();
    });
    actions.append(cancel, ok);
    dialog.appendChild(actions);
    overlay.appendChild(dialog);
    document.body.appendChild(overlay);
    setTimeout(() => field.querySelector("input").focus(), 0);
  }

  editTag(tag) {
    const editing = !!tag;
    const local = tag ? { ...tag } : {
      id: uuid("tag"), category_id: this.activeCategory || this.library.categories[0]?.id,
      label: "", text: "", preview: "", order: this.library.tags.length
    };
    let selectedFile = null;
    let pendingPreviewUpload = null;
    let temporaryPreviewFilename = "";
    let previewCommitted = false;
    const originalPreview = local.preview || "";

    const deletePreviewFile = (filename) => {
      if (!filename) return;
      fetchJson(`${API_PREFIX}/tag-preview/delete`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ filename }),
      }).catch(() => {});
    };

    const cleanupPendingPreview = () => {
      const pending = pendingPreviewUpload;
      pendingPreviewUpload = null;
      if (pending?.promise) pending.promise.then((data) => deletePreviewFile(data?.filename)).catch(() => {});
      if (temporaryPreviewFilename && !previewCommitted) deletePreviewFile(temporaryPreviewFilename);
      temporaryPreviewFilename = "";
    };

    const overlay = el("div", "ptt-dialog-overlay");
    const dialog = el("div", "ptt-dialog");
    dialog.innerHTML = `<h3>${editing ? "编辑标签" : "添加标签"}</h3>`;

    const categoryField = el("div", "ptt-field");
    categoryField.innerHTML = `<label>分类</label><select>${sortByOrder(this.library.categories).map((c) => `<option value="${escapeHtml(c.id)}" ${c.id === local.category_id ? "selected" : ""}>${escapeHtml(c.name)}</option>`).join("")}</select>`;
    const labelField = el("div", "ptt-field");
    labelField.innerHTML = `<label>标签显示名</label><input type="text" maxlength="256" value="${escapeHtml(local.label)}" placeholder="例如：郭煌舞女">`;
    const textField = el("div", "ptt-field");
    textField.innerHTML = `<label>插入的提示词文本</label><textarea placeholder="点击标签或卡牌后复制到剪贴板">${escapeHtml(local.text)}</textarea>`;
    const previewField = el("div", "ptt-field");
    previewField.innerHTML = `<label>预览图（可选，任意比例，卡牌中自动居中 contain）</label>`;
    const previewBox = el("div", "ptt-preview-editor");
    const renderPreview = () => {
      if (selectedFile) {
        const url = URL.createObjectURL(selectedFile);
        previewBox.innerHTML = `<img src="${url}" alt="">`;
        previewBox.querySelector("img").addEventListener("load", () => URL.revokeObjectURL(url), { once: true });
      } else if (local.preview) {
        previewBox.innerHTML = `<img src="${API_PREFIX}/tag-preview/${encodeURIComponent(local.preview)}" alt="">`;
      } else previewBox.innerHTML = `<span class="ptt-preview-drop-hint">拖拽图片到这里，或点击“选择图片”</span>`;
    };
    renderPreview();

    const acceptPreviewFile = (file) => {
      if (!file) return;
      if (!String(file.type || "").startsWith("image/")) {
        toast("warn", "不是图片文件", file.name || "拖入的文件");
        return;
      }
      cleanupPendingPreview();
      selectedFile = file;
      previewBox.classList.remove("dragover");
      renderPreview();

      // Start upload immediately in the background while the user continues
      // editing. A temporary preview id prevents replacing an existing tag
      // image until the dialog is actually saved.
      const uploadId = uuid("preview");
      const form = new FormData();
      form.append("tag_id", uploadId);
      form.append("file", file, file.name);
      const promise = fetchJson(`${API_PREFIX}/tag-preview/upload`, { method: "POST", body: form });
      pendingPreviewUpload = { uploadId, promise };
      previewBox.classList.add("uploading");
      promise.then((data) => {
        if (pendingPreviewUpload?.promise !== promise) {
          deletePreviewFile(data?.filename);
          return;
        }
        temporaryPreviewFilename = data?.filename || "";
      }).catch((e) => {
        if (pendingPreviewUpload?.promise === promise) {
          toast("error", "预览图后台上传失败", e.message || String(e));
        }
      }).finally(() => {
        if (pendingPreviewUpload?.promise === promise) previewBox.classList.remove("uploading");
      });
    };
    for (const eventName of ["dragenter", "dragover"]) {
      previewBox.addEventListener(eventName, (e) => {
        e.preventDefault();
        e.stopPropagation();
        if (e.dataTransfer) e.dataTransfer.dropEffect = "copy";
        previewBox.classList.add("dragover");
      });
    }
    for (const eventName of ["dragleave", "dragend"]) {
      previewBox.addEventListener(eventName, () => previewBox.classList.remove("dragover"));
    }
    previewBox.addEventListener("drop", (e) => {
      e.preventDefault();
      e.stopPropagation();
      previewBox.classList.remove("dragover");
      const file = [...(e.dataTransfer?.files || [])].find((f) => String(f.type || "").startsWith("image/"));
      acceptPreviewFile(file);
    });

    const previewActions = el("div", "ptt-dialog-actions");
    const upload = makeButton("ptt-btn", "上传预览图", "选择图片");
    upload.addEventListener("click", () => {
      const input = document.createElement("input");
      input.type = "file";
      input.accept = "image/png,image/jpeg,image/webp,image/gif";
      input.addEventListener("change", () => acceptPreviewFile(input.files?.[0] || null), { once: true });
      input.click();
    });
    const remove = makeButton("ptt-btn", "移除预览图", "移除预览图");
    remove.addEventListener("click", () => { cleanupPendingPreview(); selectedFile = null; local.preview = ""; renderPreview(); });
    previewActions.append(upload, remove);
    previewField.append(previewBox, previewActions);
    dialog.append(categoryField, labelField, textField, previewField);

    const actions = el("div", "ptt-dialog-actions");
    if (editing) {
      const del = makeButton("ptt-btn danger", "删除标签", "删除标签");
      del.addEventListener("click", async () => {
        if (!confirm(`删除标签“${tag.label}”？`)) return;
        cleanupPendingPreview();
        this.library.tags = this.library.tags.filter((t) => t.id !== tag.id);
        if (tag.preview) {
          fetchJson(`${API_PREFIX}/tag-preview/delete`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ filename: tag.preview }) }).catch(() => {});
        }
        if (await this.save()) overlay.remove();
      });
      actions.appendChild(del);
    }
    const cancel = makeButton("ptt-btn", "取消", "取消");
    cancel.addEventListener("click", () => { cleanupPendingPreview(); overlay.remove(); });
    const ok = makeButton("ptt-btn primary", "保存", "保存");
    ok.addEventListener("click", async () => {
      local.category_id = categoryField.querySelector("select").value;
      local.label = labelField.querySelector("input").value.trim();
      local.text = textField.querySelector("textarea").value;
      if (!local.label) local.label = local.text.trim().slice(0, 64) || "未命名标签";
      if (selectedFile) {
        try {
          const pending = pendingPreviewUpload;
          if (!pending?.promise) throw new Error("预览图后台上传任务不存在，请重新选择图片");
          const uploaded = await pending.promise;
          if (pendingPreviewUpload?.promise === pending.promise) pendingPreviewUpload = null;
          temporaryPreviewFilename = uploaded.filename || "";
          local.preview = temporaryPreviewFilename;
          selectedFile = null;
          renderPreview();
        } catch (e) {
          return toast("error", "预览图上传失败", e.message || String(e));
        }
      }
      if (editing) Object.assign(tag, local);
      else this.library.tags.push(local);
      if (await this.save()) {
        previewCommitted = true;
        temporaryPreviewFilename = "";
        overlay.remove();
        if (originalPreview && originalPreview !== local.preview) deletePreviewFile(originalPreview);
      }
    });
    actions.append(cancel, ok);
    dialog.appendChild(actions);
    overlay.appendChild(dialog);
    document.body.appendChild(overlay);
    setTimeout(() => labelField.querySelector("input").focus(), 0);
  }
}

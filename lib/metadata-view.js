const fs = require("node:fs/promises");
const { CompositeDisposable, Disposable, Emitter } = require("lumine");

const URI = "lumine://metadata";

function alive(item) {
  return item != null && item.isDestroyed?.() !== true && item.destroyed !== true;
}

function sectionsFrom(value) {
  if (!Array.isArray(value)) return [];
  const ids = new Set(["metadata:file"]);
  const sections = [];
  for (const section of value) {
    if (
      !section ||
      typeof section.id !== "string" ||
      !section.id ||
      ids.has(section.id) ||
      typeof section.title !== "string" ||
      !Array.isArray(section.rows)
    )
      continue;
    ids.add(section.id);
    const rowIds = new Set();
    const rows = section.rows.filter((row) => {
      if (
        !row ||
        typeof row.id !== "string" ||
        !row.id ||
        rowIds.has(row.id) ||
        typeof row.label !== "string" ||
        !(
          row.value === null ||
          typeof row.value === "string" ||
          typeof row.value === "boolean" ||
          (typeof row.value === "number" && Number.isFinite(row.value))
        )
      )
        return false;
      rowIds.add(row.id);
      return true;
    });
    if (rows.length) sections.push({ id: section.id, title: section.title, rows });
  }
  return sections;
}

function formatValue({ value, format }) {
  if (value === null) return "—";
  if (format === "bytes" && typeof value === "number" && value >= 0) {
    if (value < 1024) return `${value.toLocaleString()} B`;
    const units = ["KiB", "MiB", "GiB", "TiB"];
    let size = value / 1024;
    let unit = 0;
    while (size >= 1024 && unit < units.length - 1) {
      size /= 1024;
      unit++;
    }
    return `${size.toLocaleString(undefined, { maximumFractionDigits: 2 })} ${units[unit]}`;
  }
  if (format === "date" && (typeof value === "string" || typeof value === "number")) {
    const date = new Date(value);
    if (Number.isFinite(date.getTime())) return date.toLocaleString();
  }
  if (typeof value === "boolean") return value ? "Yes" : "No";
  return String(value);
}

async function fileSection(item, filePath) {
  if (typeof item.getPath !== "function") return null;
  const rows = [{ id: "path", label: "Path", value: filePath || "Not saved" }];
  if (filePath) {
    try {
      const stat = await fs.stat(filePath);
      rows.push(
        { id: "size", label: "Saved size", value: stat.size, format: "bytes" },
        {
          id: "modified",
          label: "Saved modified",
          value: stat.mtime.toISOString(),
          format: "date",
        },
      );
      if (stat.birthtimeMs > 0)
        rows.push({
          id: "created",
          label: "Created",
          value: stat.birthtime.toISOString(),
          format: "date",
        });
    } catch (error) {
      rows.push({
        id: "status",
        label: "Saved file",
        value: error.code === "ENOENT" ? "Not present on disk" : "Information unavailable",
      });
    }
  }
  return { id: "metadata:file", title: "File on Disk", rows };
}

module.exports = class MetadataView {
  constructor() {
    this.emitter = new Emitter();
    this.subscriptions = new CompositeDisposable();
    this.sourceSubscriptions = new CompositeDisposable();
    this.presentationSubscriptions = new CompositeDisposable();
    this.panes = new Map();
    this.source = null;
    this.sections = [];
    this.dirty = true;
    this.visible = false;
    this.destroyed = false;
    this.retired = false;
    this.revision = 0;
    this.showRevision = 0;
    this.element = document.createElement("div");
    this.element.className = "metadata native-key-bindings";
    this.element.setAttribute("data-scrollbar", "auto");
    this.element.tabIndex = -1;
    this.element.setAttribute("aria-label", "Document metadata");
    this.render();

    this.subscriptions.add(
      lumine.workspace.getCenter().observeActivePaneItem((item) => {
        this.setSource(item);
        this.updateVisibility();
      }),
      lumine.workspace.observePanes((pane) => this.observePane(pane)),
      lumine.workspace.onDidChangeActivePaneItem(() => this.updateVisibility()),
    );
    for (const dock of [
      lumine.workspace.getLeftDock(),
      lumine.workspace.getRightDock(),
      lumine.workspace.getBottomDock(),
    ])
      this.subscriptions.add(dock.onDidChangeVisible(() => this.updateVisibility()));
    this.didAttachToWindow({ document: this.element.ownerDocument });
  }

  getElement() {
    return this.element;
  }

  getTitle() {
    return "Metadata";
  }

  getURI() {
    return URI;
  }

  getSingletonKey() {
    return URI;
  }

  getIconName() {
    return "info";
  }

  getDefaultLocation() {
    return "right";
  }

  getAllowedLocations() {
    return ["right", "left"];
  }

  serialize() {
    return { deserializer: "metadata/MetadataView" };
  }

  onDidDestroy(callback) {
    return this.destroyed ? new Disposable() : this.emitter.on("did-destroy", callback);
  }

  isDestroyed() {
    return this.destroyed;
  }

  observePane(pane) {
    if (this.retired || this.panes.has(pane)) return;
    const subscriptions = new CompositeDisposable(
      pane.onDidChangeActiveItem(() => this.updateVisibility()),
      pane.onDidAddItem(() => this.updateVisibility()),
      pane.onDidRemoveItem(() => this.updateVisibility()),
      pane.onDidDestroy(() => {
        this.panes.delete(pane);
        subscriptions.dispose();
        this.updateVisibility();
      }),
    );
    this.panes.set(pane, subscriptions);
  }

  didAttachToWindow({ document: hostDocument }) {
    if (this.retired) return;
    this.presentationSubscriptions.dispose();
    this.presentationSubscriptions = new CompositeDisposable();
    const update = () => this.updateVisibility();
    hostDocument.addEventListener("visibilitychange", update);
    this.presentationSubscriptions.add(
      new Disposable(() => hostDocument.removeEventListener("visibilitychange", update)),
    );
    this.updateVisibility();
  }

  isVisible() {
    if (this.retired) return false;
    const pane = lumine.workspace.paneForItem(this);
    if (!pane || pane.getActiveItem() !== this) return false;
    const container = lumine.workspace.paneContainerForItem(this);
    if (container?.isVisible?.() === false) return false;
    return this.element.ownerDocument.visibilityState !== "hidden";
  }

  updateVisibility() {
    if (this.retired) return;
    const visible = this.isVisible();
    if (visible !== this.visible) {
      this.visible = visible;
      if (!visible) this.cancelRequest();
      else this.dirty = true;
    }
    if (visible && this.dirty) this.scheduleRefresh();
  }

  setSource(item) {
    if (this.retired) return;
    const next =
      item === lumine.workspace.getCenter().getActivePaneItem() && alive(item) ? item : null;
    if (next === this.source) return;
    this.sourceSubscriptions.dispose();
    this.sourceSubscriptions = new CompositeDisposable();
    this.cancelRequest();
    this.source = next;
    this.sections = [];
    this.error = null;
    if (next) {
      for (const method of [
        "onDidChangeMetadata",
        "onDidChangePath",
        "onDidChangeURI",
        "onDidChangeTitle",
        "onDidChangeModified",
        "onDidChangeFileState",
        "onDidSave",
        "onDidReload",
      ]) {
        if (typeof next[method] === "function")
          this.sourceSubscriptions.add(next[method](() => this.invalidate()));
      }
      if (typeof next.onDidDestroy === "function")
        this.sourceSubscriptions.add(
          next.onDidDestroy(() => {
            if (this.source === next) this.setSource(null);
          }),
        );
    }
    this.invalidate();
  }

  invalidate() {
    if (this.retired) return;
    this.cancelRequest();
    this.dirty = true;
    this.render();
    if (this.isVisible()) this.scheduleRefresh();
  }

  cancelRequest() {
    this.revision++;
    this.request?.abort();
    this.request = null;
    this.loading = false;
  }

  scheduleRefresh() {
    if (this.refreshScheduled || this.retired) return;
    this.refreshScheduled = true;
    queueMicrotask(() => {
      this.refreshScheduled = false;
      if (!this.retired && this.isVisible() && this.dirty) void this.refresh();
    });
  }

  async refresh() {
    if (this.retired || !this.isVisible()) return;
    this.cancelRequest();
    this.dirty = false;
    this.error = null;
    const item = this.source;
    if (!alive(item)) {
      this.sections = [];
      this.render();
      return;
    }
    const controller = (this.request = new AbortController());
    const revision = this.revision;
    const filePath = item.getPath?.();
    const itemRevision = item.getPaneItemRevision?.();
    this.loading = true;
    this.render();
    const results = await Promise.allSettled([
      fileSection(item, filePath),
      Promise.resolve().then(() => item.getMetadata?.({ signal: controller.signal }) ?? []),
    ]);
    if (
      this.retired ||
      controller.signal.aborted ||
      this.revision !== revision ||
      this.source !== item ||
      !alive(item) ||
      !this.isVisible()
    )
      return;
    if (item.getPath?.() !== filePath || item.getPaneItemRevision?.() !== itemRevision) {
      this.invalidate();
      return;
    }
    this.request = null;
    this.loading = false;
    this.sections = [];
    if (results[0].status === "fulfilled" && results[0].value) this.sections.push(results[0].value);
    if (results[1].status === "fulfilled") this.sections.push(...sectionsFrom(results[1].value));
    else this.error = "Document metadata could not be loaded.";
    this.render();
  }

  render() {
    if (this.retired) return;
    const doc = this.element.ownerDocument;
    const fragment = doc.createDocumentFragment();
    const title = doc.createElement("h1");
    title.className = "metadata-document-title";
    title.textContent = this.source?.getTitle?.() || "No document";
    fragment.append(title);
    for (const section of this.sections) {
      const group = doc.createElement("section");
      group.className = "metadata-section";
      group.dataset.section = section.id;
      const heading = doc.createElement("h2");
      heading.textContent = section.title;
      group.append(heading);
      const list = doc.createElement("dl");
      for (const row of section.rows) {
        const label = doc.createElement("dt");
        label.textContent = row.label;
        const value = doc.createElement("dd");
        value.textContent = formatValue(row);
        value.dataset.row = row.id;
        list.append(label, value);
      }
      group.append(list);
      fragment.append(group);
    }
    const message =
      this.error ||
      (this.loading
        ? "Loading metadata…"
        : this.sections.length
          ? ""
          : this.source
            ? "No metadata available for this document."
            : "Open a document to inspect its metadata.");
    if (message) {
      const status = doc.createElement("p");
      status.className = "metadata-status text-subtle";
      status.setAttribute("role", "status");
      status.textContent = message;
      fragment.append(status);
    }
    this.element.setAttribute("aria-busy", String(Boolean(this.loading)));
    this.element.replaceChildren(fragment);
  }

  isFocused() {
    return this.element.contains(this.element.ownerDocument.activeElement);
  }

  focus() {
    if (this.retired) return;
    lumine.workspace.getWindowForElement(this.element)?.focus();
    this.element.focus();
  }

  unfocus() {
    const pane = this.source && lumine.workspace.paneForItem(this.source);
    if (!pane) return;
    pane.activateItem(this.source);
    pane.activate();
    const element = lumine.views.getView(this.source);
    lumine.workspace.getWindowForElement(element)?.focus();
    element?.focus?.();
  }

  async show({ focus = false } = {}) {
    if (this.retired) return null;
    const revision = ++this.showRevision;
    const host = lumine.workspace.getFocusedWindow();
    const focused = host?.getDocument()?.activeElement;
    let opened;
    try {
      opened = await lumine.workspace.open(this, {
        searchAllPanes: true,
        activatePane: false,
        activateItem: false,
      });
    } catch (error) {
      if (this.retired && error.code === "ITEM_UNAVAILABLE") return null;
      throw error;
    }
    if (this.retired || this.showRevision !== revision || opened !== this) return null;
    const pane = lumine.workspace.paneForItem(this);
    const container = lumine.workspace.paneContainerForItem(this);
    if (!pane) return null;
    container?.show?.();
    pane.activateItem(this);
    this.updateVisibility();
    if (
      focus &&
      host &&
      lumine.workspace.getFocusedWindow() === host &&
      host.getDocument()?.activeElement === focused
    ) {
      pane.activate();
      this.focus();
    }
    return this;
  }

  hide() {
    this.showRevision++;
    lumine.workspace.hide(this);
    this.updateVisibility();
  }

  async toggleFocus() {
    if (this.isFocused()) this.unfocus();
    else await this.show({ focus: true });
  }

  retire() {
    if (this.retired) return;
    this.retired = true;
    this.showRevision++;
    this.cancelRequest();
    this.subscriptions.dispose();
    this.sourceSubscriptions.dispose();
    this.presentationSubscriptions.dispose();
    for (const subscriptions of this.panes.values()) subscriptions.dispose();
    this.panes.clear();
    this.source = null;
  }

  destroy() {
    if (this.destroyed) return;
    this.destroyed = true;
    this.retire();
    this.emitter.emit("did-destroy");
    this.emitter.dispose();
    this.element.remove();
  }
};

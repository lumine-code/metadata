const path = require("node:path");
const { Emitter } = require("lumine");

let nextItem = 0;

function section(value) {
  return [{ id: "document", title: "Document", rows: [{ id: "value", label: "Value", value }] }];
}

function makeItem(options = {}) {
  const emitter = new Emitter();
  const uri = `metadata-spec://${++nextItem}`;
  const element = document.createElement("div");
  element.tabIndex = -1;
  let filePath = options.filePath;
  let value = options.value ?? "Current document";
  let revision = 0;
  const item = {
    element,
    destroyed: false,
    getTitle: () => options.title ?? "Example document",
    getURI: () => uri,
    getElement: () => element,
    getMetadata: jasmine
      .createSpy("getMetadata")
      .and.callFake((request) => options.getMetadata?.(request) ?? section(value)),
    getPaneItemRevision: () => revision,
    onDidChangeMetadata: (callback) => emitter.on("metadata", callback),
    onDidChangePath: (callback) => emitter.on("path", callback),
    onDidSave: (callback) => emitter.on("save", callback),
    onDidDestroy: (callback) => emitter.on("destroy", callback),
    invalidate() {
      emitter.emit("metadata");
    },
    setValue(nextValue) {
      value = nextValue;
      this.invalidate();
    },
    replaceDocument() {
      revision++;
      this.invalidate();
    },
    setPath(nextPath) {
      filePath = nextPath;
      emitter.emit("path");
    },
    save() {
      emitter.emit("save");
    },
    destroy() {
      if (this.destroyed) return;
      this.destroyed = true;
      emitter.emit("destroy");
      emitter.dispose();
    },
  };
  if (Object.hasOwn(options, "filePath")) item.getPath = () => filePath;
  return item;
}

async function until(predicate) {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > 3000) throw new Error("Metadata did not reach the expected state");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

describe("Metadata inspector", () => {
  let main;
  let items;
  let gates;
  let leases;

  beforeEach(async () => {
    jasmine.useRealClock();
    jasmine.attachToDOM(lumine.workspace.getElement());
    items = [];
    gates = [];
    leases = [];
    main = (await lumine.packages.activatePackage("metadata")).mainModule;
  });

  afterEach(async () => {
    for (const resolve of gates) resolve([]);
    for (const lease of leases) lease.dispose();
    await lumine.packages.deactivatePackage("metadata");
    await lumine.workspace.discardEditorWindows();
    for (const item of items) {
      const pane = lumine.workspace.paneForItem(item);
      if (pane) await pane.destroyItem(item, true);
      else item.destroy();
    }
  });

  async function open(options = {}) {
    const item = makeItem(options);
    items.push(item);
    await lumine.workspace.open(item);
    return item;
  }

  function deferred() {
    const { promise, resolve } = Promise.withResolvers();
    gates.push(resolve);
    return { promise, resolve };
  }

  async function show(item) {
    const view = await main.showForItem(item);
    await until(() => !view.loading && !view.dirty);
    return view;
  }

  it("registers commands before constructing an inspector", () => {
    expect(main.view).toBeUndefined();
    expect(lumine.commands.canDispatch(lumine.workspace.getElement(), "metadata:show")).toBeTrue();
    expect(
      lumine.commands.canDispatch(lumine.workspace.getElement(), "metadata:toggle"),
    ).toBeTrue();
    expect(
      lumine.commands.canDispatch(lumine.workspace.getElement(), "metadata:toggle-focus"),
    ).toBeTrue();
  });

  it("opens a serializable singleton pane item in the right dock", async () => {
    const item = await open();
    const view = await show(item);
    expect(lumine.workspace.paneContainerForItem(view)).toBe(lumine.workspace.getRightDock());
    expect(view.getAllowedLocations()).toEqual(["right", "left"]);
    expect(view.serialize()).toEqual({ deserializer: "metadata/MetadataView" });
    expect(main.deserializeMetadataView()).toBe(view);
    expect(view.getSingletonKey()).toBe("lumine://metadata");
    expect(view.element.textContent).toContain("Current document");
    expect(lumine.workspace.getModalPanels().some((panel) => panel.getItem() === view)).toBeFalse();
  });

  it("queries metadata only while the inspector is visible", async () => {
    const item = await open();
    const view = main.getView();
    await Promise.resolve();
    expect(item.getMetadata).not.toHaveBeenCalled();
    await view.show();
    await until(() => item.getMetadata.calls.count() === 1 && !view.loading);
    view.hide();
    item.setValue("Changed while hidden");
    await Promise.resolve();
    expect(item.getMetadata).toHaveBeenCalledTimes(1);
    await view.show();
    await until(() => view.element.textContent.includes("Changed while hidden"));
    expect(item.getMetadata).toHaveBeenCalledTimes(2);
  });

  it("keeps the remembered document while its own pane receives focus", async () => {
    const item = await open();
    const view = await show(item);
    lumine.workspace.paneForItem(view).activate();
    view.focus();
    expect(view.source).toBe(item);
    expect(view.isFocused()).toBeTrue();
    view.unfocus();
    expect(lumine.workspace.getCenter().getActivePaneItem()).toBe(item);
    expect(view.source).toBe(item);
  });

  it("follows a newly activated document without taking focus", async () => {
    const first = await open({ value: "First document" });
    const view = await show(first);
    const second = await open({ value: "Second document" });
    second.element.focus();
    await until(() => view.element.textContent.includes("Second document"));
    expect(view.source).toBe(second);
    expect(document.activeElement).toBe(second.element);
  });

  it("aborts a source request and ignores its late response", async () => {
    const gate = deferred();
    const first = await open({ getMetadata: () => gate.promise });
    const view = await main.showForItem(first);
    await until(() => first.getMetadata.calls.count() === 1);
    const signal = first.getMetadata.calls.mostRecent().args[0].signal;
    const second = await open({ value: "New source" });
    await until(() => view.element.textContent.includes("New source"));
    expect(signal.aborted).toBeTrue();
    gate.resolve(section("Stale source"));
    await Promise.resolve();
    await Promise.resolve();
    expect(view.source).toBe(second);
    expect(view.element.textContent).not.toContain("Stale source");
  });

  it("refreshes a replacement document at the same item identity", async () => {
    const gate = deferred();
    let replacement = false;
    const item = await open({
      getMetadata: () => (replacement ? section("Replacement") : gate.promise),
    });
    const view = await main.showForItem(item);
    await until(() => item.getMetadata.calls.count() === 1);
    replacement = true;
    item.replaceDocument();
    await until(() => view.element.textContent.includes("Replacement"));
    gate.resolve(section("Discarded generation"));
    await Promise.resolve();
    await Promise.resolve();
    expect(view.element.textContent).not.toContain("Discarded generation");
  });

  it("cancels pending metadata when its dock is hidden", async () => {
    const gate = deferred();
    const item = await open({ getMetadata: () => gate.promise });
    const view = await main.showForItem(item);
    await until(() => item.getMetadata.calls.count() === 1);
    const signal = item.getMetadata.calls.mostRecent().args[0].signal;
    lumine.workspace.getRightDock().hide();
    expect(signal.aborted).toBeTrue();
    gate.resolve(section("Hidden result"));
    await Promise.resolve();
    await Promise.resolve();
    expect(view.sections).toEqual([]);
  });

  it("shows saved file details separately from current document properties", async () => {
    const filePath = path.join(__dirname, "fixtures", "saved.txt");
    const item = await open({ filePath, value: "Unsaved content" });
    const view = await show(item);
    expect(view.sections[0].id).toBe("metadata:file");
    expect(view.element.textContent).toContain("File on Disk");
    expect(view.element.textContent).toContain("Saved size");
    expect(view.element.textContent).toContain("Saved modified");
    expect(view.element.textContent).toContain("Unsaved content");
    expect(view.element.querySelector('[data-row="path"]').textContent).toBe(filePath);
  });

  it("refreshes file details after path changes and saves", async () => {
    const item = await open({ filePath: undefined });
    const view = await show(item);
    expect(view.element.textContent).toContain("Not saved");
    const filePath = path.join(__dirname, "fixtures", "saved.txt");
    item.setPath(filePath);
    await until(() => view.element.textContent.includes("Saved size"));
    const calls = item.getMetadata.calls.count();
    item.save();
    await until(() => item.getMetadata.calls.count() > calls && !view.loading);
    expect(view.element.querySelector('[data-row="path"]').textContent).toBe(filePath);
  });

  it("keeps document metadata when the saved file is absent", async () => {
    const item = await open({ filePath: path.join(__dirname, "does-not-exist.txt") });
    const view = await show(item);
    expect(view.element.textContent).toContain("Not present on disk");
    expect(view.element.textContent).toContain("Current document");
  });

  it("preserves the file section when an item metadata query fails", async () => {
    const item = await open({
      filePath: undefined,
      getMetadata: () => Promise.reject(new Error("Read failed")),
    });
    const view = await show(item);
    expect(view.element.textContent).toContain("Not saved");
    expect(view.element.textContent).toContain("Document metadata could not be loaded.");
  });

  it("renders metadata as text and rejects malformed scalar values", async () => {
    const item = await open({
      getMetadata: () => [
        {
          id: "safe",
          title: "<img src=x>",
          rows: [
            { id: "safe", label: "<script>", value: "<strong>Text only</strong>" },
            { id: "unsafe", label: "Object", value: { toString: () => "Unsafe" } },
            { id: "flag", label: "Flag", value: true },
            { id: "none", label: "Empty", value: null },
            { id: "size", label: "Size", value: 2048, format: "bytes" },
          ],
        },
      ],
    });
    const view = await show(item);
    expect(view.element.querySelector("img, script, strong")).toBeNull();
    expect(view.element.textContent).toContain("<strong>Text only</strong>");
    expect(view.element.textContent).not.toContain("Unsafe");
    expect(view.element.textContent).not.toContain("Object");
    expect(view.element.textContent).toContain("Yes");
    expect(view.element.textContent).toContain("—");
    expect(view.element.textContent).toContain("2 KiB");
  });

  it("clears a destroyed source and cancels its request", async () => {
    const gate = deferred();
    const item = await open({ getMetadata: () => gate.promise });
    const view = await main.showForItem(item);
    await until(() => item.getMetadata.calls.count() === 1);
    const signal = item.getMetadata.calls.mostRecent().args[0].signal;
    item.destroy();
    expect(signal.aborted).toBeTrue();
    expect(view.source).toBeNull();
    expect(view.element.textContent).toContain("Open a document");
  });

  it("moves the same pane item and root between the side docks", async () => {
    const item = await open();
    const view = await show(item);
    const element = view.element;
    const leftPane = lumine.workspace.getLeftDock().getActivePane();
    const rightPane = lumine.workspace.paneForItem(view);
    await lumine.workspace.movePaneItem(view, { targetPane: leftPane });
    expect(lumine.workspace.paneForItem(view)).toBe(leftPane);
    expect(view.source).toBe(item);
    expect(view.element).toBe(element);
    expect(main.getView()).toBe(view);
    await lumine.workspace.movePaneItem(view, {
      targetPane: rightPane,
    });
    expect(view.element).toBe(element);
    expect(view.isDestroyed()).toBeFalse();
  });

  it("rejects movement into the center and bottom dock without changing ownership", async () => {
    const item = await open();
    const view = await show(item);
    const pane = lumine.workspace.paneForItem(view);
    const element = view.element;
    for (const targetPane of [
      lumine.workspace.paneForItem(item),
      lumine.workspace.getBottomDock().getActivePane(),
    ]) {
      await expectAsync(lumine.workspace.movePaneItem(view, { targetPane })).toBeRejected();
      expect(lumine.workspace.paneForItem(view)).toBe(pane);
      expect(view.element).toBe(element);
      expect(view.isDestroyed()).toBeFalse();
    }
  });

  it("creates a fresh inspector after normal pane closure", async () => {
    const item = await open();
    const view = await show(item);
    await lumine.workspace.paneForItem(view).destroyItem(view, true);
    expect(view.isDestroyed()).toBeTrue();
    expect(main.view).toBeNull();
    const next = await show(item);
    expect(next).not.toBe(view);
    expect(next.element).not.toBe(view.element);
  });

  it("keeps a retired service reference from opening the next generation", async () => {
    const item = await open();
    const service = main.provideMetadata();
    const view = await service.showForItem(item);
    await lumine.packages.deactivatePackage("metadata");
    main = (await lumine.packages.activatePackage("metadata")).mainModule;
    expect(await service.showForItem(item)).toBeNull();
    expect(view.isDestroyed()).toBeTrue();
    const next = await main.provideMetadata().showForItem(item);
    expect(next).not.toBe(view);
  });

  it("does not restore focus after the user leaves an asynchronously opening inspector", async () => {
    const item = await open();
    const other = await open({ value: "Another document" });
    lumine.workspace.paneForItem(item).activateItem(item);
    item.element.focus();
    expect(document.activeElement).toBe(item.element);
    const view = main.getView();
    const gate = deferred();
    const arrived = deferred();
    const originalOpen = lumine.workspace.open.bind(lumine.workspace);
    spyOn(lumine.workspace, "open").and.callFake(async (candidate, options) => {
      const result = await originalOpen(candidate, options);
      if (candidate === view) {
        arrived.resolve();
        await gate.promise;
      }
      return result;
    });
    const opening = main.showForItem(item, { focus: true });
    await arrived.promise;
    lumine.workspace.paneForItem(other).activateItem(other);
    other.element.focus();
    expect(document.activeElement).toBe(other.element);
    gate.resolve();
    await opening;
    expect(document.activeElement).toBe(other.element);
  });

  it("retires an inspector while its workspace open operation is pending", async () => {
    const item = await open();
    const view = main.getView();
    const gate = deferred();
    const arrived = deferred();
    const originalOpen = lumine.workspace.open.bind(lumine.workspace);
    spyOn(lumine.workspace, "open").and.callFake(async (candidate, options) => {
      const result = await originalOpen(candidate, options);
      if (candidate === view) {
        arrived.resolve();
        await gate.promise;
      }
      return result;
    });
    const opening = main.showForItem(item);
    await arrived.promise;
    await lumine.packages.deactivatePackage("metadata");
    gate.resolve();
    expect(await opening).toBeNull();
    expect(view.isDestroyed()).toBeTrue();
    expect(lumine.workspace.paneForItem(view)).toBeUndefined();
    main = (await lumine.packages.activatePackage("metadata")).mainModule;
  });

  it("contributes an action for its exact item and disposes the service edge", async () => {
    const first = await open({ value: "First" });
    const second = await open({ value: "Second" });
    const registration = { dispose: jasmine.createSpy("dispose action") };
    const actions = { addAction: jasmine.createSpy("addAction").and.returnValue(registration) };
    const edge = main.consumeBreadcrumbActions(actions);
    const action = actions.addAction.calls.mostRecent().args[0];
    expect(action.icon).toBe("info");
    expect(action.getState({ item: first }).visible).toBeTrue();
    await action.didClick({
      item: first,
      pane: lumine.workspace.paneForItem(first),
      window: lumine.workspace.getMainWindow(),
      document,
    });
    expect(main.view.source).toBe(first);
    expect(lumine.workspace.getCenter().getActivePaneItem()).toBe(second);
    expect(action.getState({ item: first }).pressed).toBeTrue();
    edge.dispose();
    expect(registration.dispose).toHaveBeenCalledTimes(1);
  });

  it("follows an editor detached after the inspector started observing", async () => {
    const editor = await lumine.workspace.open();
    items.push(editor);
    editor.setText("const signal = 42;\n");
    const view = await show(editor);
    const extra = await lumine.workspace.detachPane(lumine.workspace.paneForItem(editor));
    expect(view.source).toBe(editor);
    editor.setText("const signal = 43;\n");
    await until(() => !view.dirty && !view.loading);
    expect(view.source).toBe(editor);
    expect(view.element.ownerDocument).toBe(document);
    expect(extra.getEditorContainer().getActivePaneItem()).toBe(editor);
    await lumine.workspace.attachWindow(extra);
    expect(view.source).toBe(editor);
  });

  it("focuses the physical presentation when moving between the inspector and its source", async () => {
    const item = await open();
    const view = await show(item);
    const extra = await lumine.workspace.detachPane(lumine.workspace.paneForItem(item));
    const mainFocus = spyOn(lumine.workspace.getMainWindow(), "focus");
    const sourceFocus = spyOn(extra, "focus");
    view.focus();
    expect(mainFocus).toHaveBeenCalledTimes(1);
    view.unfocus();
    expect(sourceFocus).toHaveBeenCalledTimes(1);
    expect(view.source).toBe(item);
    await lumine.workspace.attachWindow(extra);
  });
});

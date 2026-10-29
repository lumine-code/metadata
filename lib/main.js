const { CompositeDisposable, Disposable, Emitter } = require("lumine");

class MetadataPackage {
  initialize() {
    this.owner ??= {
      retired: false,
      subscriptions: new CompositeDisposable(),
      emitter: new Emitter(),
    };
  }

  activate() {
    this.initialize();
    const owner = this.owner;
    const owns = () => this.owner === owner && !owner.retired;
    owner.subscriptions.add(
      lumine.commands.add("lumine-workspace", {
        "metadata:show": {
          description: "Inspect properties of the current document in a pane.",
          didDispatch: (event) => owns() && this.showForItem(this.commandItem(event)),
        },
        "metadata:toggle": (event) => {
          if (!owns()) return;
          if (this.view?.isVisible()) this.view.hide();
          else return this.showForItem(this.commandItem(event));
        },
        "metadata:toggle-focus": (event) => {
          if (!owns()) return;
          const view = this.getView();
          if (!view.isFocused()) view.setSource(this.commandItem(event));
          return view.toggleFocus();
        },
      }),
    );
  }

  commandItem(event) {
    const item = event?.context?.documentItem ?? lumine.workspace.getCenter().getActivePaneItem();
    return item === this.view ? this.view?.source : item;
  }

  getView() {
    const owner = this.owner;
    if (!owner || owner.retired) return null;
    if (!this.view) {
      const MetadataView = require("./metadata-view");
      const view = new MetadataView({ onDidChange: () => owner.emitter.emit("did-change") });
      this.view = view;
      const destroyed = view.onDidDestroy(() => {
        owner.subscriptions.remove(destroyed);
        if (this.view === view) this.view = null;
        if (!owner.retired) owner.emitter.emit("did-change");
      });
      owner.subscriptions.add(destroyed);
    }
    return this.view;
  }

  showForItem(item, options) {
    const view = this.getView();
    if (!view) return Promise.resolve(null);
    if (item !== view) view.setSource(item);
    return view.show(options);
  }

  deserializeMetadataView() {
    return this.getView();
  }

  provideMetadata() {
    const owner = this.owner;
    return Object.freeze({
      showForItem: (item, options) =>
        this.owner === owner && !owner?.retired
          ? this.showForItem(item, options)
          : Promise.resolve(null),
    });
  }

  consumeBreadcrumbActions(actions) {
    const owner = this.owner;
    if (!owner || owner.retired) return new Disposable();
    const registration = actions.addAction({
      id: "metadata:show",
      icon: "info",
      title: "Show Metadata",
      order: 100,
      getState: ({ item }) => ({
        visible:
          this.owner === owner &&
          !owner.retired &&
          item !== this.view &&
          Boolean(
            item && (typeof item.getMetadata === "function" || typeof item.getPath === "function"),
          ),
        enabled:
          this.owner === owner &&
          !owner.retired &&
          item?.isDestroyed?.() !== true &&
          item?.destroyed !== true,
        pressed: Boolean(
          this.owner === owner &&
          !owner.retired &&
          this.view &&
          this.view.source === item &&
          this.view.isVisible(),
        ),
      }),
      didClick: ({ item }) => {
        if (this.owner === owner && !owner.retired) return this.showForItem(item);
      },
      onDidChange: (refresh) => owner.emitter.on("did-change", refresh),
    });
    owner.subscriptions.add(registration);
    return new Disposable(() => {
      owner.subscriptions.remove(registration);
      registration.dispose();
    });
  }

  provideBackgroundTips() {
    return {
      packageName: "metadata",
      tips: [
        "{% if keys['metadata:toggle-focus'] %}Inspect document properties with {{ 'metadata:toggle-focus' | keystroke }}{% else %}Inspect the current document's properties with Metadata: Show from the command palette.{% endif %}",
      ],
    };
  }

  async deactivate() {
    const owner = this.owner;
    if (!owner) return;
    owner.retired = true;
    this.owner = null;
    const view = this.view;
    this.view = null;
    view?.retire();
    owner.subscriptions.dispose();
    owner.emitter.dispose();
    if (view) {
      const pane = lumine.workspace.paneForItem(view);
      if (pane) await pane.destroyItem(view, true);
      view.destroy();
    }
  }
}

module.exports = new MetadataPackage();

const { CompositeDisposable } = require("lumine");

class MetadataPackage {
  initialize() {
    this.owner ??= {
      retired: false,
      subscriptions: new CompositeDisposable(),
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
          didDispatch: () => owns() && this.showForItem(this.commandItem()),
        },
        "metadata:toggle": () => {
          if (!owns()) return;
          if (this.view?.isVisible()) this.view.hide();
          else return this.showForItem(this.commandItem());
        },
        "metadata:toggle-focus": () => {
          if (!owns()) return;
          const view = this.getView();
          if (!view.isFocused()) view.setSource(this.commandItem());
          return view.toggleFocus();
        },
      }),
    );
  }

  commandItem() {
    return lumine.workspace.getCenter().getActivePaneItem();
  }

  getView() {
    const owner = this.owner;
    if (!owner || owner.retired) return null;
    if (!this.view) {
      const MetadataView = require("./metadata-view");
      const view = new MetadataView();
      this.view = view;
      const destroyed = view.onDidDestroy(() => {
        owner.subscriptions.remove(destroyed);
        if (this.view === view) this.view = null;
      });
      owner.subscriptions.add(destroyed);
    }
    return this.view;
  }

  showForItem(item, options) {
    if (!this.owner || this.owner.retired) return Promise.resolve(null);
    const pane = item && lumine.workspace.paneForItem(item);
    const center = lumine.workspace.getCenter();
    if (
      pane &&
      item.isDestroyed?.() !== true &&
      item.destroyed !== true &&
      center.getPanes().includes(pane) &&
      center.getActivePaneItem() !== item
    )
      pane.activateItem(item, { activatePane: true });
    const view = this.getView();
    if (!view) return Promise.resolve(null);
    view.setSource(center.getActivePaneItem());
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
    if (view) {
      const pane = lumine.workspace.paneForItem(view);
      if (pane) await pane.destroyItem(view, true);
      view.destroy();
    }
  }
}

module.exports = new MetadataPackage();

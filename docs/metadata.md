# Metadata

Open the shared document inspector for a specific pane item.

| Field       | Value                                        |
| ----------- | -------------------------------------------- |
| Version     | `1.0.0`                                      |
| Provided by | packages implementing the document inspector |
| Consumed by | packages exposing document property actions  |
| Owner       | `metadata`                                   |

## Registration

Declare `metadata` in `consumedServices` and return a Disposable from the consumer method to release the connection when the provider disappears.

```json
{
  "consumedServices": {
    "metadata": {
      "versions": {
        "^1.0.0": "consumeMetadata"
      }
    }
  }
}
```

## Contract

```ts
interface MetadataService {
  showForItem(item: PaneItem, options?: { focus?: boolean }): Promise<PaneItem | null>;
}
```

`showForItem()` opens or reveals the inspector and selects the supplied pane item as its source. It resolves to the inspector, or null when its package generation has retired. `focus` defaults to false. A request with `focus: true` focuses the inspector only while the invoking presentation retains its original focus during preparation. Fetching metadata never changes focus.

The supplied pane item may implement the core metadata protocol or expose only `getPath()`. The inspector reads saved file details independently of the item's current document properties. The service does not add metadata to another package's item; the item's own `getMetadata()` owns those sections.

## Minimal example

```js
const { Disposable } = require("lumine");

module.exports = {
  consumeMetadata(service) {
    this.metadata = service;
    return new Disposable(() => {
      if (this.metadata === service) this.metadata = null;
    });
  },

  showProperties(item) {
    return this.metadata?.showForItem(item);
  },
};
```

## Behavior

The inspector follows subsequent active document changes in the workspace center, ignoring its own activation. Requests are lazy while hidden and use an AbortSignal when querying item metadata. Source changes, document invalidations and closure cancel the previous request; late responses cannot replace newer data. The inspector is a serializable pane item allowed in the left and right docks, with the right dock as its default location. It supports normal movement between those docks and normal closing behavior.

## Teardown

Discard the service reference when the connection is disposed. A reference retained from a retired provider generation resolves to null and cannot create or reveal a new inspector.

## Versioning

Changes incompatible with this contract require a new major service version.

import { assert, describe, it } from "vitest";

import { createCollectionResourceRegistry } from "./browser-collection-database";

type CollectionSource = {
  scope: string;
  adapterIdentity: string;
};

const createRegistry = () => {
  let created = 0;
  const registry = createCollectionResourceRegistry({
    resourceKey: (source: CollectionSource) =>
      JSON.stringify([source.scope, source.adapterIdentity]),
    createResource: () => ({ id: ++created }),
  });

  return { registry, createdCount: () => created };
};

describe("collection resource registry", () => {
  it("reuses a resource for the same source", () => {
    const { registry, createdCount } = createRegistry();
    const source = { scope: "org-1", adapterIdentity: "adapter-1" };

    const first = registry.resourceFor(source);
    const second = registry.resourceFor(source);

    assert.equal(second, first);
    assert.equal(createdCount(), 1);
  });

  it("isolates resources by source identity", () => {
    const { registry, createdCount } = createRegistry();

    const original = registry.resourceFor({ scope: "org-1", adapterIdentity: "adapter-1" });
    const anotherScope = registry.resourceFor({
      scope: "org-2",
      adapterIdentity: "adapter-1",
    });
    const replacedAdapter = registry.resourceFor({
      scope: "org-1",
      adapterIdentity: "adapter-2",
    });

    assert.notEqual(anotherScope, original);
    assert.notEqual(replacedAdapter, original);
    assert.equal(createdCount(), 3);
  });
});

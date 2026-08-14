import { assert, describe, expect, it } from "vitest";

import {
  createBrowserCollectionDatabaseLoader,
  createCollectionResourceRegistry,
} from "./browser-collection-database";

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

describe("browser collection database loader", () => {
  it("reuses a successful browser database promise", async () => {
    const originalWindow = globalThis.window;
    Object.assign(globalThis, { window: {} });
    let openings = 0;
    const load = createBrowserCollectionDatabaseLoader({
      name: "Test database",
      async open() {
        openings += 1;
        return { openings };
      },
    });

    try {
      const first = load();
      const second = load();
      assert.equal(second, first);
      await expect(first).resolves.toEqual({ openings: 1 });
    } finally {
      Object.assign(globalThis, { window: originalWindow });
    }
  });

  it("retries after opening fails", async () => {
    const originalWindow = globalThis.window;
    Object.assign(globalThis, { window: {} });
    let openings = 0;
    const load = createBrowserCollectionDatabaseLoader({
      name: "Test database",
      async open() {
        openings += 1;
        if (openings === 1) {
          throw new Error("unavailable");
        }
        return { openings };
      },
    });

    try {
      await expect(load()).rejects.toThrow("unavailable");
      await expect(load()).resolves.toEqual({ openings: 2 });
    } finally {
      Object.assign(globalThis, { window: originalWindow });
    }
  });
});

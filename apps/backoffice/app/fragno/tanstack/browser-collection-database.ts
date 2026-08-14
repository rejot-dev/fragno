export type BrowserCollectionDatabase<TSource, TCollections> = {
  readyCollectionsFor(source: TSource): Promise<TCollections>;
};

export function createCollectionResourceRegistry<TSource, TResource>(options: {
  resourceKey(source: TSource): string;
  createResource(source: TSource, invalidateResource: () => boolean): TResource;
}) {
  const resources = new Map<string, TResource>();

  return {
    resourceFor(source: TSource): TResource {
      const resourceKey = options.resourceKey(source);
      const existing = resources.get(resourceKey);
      if (existing) {
        return existing;
      }

      let resource!: TResource;
      const invalidateResource = () => {
        if (resources.get(resourceKey) !== resource) {
          return false;
        }

        return resources.delete(resourceKey);
      };
      resource = options.createResource(source, invalidateResource);
      resources.set(resourceKey, resource);
      return resource;
    },
  };
}

export function createBrowserCollectionDatabaseLoader<TDatabase>(options: {
  name: string;
  open(): Promise<TDatabase>;
}): () => Promise<TDatabase> {
  let databasePromise: Promise<TDatabase> | undefined;

  return () => {
    if (typeof window === "undefined") {
      throw new Error(`${options.name} is only available in the browser.`);
    }

    databasePromise ??= options.open().catch((error: unknown) => {
      databasePromise = undefined;
      throw error;
    });
    return databasePromise;
  };
}

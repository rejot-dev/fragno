import { allTasks } from "nanostores";
import type { FetcherStore } from "@nanostores/query";

let stores: FetcherStore[] = [];

export const SSR_ENABLED = false;

export function getStores() {
  return stores;
}

export function addStore(store: FetcherStore) {
  stores.push(store);
}

export function cleanStores() {
  stores = [];
}

// Client side
declare global {
  interface Window {
    __FRAGNO_INITIAL_DATA__?: [string, unknown][];
  }
}

let clientInitialData: Map<string, unknown> | undefined;

export function hydrateFromWindow() {
  if (typeof window !== "undefined" && window.__FRAGNO_INITIAL_DATA__) {
    clientInitialData = new Map(window.__FRAGNO_INITIAL_DATA__);
    delete window.__FRAGNO_INITIAL_DATA__;
    console.warn("hydrateFromWindow", {
      clientInitialData: Array.from(clientInitialData.entries()),
    });
  }
}

export function getInitialData(key: string): unknown | undefined {
  if (clientInitialData?.has(key)) {
    const data = clientInitialData.get(key);
    clientInitialData.delete(key);
    return data;
  }
  return undefined;
}

function listenToStores(): void {
  for (const store of getStores()) {
    // By calling `listen`, we trigger the fetcher function of the store.
    // This will start the data fetching process on the server.
    // We don't need to do anything with the return value of `listen`, as we
    // are only interested in starting the data fetching.
    store.listen(() => {});
  }
}

// Server side
export async function getFinalStoreValues(): Promise<Map<string, unknown>> {
  listenToStores();
  await allTasks();

  const stores = getStores();
  const storesInitialValue = new Map<string, unknown>();

  for (const store of stores) {
    const value = store.get();
    if (!value || !store.key || value.loading) {
      continue;
    }
    storesInitialValue.set(store.key, value.data);
  }

  return storesInitialValue;
}

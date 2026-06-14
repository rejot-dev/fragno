export type StorageLike = Pick<Storage, "getItem" | "setItem" | "removeItem">;

export function getClientStorage(storage?: StorageLike | null): StorageLike | null {
  if (storage != null) {
    return storage;
  }
  if (typeof window === "undefined") {
    return null;
  }

  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

export function readStorageItem(key: string, storage?: StorageLike | null): string | null {
  const resolvedStorage = getClientStorage(storage);
  if (!resolvedStorage) {
    return null;
  }

  try {
    return resolvedStorage.getItem(key);
  } catch {
    return null;
  }
}

export function writeStorageItem(
  key: string,
  value: string,
  storage?: StorageLike | null,
): boolean {
  const resolvedStorage = getClientStorage(storage);
  if (!resolvedStorage) {
    return false;
  }

  try {
    resolvedStorage.setItem(key, value);
    return true;
  } catch {
    return false;
  }
}

export function removeStorageItem(key: string, storage?: StorageLike | null): boolean {
  const resolvedStorage = getClientStorage(storage);
  if (!resolvedStorage) {
    return false;
  }

  try {
    resolvedStorage.removeItem(key);
    return true;
  } catch {
    return false;
  }
}

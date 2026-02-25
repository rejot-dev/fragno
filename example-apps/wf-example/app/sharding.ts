const SHARD_STORAGE_KEY = "wf-example:shard";
const SHARD_COOKIE_NAME = "wf_example_shard";

export function getStoredShard(): string | null {
  if (typeof window === "undefined") {
    return null;
  }

  const stored = window.localStorage.getItem(SHARD_STORAGE_KEY);
  if (!stored) {
    return null;
  }

  const trimmed = stored.trim();
  return trimmed.length > 0 ? trimmed : null;
}

export function setStoredShard(shard: string): void {
  if (typeof window === "undefined") {
    return;
  }

  const trimmed = shard.trim();
  if (trimmed.length === 0) {
    return;
  }

  window.localStorage.setItem(SHARD_STORAGE_KEY, trimmed);
  document.cookie = `${SHARD_COOKIE_NAME}=${encodeURIComponent(trimmed)}; path=/; samesite=lax`;
}

export function clearStoredShard(): void {
  if (typeof window === "undefined") {
    return;
  }

  window.localStorage.removeItem(SHARD_STORAGE_KEY);
  document.cookie = `${SHARD_COOKIE_NAME}=; path=/; expires=Thu, 01 Jan 1970 00:00:00 GMT; samesite=lax`;
}

export { SHARD_STORAGE_KEY, SHARD_COOKIE_NAME };

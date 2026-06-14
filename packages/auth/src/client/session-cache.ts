import { readStorageItem, removeStorageItem, writeStorageItem, type StorageLike } from "./storage";

export interface AuthSessionCache<TMe = unknown> {
  me: TMe;
  updatedAt: string;
  expiresAt: string | null;
  activeOrganizationId: string | null;
}

export interface AuthSessionCacheOptions {
  storage?: StorageLike | null;
  storageKey?: string;
  ttlSeconds?: number;
}

export const DEFAULT_AUTH_SESSION_CACHE_STORAGE_KEY = "fragno_auth_session_cache";
export const DEFAULT_AUTH_SESSION_CACHE_TTL_SECONDS = 15 * 60;

const resolveStorageKey = (options?: AuthSessionCacheOptions) =>
  options?.storageKey ?? DEFAULT_AUTH_SESSION_CACHE_STORAGE_KEY;

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

export function isAuthSessionCacheShape<TMe = unknown>(
  value: unknown,
): value is AuthSessionCache<TMe> {
  return (
    isObject(value) &&
    "me" in value &&
    typeof value["updatedAt"] === "string" &&
    (typeof value["expiresAt"] === "string" || value["expiresAt"] === null) &&
    (typeof value["activeOrganizationId"] === "string" || value["activeOrganizationId"] === null)
  );
}

export function readAuthSessionCache<TMe = unknown>(
  options?: AuthSessionCacheOptions,
): AuthSessionCache<TMe> | null {
  const key = resolveStorageKey(options);
  const raw = readStorageItem(key, options?.storage);
  if (!raw) {
    return null;
  }

  try {
    const parsed = JSON.parse(raw) as unknown;
    if (isAuthSessionCacheShape<TMe>(parsed)) {
      return parsed;
    }
  } catch {
    // Treat malformed JSON as a cache miss and clear below.
  }

  removeStorageItem(key, options?.storage);
  return null;
}

export function writeAuthSessionCache<TMe = unknown>(
  cache: AuthSessionCache<TMe>,
  options?: AuthSessionCacheOptions,
): boolean {
  return writeStorageItem(resolveStorageKey(options), JSON.stringify(cache), options?.storage);
}

export function clearAuthSessionCache(options?: AuthSessionCacheOptions): boolean {
  return removeStorageItem(resolveStorageKey(options), options?.storage);
}

export function isAuthSessionCacheFresh(
  cache: AuthSessionCache,
  now: Date = new Date(),
  options?: Pick<AuthSessionCacheOptions, "ttlSeconds">,
): boolean {
  const updatedAt = Date.parse(cache.updatedAt);
  if (!Number.isFinite(updatedAt)) {
    return false;
  }

  if (cache.expiresAt) {
    const expiresAt = Date.parse(cache.expiresAt);
    if (!Number.isFinite(expiresAt) || expiresAt <= now.getTime()) {
      return false;
    }
  }

  const ttlSeconds = options?.ttlSeconds ?? DEFAULT_AUTH_SESSION_CACHE_TTL_SECONDS;
  return now.getTime() - updatedAt <= ttlSeconds * 1000;
}

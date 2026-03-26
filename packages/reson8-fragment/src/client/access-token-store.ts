import { atom, computed } from "nanostores";

import type { Reson8AuthToken } from "../routes/auth";

const DEFAULT_REFRESH_BUFFER_MS = 30_000;

const logReson8AccessToken = (message: string, details?: Record<string, unknown>) => {
  if (details) {
    console.debug(`[reson8/access-token] ${message}`, details);
    return;
  }

  console.debug(`[reson8/access-token] ${message}`);
};

const summarizeToken = (token: Reson8AuthToken) => ({
  tokenType: token.token_type,
  expiresIn: token.expires_in,
  accessTokenPreview:
    token.access_token.length > 12
      ? `${token.access_token.slice(0, 6)}…${token.access_token.slice(-6)}`
      : token.access_token,
});

export interface CreateReson8AccessTokenStoreOptions {
  requestToken: () => Promise<Reson8AuthToken>;
  now?: () => number;
  refreshBufferMs?: number;
}

export class Reson8AccessTokenStore {
  readonly token = atom<Reson8AuthToken | null>(null);
  readonly accessToken = computed(this.token, (token) => token?.access_token ?? null);
  readonly authorization = computed(this.token, (token) =>
    token ? `${token.token_type} ${token.access_token}` : null,
  );
  readonly expiresAt = atom<number | null>(null);
  readonly loading = atom(false);
  readonly error = atom<unknown>(null);

  #requestToken: () => Promise<Reson8AuthToken>;
  #now: () => number;
  #refreshBufferMs: number;
  #inflight: Promise<Reson8AuthToken> | null = null;

  constructor(options: CreateReson8AccessTokenStoreOptions) {
    this.#requestToken = options.requestToken;
    this.#now = options.now ?? Date.now;
    this.#refreshBufferMs = options.refreshBufferMs ?? DEFAULT_REFRESH_BUFFER_MS;
  }

  clear() {
    this.token.set(null);
    this.expiresAt.set(null);
    this.error.set(null);
    this.loading.set(false);
    this.#inflight = null;
  }

  hasFreshToken() {
    const token = this.token.get();
    const expiresAt = this.expiresAt.get();

    if (!token || !expiresAt) {
      logReson8AccessToken("No cached token available.");
      return false;
    }

    const now = this.#now();
    const isFresh = expiresAt - this.#refreshBufferMs > now;

    logReson8AccessToken("Checked cached token freshness.", {
      expiresAt,
      now,
      refreshBufferMs: this.#refreshBufferMs,
      isFresh,
      ...summarizeToken(token),
    });

    return isFresh;
  }

  async ensureToken(options: { forceRefresh?: boolean } = {}): Promise<Reson8AuthToken> {
    logReson8AccessToken("Ensuring token.", {
      forceRefresh: options.forceRefresh ?? false,
      hasInflightRequest: Boolean(this.#inflight),
    });

    if (!options.forceRefresh && this.hasFreshToken()) {
      const token = this.token.get();
      if (!token) {
        throw new Error("Reson8 token store lost its cached token.");
      }

      logReson8AccessToken("Using cached token.", summarizeToken(token));
      return token;
    }

    if (this.#inflight) {
      logReson8AccessToken("Reusing inflight token request.");
      return this.#inflight;
    }

    this.loading.set(true);
    this.error.set(null);
    logReson8AccessToken("Requesting new token from backend.");

    this.#inflight = this.#requestToken()
      .then((token) => {
        const expiresAt = this.#now() + token.expires_in * 1000;
        this.token.set(token);
        this.expiresAt.set(expiresAt);
        logReson8AccessToken("Received new token.", {
          ...summarizeToken(token),
          expiresAt,
        });
        return token;
      })
      .catch((error) => {
        this.error.set(error);
        console.error("[reson8/access-token] Token request failed.", error);
        throw error;
      })
      .finally(() => {
        this.loading.set(false);
        this.#inflight = null;
        logReson8AccessToken("Token ensure flow finished.");
      });

    return this.#inflight;
  }

  async ensureAuthorization(options: { forceRefresh?: boolean } = {}) {
    const token = await this.ensureToken(options);
    return `${token.token_type} ${token.access_token}`;
  }
}

export const createReson8AccessTokenStore = (options: CreateReson8AccessTokenStoreOptions) =>
  new Reson8AccessTokenStore(options);

import { atom, computed } from "nanostores";

import type { Reson8AuthToken } from "../routes/auth";
import type { Reson8PrerecordedWord } from "../routes/prerecorded";

const DEFAULT_RESON8_REALTIME_BASE_URL = "https://api.reson8.dev/v1";
const OPEN_READY_STATE = 1;
const CLOSING_READY_STATE = 2;

const logReson8Realtime = (message: string, details?: Record<string, unknown>) => {
  if (details) {
    console.debug(`[reson8/realtime] ${message}`, details);
    return;
  }

  console.debug(`[reson8/realtime] ${message}`);
};

const summarizeToken = (token: Reson8AuthToken) => ({
  tokenType: token.token_type,
  expiresIn: token.expires_in,
  accessTokenPreview:
    token.access_token.length > 12
      ? `${token.access_token.slice(0, 6)}…${token.access_token.slice(-6)}`
      : token.access_token,
});

export type Reson8RealtimeQuery = {
  encoding?: "auto" | "pcm_s16le";
  sample_rate?: number;
  channels?: number;
  custom_model_id?: string;
  include_timestamps?: boolean;
  include_words?: boolean;
  include_confidence?: boolean;
  include_interim?: boolean;
};

export type Reson8RealtimeTranscript = {
  type: "transcript";
  text: string;
  is_final?: boolean;
  start_ms?: number;
  duration_ms?: number;
  words?: Reson8PrerecordedWord[];
};

export type Reson8RealtimeFlushRequest = {
  type: "flush_request";
  id?: string;
};

export type Reson8RealtimeFlushConfirmation = {
  type: "flush_confirmation";
  id: string | null;
};

export type Reson8RealtimeUnknownMessage = {
  type: string;
} & Record<string, unknown>;

export type Reson8RealtimeServerMessage =
  | Reson8RealtimeTranscript
  | Reson8RealtimeFlushConfirmation
  | Reson8RealtimeUnknownMessage;

export type Reson8RealtimeSessionError = {
  source: "token" | "websocket" | "message";
  message: string;
  cause?: unknown;
};

export type Reson8RealtimeCloseEvent = {
  code: number;
  reason: string;
  wasClean: boolean;
};

export type Reson8RealtimeConnectionState =
  | "idle"
  | "authenticating"
  | "connecting"
  | "open"
  | "closing"
  | "closed"
  | "error";

export interface Reson8WebSocketLike {
  readyState: number;
  onopen: ((event: Event) => void) | null;
  onmessage: ((event: MessageEvent) => void) | null;
  onerror: ((event: Event) => void) | null;
  onclose: ((event: CloseEvent) => void) | null;
  send(data: string | Blob | ArrayBuffer | ArrayBufferView): void;
  close(code?: number, reason?: string): void;
}

export type CreateReson8WebSocket = (url: string, protocols: string[]) => Reson8WebSocketLike;

export type CreateReson8RealtimeSessionStoreArgs = {
  query?: Reson8RealtimeQuery;
  autoConnect?: boolean;
};

export interface CreateReson8RealtimeSessionStoreOptions {
  query?: Reson8RealtimeQuery;
  autoConnect?: boolean;
  ensureToken: (options?: { forceRefresh?: boolean }) => Promise<Reson8AuthToken>;
  createWebSocket?: CreateReson8WebSocket;
  realtimeBaseUrl?: string;
}

const isTranscript = (message: Reson8RealtimeServerMessage): message is Reson8RealtimeTranscript =>
  message.type === "transcript";

const isFlushConfirmation = (
  message: Reson8RealtimeServerMessage,
): message is Reson8RealtimeFlushConfirmation => message.type === "flush_confirmation";

const isKnownServerMessage = (value: unknown): value is Reson8RealtimeServerMessage => {
  if (typeof value !== "object" || value === null || !("type" in value)) {
    return false;
  }

  const message = value as Record<string, unknown>;
  return typeof message["type"] === "string";
};

const appendQueryParameters = (url: URL, query?: Reson8RealtimeQuery) => {
  for (const [key, value] of Object.entries(query ?? {})) {
    if (typeof value === "undefined" || value === null) {
      continue;
    }

    url.searchParams.set(key, String(value));
  }

  return url;
};

export const buildReson8RealtimeUrl = (
  query?: Reson8RealtimeQuery,
  realtimeBaseUrl = DEFAULT_RESON8_REALTIME_BASE_URL,
) => {
  const url = new URL(realtimeBaseUrl);
  const normalizedPathname = url.pathname.replace(/\/+$/, "");

  url.pathname = normalizedPathname.endsWith("/v1")
    ? `${normalizedPathname}/speech-to-text/realtime`
    : `${normalizedPathname}/v1/speech-to-text/realtime`;

  if (url.protocol === "http:") {
    url.protocol = "ws:";
  } else if (url.protocol === "https:") {
    url.protocol = "wss:";
  }

  return appendQueryParameters(url, query).toString();
};

const createDefaultWebSocket = (): CreateReson8WebSocket => {
  const webSocket = globalThis.WebSocket;

  if (!webSocket) {
    throw new Error(
      "Reson8 realtime requires a WebSocket implementation. Pass createWebSocket in the client config when running outside the browser.",
    );
  }

  return (url, protocols) => new webSocket(url, protocols);
};

const closeEventFromUnknown = (event: CloseEvent | undefined | null): Reson8RealtimeCloseEvent => ({
  code: event?.code ?? 1006,
  reason: event?.reason ?? "",
  wasClean: event?.wasClean ?? false,
});

const messageError = (message: string, cause?: unknown): Reson8RealtimeSessionError => ({
  source: "message",
  message,
  cause,
});

const websocketError = (message: string, cause?: unknown): Reson8RealtimeSessionError => ({
  source: "websocket",
  message,
  cause,
});

export class Reson8RealtimeSessionStore {
  readonly connectionState = atom<Reson8RealtimeConnectionState>("idle");
  readonly socketUrl = atom<string | null>(null);
  readonly messages = atom<Reson8RealtimeServerMessage[]>([]);
  readonly errors = atom<Reson8RealtimeSessionError[]>([]);
  readonly closeEvents = atom<Reson8RealtimeCloseEvent[]>([]);
  readonly latestMessage = computed(this.messages, (messages) => messages.at(-1) ?? null);
  readonly transcripts = computed(this.messages, (messages) => messages.filter(isTranscript));
  readonly finalTranscripts = computed(this.transcripts, (messages) =>
    messages.filter((message) => message.is_final !== false),
  );
  readonly interimTranscripts = computed(this.transcripts, (messages) =>
    messages.filter((message) => message.is_final === false),
  );
  readonly flushConfirmations = computed(this.messages, (messages) =>
    messages.filter(isFlushConfirmation),
  );
  readonly unknownMessages = computed(this.messages, (messages) =>
    messages.filter((message) => !isTranscript(message) && !isFlushConfirmation(message)),
  );
  readonly fullTranscript = computed(this.finalTranscripts, (messages) =>
    messages
      .map((message) => message.text.trim())
      .filter((message) => message.length > 0)
      .join(" "),
  );
  readonly interimTranscript = computed(this.latestMessage, (message) => {
    if (!message) {
      return null;
    }

    return isTranscript(message) && message.is_final === false ? message.text : null;
  });

  readonly query: Reson8RealtimeQuery;

  #ensureToken: CreateReson8RealtimeSessionStoreOptions["ensureToken"];
  #createWebSocket: CreateReson8WebSocket;
  #realtimeBaseUrl: string;
  #socket: Reson8WebSocketLike | null = null;
  #connectPromise: Promise<void> | null = null;

  constructor(options: CreateReson8RealtimeSessionStoreOptions) {
    this.query = options.query ?? {};
    this.#ensureToken = options.ensureToken;
    this.#createWebSocket = options.createWebSocket ?? createDefaultWebSocket();
    this.#realtimeBaseUrl = options.realtimeBaseUrl ?? DEFAULT_RESON8_REALTIME_BASE_URL;

    if (options.autoConnect && typeof window !== "undefined") {
      void this.connect();
    }
  }

  clearMessages() {
    this.messages.set([]);
  }

  clearErrors() {
    this.errors.set([]);
    this.closeEvents.set([]);
  }

  async connect(options: { forceRefreshToken?: boolean } = {}) {
    logReson8Realtime("connect() called.", {
      forceRefreshToken: options.forceRefreshToken ?? false,
      hasSocket: Boolean(this.#socket),
      readyState: this.#socket?.readyState ?? null,
      query: this.query,
      realtimeBaseUrl: this.#realtimeBaseUrl,
    });

    if (this.#socket && this.#socket.readyState === OPEN_READY_STATE) {
      logReson8Realtime("Socket already open, skipping connect().");
      return;
    }

    if (this.#connectPromise) {
      logReson8Realtime("Connection already in progress, reusing promise.");
      return this.#connectPromise;
    }

    this.connectionState.set("authenticating");

    this.#connectPromise = this.#openSocket(options.forceRefreshToken ?? false).finally(() => {
      logReson8Realtime("connect() flow finished.");
      this.#connectPromise = null;
    });

    return this.#connectPromise;
  }

  disconnect(code = 1000, reason = "Normal Closure") {
    logReson8Realtime("disconnect() called.", {
      code,
      reason,
      hasSocket: Boolean(this.#socket),
      readyState: this.#socket?.readyState ?? null,
    });

    if (!this.#socket) {
      this.connectionState.set("closed");
      return;
    }

    const readyState = this.#socket.readyState;
    if (readyState === CLOSING_READY_STATE || readyState > CLOSING_READY_STATE) {
      logReson8Realtime("Socket already closing or closed.", { readyState });
      return;
    }

    this.connectionState.set("closing");
    this.#socket.close(code, reason);
  }

  sendAudio(data: Blob | ArrayBuffer | ArrayBufferView) {
    const socket = this.#requireOpenSocket();
    logReson8Realtime("Sending audio chunk.", {
      dataType:
        data instanceof Blob
          ? "Blob"
          : data instanceof ArrayBuffer
            ? "ArrayBuffer"
            : ArrayBuffer.isView(data)
              ? data.constructor.name
              : typeof data,
      byteLength:
        data instanceof Blob
          ? data.size
          : data instanceof ArrayBuffer
            ? data.byteLength
            : ArrayBuffer.isView(data)
              ? data.byteLength
              : null,
    });
    socket.send(data);
  }

  flush(id: string | undefined = globalThis.crypto?.randomUUID?.()) {
    const socket = this.#requireOpenSocket();
    const message: Reson8RealtimeFlushRequest = {
      type: "flush_request",
      ...(id ? { id } : {}),
    };

    logReson8Realtime("Sending flush request.", { id: id ?? null });
    socket.send(JSON.stringify(message));
    return id ?? null;
  }

  [Symbol.dispose]() {
    this.disconnect(1000, "Disposed");
  }

  async #openSocket(forceRefreshToken: boolean) {
    logReson8Realtime("Starting socket setup.", {
      forceRefreshToken,
      query: this.query,
      realtimeBaseUrl: this.#realtimeBaseUrl,
    });

    let token: Reson8AuthToken;
    try {
      token = await this.#ensureToken({ forceRefresh: forceRefreshToken });
      logReson8Realtime("Token resolved for realtime connection.", summarizeToken(token));
    } catch (error) {
      this.connectionState.set("error");
      this.#appendError({
        source: "token",
        message: error instanceof Error ? error.message : String(error),
        cause: error,
      });
      console.error("[reson8/realtime] Failed to resolve token for realtime connection.", error);
      throw error;
    }

    const url = buildReson8RealtimeUrl(this.query, this.#realtimeBaseUrl);
    this.socketUrl.set(url);
    this.connectionState.set("connecting");

    const protocols = ["bearer", token.access_token];
    logReson8Realtime("Opening WebSocket.", {
      url,
      protocolsPreview: ["bearer", summarizeToken(token).accessTokenPreview],
      query: this.query,
    });

    const socket = this.#createWebSocket(url, protocols);
    this.#socket = socket;

    return new Promise<void>((resolve, reject) => {
      let settled = false;

      socket.onopen = (event) => {
        settled = true;
        this.connectionState.set("open");
        logReson8Realtime("WebSocket opened.", {
          readyState: socket.readyState,
          eventType: event.type,
        });
        resolve(void event);
      };

      socket.onmessage = (event) => {
        logReson8Realtime("WebSocket message received.", {
          dataType:
            event.data instanceof Blob
              ? "Blob"
              : event.data instanceof ArrayBuffer
                ? "ArrayBuffer"
                : ArrayBuffer.isView(event.data)
                  ? event.data.constructor.name
                  : typeof event.data,
        });
        void this.#handleIncomingMessage(event.data);
      };

      socket.onerror = (event) => {
        logReson8Realtime("WebSocket error event fired.", {
          readyState: socket.readyState,
          eventType: event.type,
          url,
        });
        const error = websocketError("Reson8 realtime WebSocket error.", event);
        this.#appendError(error);
        if (!settled) {
          settled = true;
          this.connectionState.set("error");
          reject(new Error(error.message));
        }
      };

      socket.onclose = (event) => {
        const closeEvent = closeEventFromUnknown(event);
        logReson8Realtime("WebSocket closed.", {
          ...closeEvent,
          settled,
          url,
        });
        this.closeEvents.set([...this.closeEvents.get(), closeEvent]);
        this.#socket = null;

        if (!settled) {
          settled = true;
          const error = new Error(
            `Reson8 realtime WebSocket closed before opening (code ${event.code}).`,
          );
          this.connectionState.set("error");
          this.#appendError(websocketError(error.message, event));
          reject(error);
          return;
        }

        this.connectionState.set("closed");
      };
    });
  }

  #requireOpenSocket() {
    if (!this.#socket || this.#socket.readyState !== OPEN_READY_STATE) {
      logReson8Realtime("Tried to use socket while not open.", {
        hasSocket: Boolean(this.#socket),
        readyState: this.#socket?.readyState ?? null,
      });
      throw new Error("Reson8 realtime WebSocket is not connected.");
    }

    return this.#socket;
  }

  #appendError(error: Reson8RealtimeSessionError) {
    console.error("[reson8/realtime] Recorded session error.", error);
    this.errors.set([...this.errors.get(), error]);
  }

  async #handleIncomingMessage(data: unknown) {
    try {
      const payload = await this.#decodeIncomingMessage(data);
      logReson8Realtime("Decoded incoming message payload.", {
        payloadPreview: payload.slice(0, 500),
      });
      const parsed = JSON.parse(payload) as unknown;

      if (!isKnownServerMessage(parsed)) {
        throw new Error("Reson8 realtime sent an unsupported message payload.");
      }

      logReson8Realtime("Parsed incoming realtime message.", {
        type: parsed.type,
      });
      this.messages.set([...this.messages.get(), parsed]);
    } catch (error) {
      this.#appendError(
        messageError(
          error instanceof Error ? error.message : "Failed to parse Reson8 realtime message.",
          error,
        ),
      );
    }
  }

  async #decodeIncomingMessage(data: unknown): Promise<string> {
    if (typeof data === "string") {
      return data;
    }

    if (data instanceof ArrayBuffer) {
      return new TextDecoder().decode(data);
    }

    if (ArrayBuffer.isView(data)) {
      return new TextDecoder().decode(data);
    }

    if (typeof Blob !== "undefined" && data instanceof Blob) {
      return data.text();
    }

    throw new Error("Reson8 realtime sent an unsupported message format.");
  }
}

export const createReson8RealtimeSessionStore = (
  options: CreateReson8RealtimeSessionStoreOptions,
) => new Reson8RealtimeSessionStore(options);

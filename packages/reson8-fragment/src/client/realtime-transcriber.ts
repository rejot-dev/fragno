import { atom, computed, type ReadableAtom } from "nanostores";

import type { Reson8AccessTokenStore } from "./access-token-store";
import {
  createReson8MicrophoneCapture,
  type CreateReson8AudioContext,
  type CreateReson8MicrophoneCaptureOptions,
  type GetReson8UserMedia,
  type Reson8MicrophoneCapture,
  type Reson8MicrophonePermissionState,
} from "./microphone-capture";
import {
  createReson8RealtimeSessionStore,
  type CreateReson8RealtimeSessionStoreOptions,
  type CreateReson8WebSocket,
  type Reson8RealtimeCloseEvent,
  type Reson8RealtimeConnectionState,
  type Reson8RealtimeFlushConfirmation,
  type Reson8RealtimeQuery,
  type Reson8RealtimeServerMessage,
  type Reson8RealtimeSessionError,
  type Reson8RealtimeSessionStore,
  type Reson8RealtimeTranscript,
  type Reson8RealtimeUnknownMessage,
} from "./realtime-session";

export type CreateReson8RealtimeTranscriberArgs = {
  query?: Omit<Reson8RealtimeQuery, "encoding" | "sample_rate">;
  microphone?: {
    channels?: number;
    bufferSize?: number;
    constraints?: MediaTrackConstraints;
  };
  autoStart?: boolean;
  recordAudio?: boolean;
};

export type CreateReson8RealtimeTranscriberOptions = {
  args?: CreateReson8RealtimeTranscriberArgs;
  accessTokenStore: Reson8AccessTokenStore;
  createWebSocket?: CreateReson8WebSocket;
  realtimeBaseUrl?: string;
  getUserMedia?: GetReson8UserMedia;
  createAudioContext?: CreateReson8AudioContext;
};

const logReson8Transcriber = (message: string, details?: Record<string, unknown>) => {
  if (details) {
    console.debug(`[reson8/transcriber] ${message}`, details);
    return;
  }

  console.debug(`[reson8/transcriber] ${message}`);
};

const mirrorNestedStore = <T>(
  target: ReadableAtom<T> & { set(value: T): void },
  source: ReadableAtom<T>,
): (() => void) => {
  target.set(source.get());
  return source.listen((value) => {
    target.set(value);
  });
};

const createReson8WavBlobFromPcm16Chunks = (
  chunks: Uint8Array[],
  sampleRate: number,
  channels: number,
) => {
  const dataSize = chunks.reduce((total, chunk) => total + chunk.byteLength, 0);
  const header = new ArrayBuffer(44);
  const view = new DataView(header);

  const writeString = (offset: number, value: string) => {
    for (let index = 0; index < value.length; index += 1) {
      view.setUint8(offset + index, value.charCodeAt(index));
    }
  };

  const bytesPerSample = 2;
  const blockAlign = channels * bytesPerSample;
  const byteRate = sampleRate * blockAlign;

  writeString(0, "RIFF");
  view.setUint32(4, 36 + dataSize, true);
  writeString(8, "WAVE");
  writeString(12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, channels, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, byteRate, true);
  view.setUint16(32, blockAlign, true);
  view.setUint16(34, 16, true);
  writeString(36, "data");
  view.setUint32(40, dataSize, true);

  return new Blob([header, ...chunks.map((chunk) => chunk.slice())], { type: "audio/wav" });
};

const createReson8RecordingFileName = () =>
  `reson8-recording-${new Date().toISOString().replace(/[.:]/g, "-")}.wav`;

const createReson8ObjectUrl = (blob: Blob) => {
  const createObjectURL = globalThis.URL?.createObjectURL;
  return typeof createObjectURL === "function" ? createObjectURL(blob) : null;
};

const revokeReson8ObjectUrl = (url: string | null) => {
  if (!url) {
    return;
  }

  const revokeObjectURL = globalThis.URL?.revokeObjectURL;
  if (typeof revokeObjectURL === "function") {
    revokeObjectURL(url);
  }
};

export class Reson8RealtimeTranscriberStore {
  readonly accessToken: Reson8AccessTokenStore;
  readonly microphone: Reson8MicrophoneCapture;

  readonly starting;
  readonly started;
  readonly connectionState;
  readonly socketUrl;
  readonly messages;
  readonly errors;
  readonly closeEvents;
  readonly latestMessage;
  readonly transcripts;
  readonly finalTranscripts;
  readonly interimTranscripts;
  readonly flushConfirmations;
  readonly unknownMessages;
  readonly fullTranscript;
  readonly interimTranscript;
  readonly microphonePermissionState;
  readonly microphoneCapturing;
  readonly microphoneSampleRate;
  readonly microphoneChannelCount;
  readonly microphoneChunkCount;
  readonly microphoneLastChunkByteLength;
  readonly microphoneError;
  readonly recordedAudioBlob;
  readonly recordedAudioDownloadUrl;
  readonly recordedAudioFileName;
  readonly hasRecordedAudio;

  #query: CreateReson8RealtimeTranscriberArgs["query"];
  #microphoneConfig: NonNullable<CreateReson8RealtimeTranscriberArgs["microphone"]>;
  #session: Reson8RealtimeSessionStore | null = null;
  #sessionUnsubscribers: Array<() => void> = [];
  #createSessionOptions: Pick<
    CreateReson8RealtimeSessionStoreOptions,
    "createWebSocket" | "realtimeBaseUrl"
  >;
  #recordAudio = false;
  #recordedChunks: Uint8Array[] = [];
  #recordedAudioSampleRate: number | null = null;
  #recordedAudioChannels: number | null = null;
  #currentRecordedAudioUrl: string | null = null;

  constructor(options: CreateReson8RealtimeTranscriberOptions) {
    this.accessToken = options.accessTokenStore;
    this.#query = options.args?.query;
    this.#recordAudio = options.args?.recordAudio ?? false;
    this.#microphoneConfig = {
      channels: options.args?.microphone?.channels ?? 1,
      bufferSize: options.args?.microphone?.bufferSize,
      constraints: options.args?.microphone?.constraints,
    };
    this.#createSessionOptions = {
      createWebSocket: options.createWebSocket,
      realtimeBaseUrl: options.realtimeBaseUrl,
    };
    this.microphone = createReson8MicrophoneCapture({
      getUserMedia: options.getUserMedia,
      createAudioContext: options.createAudioContext,
    } satisfies CreateReson8MicrophoneCaptureOptions);

    this.starting = atom(false);
    this.started = computed(
      [this.starting, this.microphone.capturing],
      (starting, capturing) => starting || capturing,
    );
    this.connectionState = atom<Reson8RealtimeConnectionState>("idle");
    this.socketUrl = atom<string | null>(null);
    this.messages = atom<Reson8RealtimeServerMessage[]>([]);
    this.errors = atom<Reson8RealtimeSessionError[]>([]);
    this.closeEvents = atom<Reson8RealtimeCloseEvent[]>([]);
    this.latestMessage = computed(this.messages, (messages) => messages.at(-1) ?? null);
    this.transcripts = computed(this.messages, (messages) =>
      messages.filter(
        (message): message is Reson8RealtimeTranscript => message.type === "transcript",
      ),
    );
    this.finalTranscripts = computed(this.transcripts, (messages) =>
      messages.filter((message) => message.is_final !== false),
    );
    this.interimTranscripts = computed(this.transcripts, (messages) =>
      messages.filter((message) => message.is_final === false),
    );
    this.flushConfirmations = computed(this.messages, (messages) =>
      messages.filter(
        (message): message is Reson8RealtimeFlushConfirmation =>
          message.type === "flush_confirmation",
      ),
    );
    this.unknownMessages = computed(this.messages, (messages) =>
      messages.filter(
        (message): message is Reson8RealtimeUnknownMessage =>
          message.type !== "transcript" && message.type !== "flush_confirmation",
      ),
    );
    this.fullTranscript = computed(this.finalTranscripts, (messages) =>
      messages
        .map((message) => message.text.trim())
        .filter((message) => message.length > 0)
        .join(" "),
    );
    this.interimTranscript = computed(this.latestMessage, (message) => {
      if (!message || message.type !== "transcript") {
        return null;
      }

      return message.is_final === false ? message.text : null;
    });
    this.microphonePermissionState = this.microphone.permissionState;
    this.microphoneCapturing = this.microphone.capturing;
    this.microphoneSampleRate = this.microphone.sampleRate;
    this.microphoneChannelCount = this.microphone.channelCount;
    this.microphoneChunkCount = this.microphone.chunkCount;
    this.microphoneLastChunkByteLength = this.microphone.lastChunkByteLength;
    this.microphoneError = this.microphone.error;
    this.recordedAudioBlob = atom<Blob | null>(null);
    this.recordedAudioDownloadUrl = atom<string | null>(null);
    this.recordedAudioFileName = atom<string | null>(null);
    this.hasRecordedAudio = computed(this.recordedAudioBlob, (blob) => blob !== null);

    if (options.args?.autoStart && typeof window !== "undefined") {
      void this.start();
    }
  }

  async ensureToken(options: { forceRefresh?: boolean } = {}) {
    logReson8Transcriber("ensureToken() called.", options);
    return this.accessToken.ensureToken(options);
  }

  async connect(options: { forceRefreshToken?: boolean; sampleRate?: number } = {}) {
    logReson8Transcriber("connect() called.", {
      forceRefreshToken: options.forceRefreshToken ?? false,
      requestedSampleRate: options.sampleRate ?? null,
      microphoneSampleRate: this.microphoneSampleRate.get(),
      query: this.#query,
      hasExistingSession: Boolean(this.#session),
      connectionState: this.connectionState.get(),
    });

    if (this.#session && this.connectionState.get() === "open") {
      logReson8Transcriber("Reusing existing open session.");
      return this.#session;
    }

    this.#replaceSession(
      createReson8RealtimeSessionStore({
        query: {
          encoding: "pcm_s16le",
          sample_rate: options.sampleRate ?? this.microphoneSampleRate.get() ?? 16_000,
          channels: this.#microphoneConfig.channels,
          ...this.#query,
        },
        ensureToken: (tokenOptions) => this.accessToken.ensureToken(tokenOptions),
        ...this.#createSessionOptions,
      }),
    );

    const session = this.#session;
    if (!session) {
      throw new Error("Reson8 transcriber session was not created.");
    }

    await session.connect({ forceRefreshToken: options.forceRefreshToken });
    return session;
  }

  async start(options: { forceRefreshToken?: boolean } = {}) {
    logReson8Transcriber("start() called.", {
      forceRefreshToken: options.forceRefreshToken ?? false,
      starting: this.starting.get(),
      microphoneCapturing: this.microphoneCapturing.get(),
      microphonePermissionState: this.microphonePermissionState.get(),
    });

    if (this.starting.get() || this.microphoneCapturing.get()) {
      logReson8Transcriber("Skipping start() because capture is already in progress.");
      return;
    }

    this.starting.set(true);
    const bufferedChunks: Uint8Array[] = [];
    this.#prepareRecordedAudioCapture();

    try {
      const microphone = await this.microphone.start({
        channels: this.#microphoneConfig.channels,
        bufferSize: this.#microphoneConfig.bufferSize,
        constraints: this.#microphoneConfig.constraints,
        onAudioChunk: (chunk) => {
          if (this.#recordAudio) {
            this.#recordedChunks.push(new Uint8Array(chunk));
          }

          if (this.#session && this.connectionState.get() === "open") {
            this.#session.sendAudio(chunk);
            return;
          }

          bufferedChunks.push(chunk);
        },
      });

      this.#recordedAudioSampleRate = microphone.sampleRate;
      this.#recordedAudioChannels = microphone.channels;

      logReson8Transcriber("Microphone started.", {
        sampleRate: microphone.sampleRate,
        channels: microphone.channels,
        bufferedChunkCount: bufferedChunks.length,
      });

      const session = await this.connect({
        forceRefreshToken: options.forceRefreshToken,
        sampleRate: microphone.sampleRate,
      });

      logReson8Transcriber("Realtime session connected from transcriber.", {
        bufferedChunkCount: bufferedChunks.length,
      });

      for (const chunk of bufferedChunks) {
        session.sendAudio(chunk);
      }
    } catch (error) {
      console.error("[reson8/transcriber] Failed to start realtime transcription.", error);
      await this.#stopMicrophoneAndFinalizeRecording();
      throw error;
    } finally {
      this.starting.set(false);
      logReson8Transcriber("start() finished.", {
        connectionState: this.connectionState.get(),
        microphoneCapturing: this.microphoneCapturing.get(),
      });
    }
  }

  flush() {
    logReson8Transcriber("flush() called.", {
      hasSession: Boolean(this.#session),
      connectionState: this.connectionState.get(),
    });
    return this.#session?.flush() ?? null;
  }

  async stop(options: { flush?: boolean } = {}) {
    logReson8Transcriber("stop() called.", {
      flush: options.flush !== false,
      connectionState: this.connectionState.get(),
    });
    await this.#stopMicrophoneAndFinalizeRecording();

    if (options.flush !== false && this.#session && this.connectionState.get() === "open") {
      return this.#session.flush();
    }

    return null;
  }

  async disconnect(code = 1000, reason = "Normal Closure") {
    logReson8Transcriber("disconnect() called.", {
      code,
      reason,
      connectionState: this.connectionState.get(),
    });
    await this.#stopMicrophoneAndFinalizeRecording();
    this.#session?.disconnect(code, reason);
  }

  clearMessages() {
    this.#session?.clearMessages();
    this.messages.set([]);
  }

  clearErrors() {
    this.#session?.clearErrors();
    this.microphone.clearError();
    this.errors.set([]);
    this.closeEvents.set([]);
  }

  clearRecordedAudio() {
    this.#clearRecordedAudioState();
  }

  [Symbol.dispose]() {
    void this.#dispose();
  }

  async #dispose() {
    await this.disconnect(1000, "Disposed");
    this.#clearRecordedAudioState();
  }

  async #stopMicrophoneAndFinalizeRecording() {
    await this.microphone.stop();
    this.#finalizeRecordedAudio();
  }

  #prepareRecordedAudioCapture() {
    this.#recordedChunks = [];
    this.#recordedAudioSampleRate = null;
    this.#recordedAudioChannels = null;
    this.#clearRecordedAudioState();
  }

  #finalizeRecordedAudio() {
    if (!this.#recordAudio) {
      return;
    }

    if (
      this.#recordedChunks.length === 0 ||
      !this.#recordedAudioSampleRate ||
      !this.#recordedAudioChannels
    ) {
      return;
    }

    const blob = createReson8WavBlobFromPcm16Chunks(
      this.#recordedChunks,
      this.#recordedAudioSampleRate,
      this.#recordedAudioChannels,
    );
    const downloadUrl = createReson8ObjectUrl(blob);

    revokeReson8ObjectUrl(this.#currentRecordedAudioUrl);
    this.#currentRecordedAudioUrl = downloadUrl;
    this.recordedAudioBlob.set(blob);
    this.recordedAudioDownloadUrl.set(downloadUrl);
    this.recordedAudioFileName.set(createReson8RecordingFileName());
    this.#recordedChunks = [];
  }

  #clearRecordedAudioState() {
    this.#recordedChunks = [];
    this.#recordedAudioSampleRate = null;
    this.#recordedAudioChannels = null;
    revokeReson8ObjectUrl(this.#currentRecordedAudioUrl);
    this.#currentRecordedAudioUrl = null;
    this.recordedAudioBlob.set(null);
    this.recordedAudioDownloadUrl.set(null);
    this.recordedAudioFileName.set(null);
  }

  #replaceSession(session: Reson8RealtimeSessionStore) {
    for (const unsubscribe of this.#sessionUnsubscribers) {
      unsubscribe();
    }

    this.#sessionUnsubscribers = [];
    this.#session = session;

    this.#sessionUnsubscribers.push(
      mirrorNestedStore(this.connectionState, session.connectionState),
      mirrorNestedStore(this.socketUrl, session.socketUrl),
      mirrorNestedStore(this.messages, session.messages),
      mirrorNestedStore(this.errors, session.errors),
      mirrorNestedStore(this.closeEvents, session.closeEvents),
    );
  }
}

export const createReson8RealtimeTranscriberStore = (
  options: CreateReson8RealtimeTranscriberOptions,
) => new Reson8RealtimeTranscriberStore(options);

export type { Reson8MicrophoneCapture, Reson8MicrophonePermissionState };

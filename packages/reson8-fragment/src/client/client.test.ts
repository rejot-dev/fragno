import { describe, expect, test, vi } from "vitest";

import type {
  CreateReson8AudioContext,
  CreateReson8WebSocket,
  GetReson8UserMedia,
  Reson8AuthToken,
  Reson8MediaStreamLike,
  Reson8MediaStreamTrackLike,
} from "../index";
import {
  buildReson8RealtimeUrl,
  createReson8AccessTokenStore,
  createReson8MicrophoneCapture,
  createReson8RealtimeSessionStore,
  createReson8RealtimeTranscriberStore,
} from "./client";

class FakeWebSocket {
  static instances: FakeWebSocket[] = [];

  readyState = 0;
  onopen: ((event: Event) => void) | null = null;
  onmessage: ((event: MessageEvent) => void) | null = null;
  onerror: ((event: Event) => void) | null = null;
  onclose: ((event: CloseEvent) => void) | null = null;
  sent: Array<string | Blob | ArrayBuffer | ArrayBufferView> = [];

  constructor(
    readonly url: string,
    readonly protocols: string[],
  ) {
    FakeWebSocket.instances.push(this);
  }

  send(data: string | Blob | ArrayBuffer | ArrayBufferView) {
    this.sent.push(data);
  }

  close(code = 1000, reason = "Normal Closure") {
    this.readyState = 3;
    this.onclose?.({ code, reason, wasClean: true } as CloseEvent);
  }

  open() {
    this.readyState = 1;
    this.onopen?.({} as Event);
  }

  receive(data: unknown) {
    this.onmessage?.({ data } as MessageEvent);
  }
}

class FakeTrack implements Reson8MediaStreamTrackLike {
  stopped = false;

  stop() {
    this.stopped = true;
  }
}

class FakeMediaStream implements Reson8MediaStreamLike {
  constructor(readonly track = new FakeTrack()) {}

  getTracks() {
    return [this.track];
  }
}

class FakeProcessorNode {
  onaudioprocess:
    | ((event: {
        inputBuffer: { numberOfChannels: number; getChannelData(channel: number): Float32Array };
      }) => void)
    | null = null;

  connect() {}

  disconnect() {}

  emit(channels: Float32Array[]) {
    this.onaudioprocess?.({
      inputBuffer: {
        numberOfChannels: channels.length,
        getChannelData: (channel) => channels[channel] ?? channels[0] ?? new Float32Array(),
      },
    });
  }
}

class FakeSourceNode {
  connect(_node: FakeProcessorNode) {}

  disconnect() {}
}

class FakeAudioContext {
  readonly destination = {};
  readonly processor = new FakeProcessorNode();
  readonly source = new FakeSourceNode();
  closed = false;

  constructor(readonly sampleRate: number) {}

  createMediaStreamSource(_stream: Reson8MediaStreamLike) {
    return this.source;
  }

  createScriptProcessor() {
    return this.processor;
  }

  async close() {
    this.closed = true;
  }
}

const token = (accessToken: string): Reson8AuthToken => ({
  access_token: accessToken,
  token_type: "Bearer",
  expires_in: 600,
});

describe("reson8 client helpers", () => {
  test("buildReson8RealtimeUrl converts https to wss and forwards query parameters", () => {
    expect(
      buildReson8RealtimeUrl(
        {
          include_interim: true,
          sample_rate: 16000,
        },
        "https://api.reson8.dev/v1",
      ),
    ).toBe(
      "wss://api.reson8.dev/v1/speech-to-text/realtime?include_interim=true&sample_rate=16000",
    );
  });

  test("buildReson8RealtimeUrl preserves custom path prefixes", () => {
    expect(
      buildReson8RealtimeUrl(
        {
          include_interim: true,
        },
        "https://host/reson8-proxy",
      ),
    ).toBe("wss://host/reson8-proxy/v1/speech-to-text/realtime?include_interim=true");
  });

  test("createReson8AccessTokenStore caches tokens until they are near expiry", async () => {
    let now = 0;
    const requestToken = vi
      .fn<() => Promise<Reson8AuthToken>>()
      .mockResolvedValueOnce(token("token_1"))
      .mockResolvedValueOnce(token("token_2"));

    const store = createReson8AccessTokenStore({
      requestToken,
      now: () => now,
      refreshBufferMs: 10_000,
    });

    expect(await store.ensureAuthorization()).toBe("Bearer token_1");
    expect(await store.ensureAuthorization()).toBe("Bearer token_1");
    expect(requestToken).toHaveBeenCalledTimes(1);
    expect(store.authorization.get()).toBe("Bearer token_1");

    now = 591_000;

    expect(await store.ensureAuthorization()).toBe("Bearer token_2");
    expect(requestToken).toHaveBeenCalledTimes(2);
    expect(store.authorization.get()).toBe("Bearer token_2");
  });

  test("createReson8MicrophoneCapture converts float audio to pcm16", async () => {
    const stream = new FakeMediaStream();
    const audioContext = new FakeAudioContext(24_000);
    const chunks: Uint8Array[] = [];

    const capture = createReson8MicrophoneCapture({
      getUserMedia: (async () => stream) satisfies GetReson8UserMedia,
      createAudioContext: (() => audioContext) satisfies CreateReson8AudioContext,
    });

    await capture.start({
      onAudioChunk: (chunk) => chunks.push(chunk),
    });

    audioContext.processor.emit([new Float32Array([-1, 0, 1])]);

    expect(capture.permissionState.get()).toBe("granted");
    expect(capture.capturing.get()).toBe(true);
    expect(capture.sampleRate.get()).toBe(24_000);
    expect(capture.chunkCount.get()).toBe(1);
    expect(capture.lastChunkByteLength.get()).toBe(6);
    expect(chunks).toHaveLength(1);

    const pcm = new DataView(chunks[0].buffer);
    expect(pcm.getInt16(0, true)).toBe(-32768);
    expect(pcm.getInt16(2, true)).toBe(0);
    expect(pcm.getInt16(4, true)).toBe(32767);

    await capture.stop();
    expect(capture.capturing.get()).toBe(false);
    expect(stream.track.stopped).toBe(true);
    expect(audioContext.closed).toBe(true);
  });

  test("createReson8RealtimeSessionStore opens a websocket and aggregates realtime messages", async () => {
    FakeWebSocket.instances = [];
    const createWebSocket: CreateReson8WebSocket = (url, protocols) =>
      new FakeWebSocket(url, protocols);

    const store = createReson8RealtimeSessionStore({
      query: {
        include_interim: true,
        include_words: true,
      },
      ensureToken: async () => token("access_123"),
      createWebSocket,
    });

    const connectPromise = store.connect();
    await Promise.resolve();
    const socket = FakeWebSocket.instances[0];
    if (!socket) {
      throw new Error("Expected a fake websocket instance.");
    }

    expect(store.connectionState.get()).toBe("connecting");
    expect(socket.url).toBe(
      "wss://api.reson8.dev/v1/speech-to-text/realtime?include_interim=true&include_words=true",
    );
    expect(socket.protocols).toEqual(["bearer", "access_123"]);

    socket.open();
    await connectPromise;

    socket.receive(JSON.stringify({ type: "transcript", text: "hello", is_final: false }));
    await Promise.resolve();
    expect(store.interimTranscript.get()).toBe("hello");

    socket.receive(JSON.stringify({ type: "transcript", text: "hello world", is_final: true }));
    socket.receive(JSON.stringify({ type: "flush_confirmation", id: "flush-1" }));
    await Promise.resolve();

    expect(store.connectionState.get()).toBe("open");
    expect(store.messages.get()).toHaveLength(3);
    expect(store.transcripts.get()).toHaveLength(2);
    expect(store.interimTranscripts.get()).toHaveLength(1);
    expect(store.finalTranscripts.get()).toHaveLength(1);
    expect(store.flushConfirmations.get()).toEqual([{ type: "flush_confirmation", id: "flush-1" }]);
    expect(store.fullTranscript.get()).toBe("hello world");
    expect(store.interimTranscript.get()).toBe(null);

    expect(store.flush("flush-2")).toBe("flush-2");
    expect(socket.sent).toContain('{"type":"flush_request","id":"flush-2"}');

    const audio = new Uint8Array([1, 2, 3]);
    store.sendAudio(audio);
    expect(socket.sent).toContain(audio);

    socket.receive("not json");
    await Promise.resolve();
    expect(store.errors.get()).toHaveLength(1);

    store.disconnect(1000, "done");
    expect(store.connectionState.get()).toBe("closed");
    expect(store.closeEvents.get()).toContainEqual({ code: 1000, reason: "done", wasClean: true });
  });

  test("createReson8RealtimeTranscriberStore composes token and microphone helpers into a higher-level api", async () => {
    const stream = new FakeMediaStream();
    const audioContext = new FakeAudioContext(22_050);
    const requestToken = vi
      .fn<() => Promise<Reson8AuthToken>>()
      .mockResolvedValue(token("transcriber_token"));
    const accessToken = createReson8AccessTokenStore({ requestToken });

    const transcriber = createReson8RealtimeTranscriberStore({
      args: {
        query: { include_interim: true },
      },
      accessTokenStore: accessToken,
      createWebSocket: ((url, protocols) =>
        new FakeWebSocket(url, protocols)) satisfies CreateReson8WebSocket,
      getUserMedia: (async () => stream) satisfies GetReson8UserMedia,
      createAudioContext: (() => audioContext) satisfies CreateReson8AudioContext,
    });

    expect(transcriber.connectionState.get()).toBe("idle");
    expect(transcriber.microphonePermissionState.get()).toBe("idle");
    expect(transcriber.started.get()).toBe(false);

    const ensured = await transcriber.ensureToken();
    expect(ensured.access_token).toBe("transcriber_token");
    expect(requestToken).toHaveBeenCalledTimes(1);
    expect(transcriber.accessToken.authorization.get()).toBe("Bearer transcriber_token");

    await transcriber.microphone.start({
      onAudioChunk: () => {},
    });

    expect(transcriber.microphonePermissionState.get()).toBe("granted");
    expect(transcriber.microphoneCapturing.get()).toBe(true);
    expect(transcriber.microphoneSampleRate.get()).toBe(22_050);

    await transcriber.stop({ flush: false });
    expect(transcriber.microphoneCapturing.get()).toBe(false);
    expect(stream.track.stopped).toBe(true);
  });

  test("createReson8RealtimeTranscriberStore can export a local wav recording after stop", async () => {
    FakeWebSocket.instances = [];

    const originalCreateObjectURL = URL.createObjectURL;
    const originalRevokeObjectURL = URL.revokeObjectURL;
    const createObjectURL = vi.fn(() => "blob:reson8-recording");
    const revokeObjectURL = vi.fn();
    URL.createObjectURL = createObjectURL;
    URL.revokeObjectURL = revokeObjectURL;

    try {
      const stream = new FakeMediaStream();
      const audioContext = new FakeAudioContext(16_000);
      const transcriber = createReson8RealtimeTranscriberStore({
        args: {
          query: { include_interim: true },
          recordAudio: true,
        },
        accessTokenStore: createReson8AccessTokenStore({
          requestToken: async () => token("transcriber_token"),
        }),
        createWebSocket: ((url, protocols) =>
          new FakeWebSocket(url, protocols)) satisfies CreateReson8WebSocket,
        getUserMedia: (async () => stream) satisfies GetReson8UserMedia,
        createAudioContext: (() => audioContext) satisfies CreateReson8AudioContext,
      });

      const startPromise = transcriber.start();
      await new Promise((resolve) => setTimeout(resolve, 0));
      const socket = FakeWebSocket.instances[0];
      if (!socket) {
        throw new Error("Expected a fake websocket instance.");
      }

      socket.open();
      await startPromise;

      audioContext.processor.emit([new Float32Array([0, 0.5, -0.5])]);
      await transcriber.stop({ flush: false });

      const recordedBlob = transcriber.recordedAudioBlob.get();
      expect(recordedBlob).toBeInstanceOf(Blob);
      expect(recordedBlob?.type).toBe("audio/wav");
      expect(transcriber.recordedAudioDownloadUrl.get()).toBe("blob:reson8-recording");
      expect(transcriber.recordedAudioFileName.get()).toMatch(/^reson8-recording-.*\.wav$/);
      expect(transcriber.hasRecordedAudio.get()).toBe(true);
      expect(createObjectURL).toHaveBeenCalledTimes(1);

      const wavBytes = new Uint8Array(await recordedBlob!.arrayBuffer());
      expect(new TextDecoder().decode(wavBytes.slice(0, 4))).toBe("RIFF");
      expect(new TextDecoder().decode(wavBytes.slice(8, 12))).toBe("WAVE");

      transcriber.clearRecordedAudio();
      expect(transcriber.recordedAudioBlob.get()).toBe(null);
      expect(transcriber.recordedAudioDownloadUrl.get()).toBe(null);
      expect(transcriber.recordedAudioFileName.get()).toBe(null);
      expect(transcriber.hasRecordedAudio.get()).toBe(false);
      expect(revokeObjectURL).toHaveBeenCalledWith("blob:reson8-recording");
    } finally {
      URL.createObjectURL = originalCreateObjectURL;
      URL.revokeObjectURL = originalRevokeObjectURL;
    }
  });

  test("createReson8RealtimeTranscriberStore clears interim transcript after final and flush messages", async () => {
    const transcriber = createReson8RealtimeTranscriberStore({
      args: {
        query: { include_interim: true },
      },
      accessTokenStore: createReson8AccessTokenStore({
        requestToken: async () => token("transcriber_token"),
      }),
      createWebSocket: ((url, protocols) =>
        new FakeWebSocket(url, protocols)) satisfies CreateReson8WebSocket,
      getUserMedia: (async () => new FakeMediaStream()) satisfies GetReson8UserMedia,
      createAudioContext: (() => new FakeAudioContext(16_000)) satisfies CreateReson8AudioContext,
    });

    transcriber.messages.set([{ type: "transcript", text: "test one two", is_final: false }]);
    expect(transcriber.interimTranscript.get()).toBe("test one two");

    transcriber.messages.set([
      { type: "transcript", text: "test one two", is_final: false },
      { type: "transcript", text: "test one two three", is_final: true },
    ]);
    expect(transcriber.interimTranscript.get()).toBe(null);

    transcriber.messages.set([
      { type: "transcript", text: "test one two", is_final: false },
      { type: "transcript", text: "test one two three", is_final: true },
      { type: "transcript", text: "another partial", is_final: false },
    ]);
    expect(transcriber.interimTranscript.get()).toBe("another partial");

    transcriber.messages.set([
      { type: "transcript", text: "test one two", is_final: false },
      { type: "transcript", text: "test one two three", is_final: true },
      { type: "transcript", text: "another partial", is_final: false },
      { type: "flush_confirmation", id: "flush-1" },
    ]);
    expect(transcriber.interimTranscript.get()).toBe(null);
  });
});

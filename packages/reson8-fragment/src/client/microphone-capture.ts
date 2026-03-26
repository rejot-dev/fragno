import { atom } from "nanostores";

export type Reson8MicrophonePermissionState =
  | "idle"
  | "requesting"
  | "granted"
  | "denied"
  | "error";

export interface Reson8MediaStreamTrackLike {
  stop(): void;
}

export interface Reson8MediaStreamLike {
  getTracks(): Reson8MediaStreamTrackLike[];
}

export interface Reson8AudioBufferLike {
  numberOfChannels: number;
  getChannelData(channel: number): Float32Array;
}

export interface Reson8AudioProcessingEventLike {
  inputBuffer: Reson8AudioBufferLike;
}

export interface Reson8ScriptProcessorNodeLike {
  onaudioprocess: ((event: Reson8AudioProcessingEventLike) => void) | null;
  connect(destination?: unknown): unknown;
  disconnect(): void;
}

export interface Reson8MediaStreamSourceLike {
  connect(node: unknown): unknown;
  disconnect(): void;
}

export interface Reson8AudioContextLike {
  sampleRate: number;
  destination?: unknown;
  createMediaStreamSource(stream: Reson8MediaStreamLike): Reson8MediaStreamSourceLike;
  createScriptProcessor(
    bufferSize: number,
    numberOfInputChannels: number,
    numberOfOutputChannels: number,
  ): Reson8ScriptProcessorNodeLike;
  close(): Promise<void> | void;
}

export type GetReson8UserMedia = (
  constraints: MediaStreamConstraints,
) => Promise<Reson8MediaStreamLike>;

export type CreateReson8AudioContext = () => Reson8AudioContextLike;

export type CreateReson8MicrophoneCaptureOptions = {
  getUserMedia?: GetReson8UserMedia;
  createAudioContext?: CreateReson8AudioContext;
};

export type StartReson8MicrophoneCaptureOptions = {
  onAudioChunk: (chunk: Uint8Array) => void;
  channels?: number;
  bufferSize?: number;
  constraints?: MediaTrackConstraints;
};

const DEFAULT_BUFFER_SIZE = 4096;
const DEFAULT_CHANNELS = 1;

const createDefaultGetUserMedia = (): GetReson8UserMedia => {
  const mediaDevices = globalThis.navigator?.mediaDevices;

  if (!mediaDevices?.getUserMedia) {
    throw new Error("Reson8 microphone capture requires navigator.mediaDevices.getUserMedia().");
  }

  return (constraints) => mediaDevices.getUserMedia(constraints) as Promise<Reson8MediaStreamLike>;
};

const createDefaultAudioContext = (): CreateReson8AudioContext => {
  const AudioContextCtor =
    globalThis.AudioContext ??
    (globalThis as typeof globalThis & { webkitAudioContext?: typeof AudioContext })
      .webkitAudioContext;

  if (!AudioContextCtor) {
    throw new Error("Reson8 microphone capture requires AudioContext support.");
  }

  return () => new AudioContextCtor() as unknown as Reson8AudioContextLike;
};

const buildAudioConstraints = (
  constraints: MediaTrackConstraints | undefined,
  channels: number,
): MediaTrackConstraints => ({
  channelCount: channels,
  autoGainControl: false,
  echoCancellation: false,
  noiseSuppression: false,
  ...constraints,
});

const clampToPcm16 = (value: number) => {
  const clamped = Math.max(-1, Math.min(1, value));
  return clamped < 0 ? Math.round(clamped * 0x8000) : Math.round(clamped * 0x7fff);
};

export const convertFloat32ToPcm16 = (
  inputBuffer: Reson8AudioBufferLike,
  channels: number,
): Uint8Array => {
  const frameCount = inputBuffer.getChannelData(0).length;
  const pcmBuffer = new ArrayBuffer(frameCount * channels * 2);
  const view = new DataView(pcmBuffer);

  const channelData = Array.from({ length: channels }, (_, index) => {
    const channelIndex = Math.min(index, Math.max(0, inputBuffer.numberOfChannels - 1));
    return inputBuffer.getChannelData(channelIndex);
  });

  let offset = 0;
  for (let frame = 0; frame < frameCount; frame += 1) {
    for (let channel = 0; channel < channels; channel += 1) {
      view.setInt16(offset, clampToPcm16(channelData[channel]?.[frame] ?? 0), true);
      offset += 2;
    }
  }

  return new Uint8Array(pcmBuffer);
};

export class Reson8MicrophoneCapture {
  readonly permissionState = atom<Reson8MicrophonePermissionState>("idle");
  readonly capturing = atom(false);
  readonly sampleRate = atom<number | null>(null);
  readonly channelCount = atom(DEFAULT_CHANNELS);
  readonly chunkCount = atom(0);
  readonly lastChunkByteLength = atom<number | null>(null);
  readonly error = atom<unknown>(null);

  #getUserMedia: GetReson8UserMedia;
  #createAudioContext: CreateReson8AudioContext;
  #stream: Reson8MediaStreamLike | null = null;
  #audioContext: Reson8AudioContextLike | null = null;
  #sourceNode: Reson8MediaStreamSourceLike | null = null;
  #processorNode: Reson8ScriptProcessorNodeLike | null = null;

  constructor(options: CreateReson8MicrophoneCaptureOptions = {}) {
    this.#getUserMedia = options.getUserMedia ?? createDefaultGetUserMedia();
    this.#createAudioContext = options.createAudioContext ?? createDefaultAudioContext();
  }

  async start(options: StartReson8MicrophoneCaptureOptions) {
    if (this.capturing.get()) {
      return {
        sampleRate: this.sampleRate.get() ?? 16_000,
        channels: this.channelCount.get(),
      };
    }

    const channels = options.channels ?? DEFAULT_CHANNELS;
    const bufferSize = options.bufferSize ?? DEFAULT_BUFFER_SIZE;

    this.permissionState.set("requesting");
    this.error.set(null);

    try {
      const stream = await this.#getUserMedia({
        audio: buildAudioConstraints(options.constraints, channels),
      });
      const audioContext = this.#createAudioContext();
      const sourceNode = audioContext.createMediaStreamSource(stream);
      const processorNode = audioContext.createScriptProcessor(bufferSize, channels, channels);

      processorNode.onaudioprocess = (event) => {
        const chunk = convertFloat32ToPcm16(event.inputBuffer, channels);
        this.chunkCount.set(this.chunkCount.get() + 1);
        this.lastChunkByteLength.set(chunk.byteLength);
        options.onAudioChunk(chunk);
      };

      sourceNode.connect(processorNode);
      processorNode.connect(audioContext.destination);

      this.#stream = stream;
      this.#audioContext = audioContext;
      this.#sourceNode = sourceNode;
      this.#processorNode = processorNode;

      this.permissionState.set("granted");
      this.sampleRate.set(audioContext.sampleRate);
      this.channelCount.set(channels);
      this.chunkCount.set(0);
      this.lastChunkByteLength.set(null);
      this.capturing.set(true);

      return {
        sampleRate: audioContext.sampleRate,
        channels,
      };
    } catch (error) {
      const name = error instanceof Error ? error.name : "Error";
      this.permissionState.set(name === "NotAllowedError" ? "denied" : "error");
      this.error.set(error);
      await this.stop();
      throw error;
    }
  }

  async stop() {
    this.#processorNode?.disconnect();
    if (this.#processorNode) {
      this.#processorNode.onaudioprocess = null;
    }
    this.#sourceNode?.disconnect();

    for (const track of this.#stream?.getTracks() ?? []) {
      track.stop();
    }

    await this.#audioContext?.close();

    this.#processorNode = null;
    this.#sourceNode = null;
    this.#stream = null;
    this.#audioContext = null;
    this.capturing.set(false);
  }

  clearError() {
    this.error.set(null);
    if (this.permissionState.get() === "error") {
      this.permissionState.set("idle");
    }
  }

  [Symbol.dispose]() {
    void this.stop();
  }
}

export const createReson8MicrophoneCapture = (options?: CreateReson8MicrophoneCaptureOptions) =>
  new Reson8MicrophoneCapture(options);

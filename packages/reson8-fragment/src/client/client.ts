import { createClientBuilder, type FragnoPublicClientConfig } from "@fragno-dev/core/client";

import { reson8FragmentDefinition } from "../definition";
import { reson8RoutesFactory } from "../routes";
import {
  createReson8AccessTokenStore,
  type CreateReson8AccessTokenStoreOptions,
  type Reson8AccessTokenStore,
} from "./access-token-store";
import {
  createReson8MicrophoneCapture,
  type CreateReson8AudioContext,
  type CreateReson8MicrophoneCaptureOptions,
  type GetReson8UserMedia,
  type Reson8AudioBufferLike,
  type Reson8AudioContextLike,
  type Reson8AudioProcessingEventLike,
  type Reson8MediaStreamLike,
  type Reson8MediaStreamSourceLike,
  type Reson8MediaStreamTrackLike,
  type Reson8MicrophoneCapture,
  type Reson8MicrophonePermissionState,
  type Reson8ScriptProcessorNodeLike,
  type StartReson8MicrophoneCaptureOptions,
} from "./microphone-capture";
import {
  buildReson8RealtimeUrl,
  createReson8RealtimeSessionStore,
  type CreateReson8RealtimeSessionStoreArgs,
  type CreateReson8WebSocket,
  type Reson8RealtimeCloseEvent,
  type Reson8RealtimeConnectionState,
  type Reson8RealtimeFlushConfirmation,
  type Reson8RealtimeFlushRequest,
  type Reson8RealtimeQuery,
  type Reson8RealtimeServerMessage,
  type Reson8RealtimeSessionError,
  type Reson8RealtimeTranscript,
  type Reson8RealtimeUnknownMessage,
  type Reson8RealtimeSessionStore,
} from "./realtime-session";
import {
  createReson8RealtimeTranscriberStore,
  type CreateReson8RealtimeTranscriberArgs,
  type CreateReson8RealtimeTranscriberOptions,
  type Reson8RealtimeTranscriberStore,
} from "./realtime-transcriber";

const routes = [reson8RoutesFactory] as const;

export type Reson8FragmentClientConfig = FragnoPublicClientConfig & {
  realtimeBaseUrl?: string;
  tokenRefreshBufferMs?: number;
  now?: () => number;
  createWebSocket?: CreateReson8WebSocket;
  getUserMedia?: GetReson8UserMedia;
  createAudioContext?: CreateReson8AudioContext;
};

export function createReson8FragmentClients(config: Reson8FragmentClientConfig = {}) {
  const builder = createClientBuilder(reson8FragmentDefinition, config, routes);
  const useRequestToken = builder.createMutator("POST", "/auth/token");
  const accessTokenStore = createReson8AccessTokenStore({
    requestToken: async () => {
      const token = await useRequestToken.mutateQuery({});

      if (!token) {
        throw new Error("Reson8 token request did not return a token.");
      }

      return token;
    },
    now: config.now,
    refreshBufferMs: config.tokenRefreshBufferMs,
  } satisfies CreateReson8AccessTokenStoreOptions);

  return {
    useRequestToken,
    useAccessToken: builder.createStore(accessTokenStore),
    useCustomModels: builder.createHook("/custom-model"),
    useCustomModel: builder.createHook("/custom-model/:id"),
    useCreateCustomModel: builder.createMutator("POST", "/custom-model"),
    usePrerecordedTranscription: builder.createMutator("POST", "/speech-to-text/prerecorded"),
    useMicrophoneCapture: builder.createStore(() =>
      createReson8MicrophoneCapture({
        getUserMedia: config.getUserMedia,
        createAudioContext: config.createAudioContext,
      } satisfies CreateReson8MicrophoneCaptureOptions),
    ),
    useRealtimeSession: builder.createStore((args: CreateReson8RealtimeSessionStoreArgs = {}) =>
      createReson8RealtimeSessionStore({
        query: args.query,
        autoConnect: args.autoConnect,
        ensureToken: (options) => accessTokenStore.ensureToken(options),
        createWebSocket: config.createWebSocket,
        realtimeBaseUrl: config.realtimeBaseUrl,
      }),
    ),
    useRealtimeTranscriber: builder.createStore((args: CreateReson8RealtimeTranscriberArgs = {}) =>
      createReson8RealtimeTranscriberStore({
        args,
        accessTokenStore,
        createWebSocket: config.createWebSocket,
        realtimeBaseUrl: config.realtimeBaseUrl,
        getUserMedia: config.getUserMedia,
        createAudioContext: config.createAudioContext,
      } satisfies CreateReson8RealtimeTranscriberOptions),
    ),
  };
}

export {
  buildReson8RealtimeUrl,
  createReson8AccessTokenStore,
  createReson8MicrophoneCapture,
  createReson8RealtimeSessionStore,
  createReson8RealtimeTranscriberStore,
};
export type {
  CreateReson8AccessTokenStoreOptions,
  CreateReson8AudioContext,
  CreateReson8MicrophoneCaptureOptions,
  CreateReson8RealtimeSessionStoreArgs,
  CreateReson8RealtimeTranscriberArgs,
  CreateReson8RealtimeTranscriberOptions,
  CreateReson8WebSocket,
  GetReson8UserMedia,
  Reson8AccessTokenStore,
  Reson8AudioBufferLike,
  Reson8AudioContextLike,
  Reson8AudioProcessingEventLike,
  Reson8MediaStreamLike,
  Reson8MediaStreamSourceLike,
  Reson8MediaStreamTrackLike,
  Reson8MicrophoneCapture,
  Reson8MicrophonePermissionState,
  Reson8RealtimeCloseEvent,
  Reson8RealtimeConnectionState,
  Reson8RealtimeFlushConfirmation,
  Reson8RealtimeFlushRequest,
  Reson8RealtimeQuery,
  Reson8RealtimeServerMessage,
  Reson8RealtimeSessionError,
  Reson8RealtimeSessionStore,
  Reson8RealtimeTranscript,
  Reson8RealtimeTranscriberStore,
  Reson8RealtimeUnknownMessage,
  Reson8ScriptProcessorNodeLike,
  StartReson8MicrophoneCaptureOptions,
};

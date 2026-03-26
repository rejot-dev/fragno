import { instantiate, type FragnoPublicConfig } from "@fragno-dev/core";

import { reson8FragmentDefinition, type Reson8FragmentConfig } from "./definition";
import { reson8RoutesFactory } from "./routes";

const routes = [reson8RoutesFactory] as const;

export function createReson8Fragment(
  config: Reson8FragmentConfig = {},
  options: FragnoPublicConfig = {},
) {
  return instantiate(reson8FragmentDefinition)
    .withConfig(config)
    .withRoutes(routes)
    .withOptions(options)
    .build();
}

export {
  buildReson8RealtimeUrl,
  createReson8AccessTokenStore,
  createReson8FragmentClients,
  createReson8MicrophoneCapture,
  createReson8RealtimeSessionStore,
  createReson8RealtimeTranscriberStore,
} from "./client/client";
export { reson8FragmentDefinition } from "./definition";
export { reson8RoutesFactory } from "./routes";
export type { Reson8FragmentConfig } from "./definition";
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
  Reson8FragmentClientConfig,
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
} from "./client/client";
export type {
  Reson8AuthToken,
  Reson8BinaryBody,
  Reson8CreateCustomModelInput,
  Reson8CustomModel,
  Reson8Error,
  Reson8ListCustomModelsOutput,
  Reson8PrerecordedQuery,
  Reson8PrerecordedTranscription,
  Reson8PrerecordedWord,
} from "./routes";
export type { FragnoRouteConfig } from "@fragno-dev/core";

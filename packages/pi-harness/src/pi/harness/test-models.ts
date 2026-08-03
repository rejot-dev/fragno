import { lazyStream } from "@earendil-works/pi-ai/api/lazy";

import type { StreamFn } from "@earendil-works/pi-agent-core";
import {
  createModels,
  createProvider,
  type Api,
  type Model,
  type Models,
  type ProviderStreams,
} from "@earendil-works/pi-ai";

const injectedTestStreamAuth = {
  apiKey: {
    name: "Injected test stream",
    resolve: async () => ({ auth: {}, source: "Injected test stream" }),
  },
};

/** Adapt exact event-stream test doubles to Pi's explicit provider collection. */
export const createModelsForStreamFn = (
  modelOrModels: Model<Api> | readonly Model<Api>[],
  streamFn: StreamFn,
): Models => {
  const configuredModels = "id" in modelOrModels ? [modelOrModels] : [...modelOrModels];
  const model = configuredModels[0];
  if (!model) {
    throw new Error("TEST_MODELS_REQUIRED");
  }
  if (configuredModels.some((configuredModel) => configuredModel.provider !== model.provider)) {
    throw new Error("TEST_MODELS_MUST_SHARE_PROVIDER");
  }

  const api: ProviderStreams = {
    stream: (requestModel, context, options) =>
      lazyStream(requestModel, async () => streamFn(requestModel, context, options)),
    streamSimple: (requestModel, context, options) =>
      lazyStream(requestModel, async () => streamFn(requestModel, context, options)),
  };
  const models = createModels();
  models.setProvider(
    createProvider({
      id: model.provider,
      name: model.provider,
      auth: injectedTestStreamAuth,
      models: configuredModels,
      api,
    }),
  );
  return models;
};

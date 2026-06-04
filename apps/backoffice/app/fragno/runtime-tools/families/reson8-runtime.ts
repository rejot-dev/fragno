import { createRouteCaller } from "@fragno-dev/core/api";

import type {
  Reson8PrerecordedQuery,
  Reson8PrerecordedTranscription,
} from "@fragno-dev/reson8-fragment";

import type { Reson8Fragment } from "@/fragno/reson8";

import {
  NotConfiguredError,
  createOrganisationNotConfiguredMessage,
  isSuccessStatus,
  throwOnRouteRuntimeError,
} from "../runtime-errors";

export type Reson8PrerecordedTranscribeArgs = {
  inputPath: string;
  encoding?: Reson8PrerecordedQuery["encoding"];
  sampleRate?: number;
  channels?: number;
  customModelId?: string;
  includeTimestamps?: boolean;
  includeWords?: boolean;
  includeConfidence?: boolean;
};

export type Reson8Runtime = {
  transcribePrerecorded: (args: {
    audio: ArrayBuffer | ArrayBufferView | Blob | ReadableStream<Uint8Array>;
    query?: Record<string, string>;
  }) => Promise<Reson8PrerecordedTranscription>;
};

export type RegisteredReson8CommandContext = {
  runtime: Reson8Runtime;
};

type CreateRouteBackedReson8RuntimeOptions = {
  baseUrl: string;
  headers?: HeadersInit;
  fetch(request: Request): Promise<Response>;
};

const createReson8RouteCaller = (options: CreateRouteBackedReson8RuntimeOptions) => {
  return createRouteCaller<Reson8Fragment>({
    baseUrl: options.baseUrl,
    mountRoute: "/api/reson8",
    ...(options.headers ? { baseHeaders: options.headers } : {}),
    fetch: options.fetch,
  });
};

export const createRouteBackedReson8Runtime = (
  options: CreateRouteBackedReson8RuntimeOptions,
): Reson8Runtime => {
  const baseUrl = options.baseUrl.trim();
  if (!baseUrl) {
    throw new Error("Reson8 runtime requires a base URL");
  }

  const callRoute = createReson8RouteCaller({
    ...options,
    baseUrl,
  });

  return {
    transcribePrerecorded: async ({ audio, query }) => {
      const response = await callRoute("POST", "/speech-to-text/prerecorded", {
        body: audio,
        query,
        headers: {
          "content-type": "application/octet-stream",
        },
      });

      if (response.type === "json" && isSuccessStatus(response.status)) {
        return response.data as Reson8PrerecordedTranscription;
      }

      return throwOnRouteRuntimeError(response, {
        runtimeLabel: "Reson8 fragment",
        label: "reson8.prerecorded.transcribe",
        notConfiguredMessage: RESON8_NOT_CONFIGURED,
      });
    },
  };
};

export const createReson8RouteRuntime = ({
  env,
  orgId,
}: {
  env: CloudflareEnv;
  orgId: string;
}): Reson8Runtime => {
  const reson8Do = env.RESON8.get(env.RESON8.idFromName(orgId));
  return createRouteBackedReson8Runtime({
    baseUrl: "https://reson8.do",
    fetch: reson8Do.fetch.bind(reson8Do),
  });
};

const RESON8_NOT_CONFIGURED = createOrganisationNotConfiguredMessage("Reson8");

export const createUnavailableReson8Runtime = (message = RESON8_NOT_CONFIGURED): Reson8Runtime => ({
  transcribePrerecorded: async () => {
    throw new Error(message);
  },
});

export { NotConfiguredError };

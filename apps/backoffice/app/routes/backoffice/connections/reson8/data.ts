import { createRouteCaller } from "@fragno-dev/core/api";
import type { RouterContextProvider } from "react-router";
import type { Reson8RealtimeOriginDiagnostic } from "workers/reson8.do";

import type {
  Reson8CreateCustomModelInput,
  Reson8CustomModel,
  Reson8PrerecordedTranscription,
} from "@fragno-dev/reson8-fragment";

import { getReson8DurableObject } from "@/cloudflare/cloudflare-utils";
import type { Reson8Fragment } from "@/fragno/reson8";

import type { Reson8ConfigState } from "./shared";

const createReson8RouteCaller = (
  request: Request,
  context: Readonly<RouterContextProvider>,
  orgId: string,
) => {
  const reson8Do = getReson8DurableObject(context, orgId);
  return createRouteCaller<Reson8Fragment>({
    baseUrl: request.url,
    mountRoute: "/api/reson8",
    baseHeaders: request.headers,
    fetch: reson8Do.fetch.bind(reson8Do),
  });
};

type Reson8ConfigResult = {
  configState: Reson8ConfigState | null;
  configError: string | null;
};

type Reson8CustomModelsResult = {
  models: Reson8CustomModel[];
  modelsError: string | null;
};

type Reson8CreateCustomModelResult = {
  model: Reson8CustomModel | null;
  error: string | null;
};

type Reson8PrerecordedResult = {
  transcription: Reson8PrerecordedTranscription | null;
  error: string | null;
};

type Reson8RealtimeOriginDiagnosticResult = {
  diagnostic: Reson8RealtimeOriginDiagnostic | null;
  diagnosticError: string | null;
};

export async function fetchReson8Config(
  context: Readonly<RouterContextProvider>,
  orgId: string,
): Promise<Reson8ConfigResult> {
  try {
    const reson8Do = getReson8DurableObject(context, orgId);
    const configState = await reson8Do.getAdminConfig();
    return { configState, configError: null };
  } catch (error) {
    return {
      configState: null,
      configError: error instanceof Error ? error.message : "Failed to load configuration.",
    };
  }
}

export async function fetchReson8CustomModels(
  request: Request,
  context: Readonly<RouterContextProvider>,
  orgId: string,
): Promise<Reson8CustomModelsResult> {
  try {
    const callRoute = createReson8RouteCaller(request, context, orgId);
    const response = await callRoute("GET", "/custom-model");

    if (response.type === "json") {
      return {
        models: response.data as Reson8CustomModel[],
        modelsError: null,
      };
    }

    if (response.type === "error") {
      return {
        models: [],
        modelsError: response.error.message,
      };
    }

    return {
      models: [],
      modelsError: `Failed to fetch custom models (${response.status}).`,
    };
  } catch (error) {
    return {
      models: [],
      modelsError: error instanceof Error ? error.message : "Failed to load custom models.",
    };
  }
}

export async function createReson8CustomModel(
  request: Request,
  context: Readonly<RouterContextProvider>,
  orgId: string,
  payload: Reson8CreateCustomModelInput,
): Promise<Reson8CreateCustomModelResult> {
  try {
    const callRoute = createReson8RouteCaller(request, context, orgId);
    const response = await callRoute("POST", "/custom-model", {
      body: payload,
    });

    if (response.type === "json") {
      return {
        model: response.data as Reson8CustomModel,
        error: null,
      };
    }

    if (response.type === "error") {
      return {
        model: null,
        error: response.error.message,
      };
    }

    return {
      model: null,
      error: `Failed to create custom model (${response.status}).`,
    };
  } catch (error) {
    return {
      model: null,
      error: error instanceof Error ? error.message : "Failed to create custom model.",
    };
  }
}

export async function fetchReson8RealtimeOriginDiagnostic(
  context: Readonly<RouterContextProvider>,
  orgId: string,
  origin: string,
): Promise<Reson8RealtimeOriginDiagnosticResult> {
  try {
    const reson8Do = getReson8DurableObject(context, orgId);
    const diagnostic = await reson8Do.getRealtimeOriginDiagnostic(origin);
    return { diagnostic, diagnosticError: null };
  } catch (error) {
    return {
      diagnostic: null,
      diagnosticError:
        error instanceof Error ? error.message : "Failed to run realtime origin diagnostic.",
    };
  }
}

export async function transcribeReson8Prerecorded(
  request: Request,
  context: Readonly<RouterContextProvider>,
  orgId: string,
  input: {
    body: ArrayBuffer | ArrayBufferView | Blob | ReadableStream<Uint8Array>;
    query?: Record<string, string>;
  },
): Promise<Reson8PrerecordedResult> {
  try {
    const callRoute = createReson8RouteCaller(request, context, orgId);
    const response = await callRoute("POST", "/speech-to-text/prerecorded", {
      body: input.body,
      query: input.query,
      headers: {
        "content-type": "application/octet-stream",
      },
    });

    if (response.type === "json") {
      return {
        transcription: response.data as Reson8PrerecordedTranscription,
        error: null,
      };
    }

    if (response.type === "error") {
      return {
        transcription: null,
        error: response.error.message,
      };
    }

    return {
      transcription: null,
      error: `Failed to transcribe audio (${response.status}).`,
    };
  } catch (error) {
    return {
      transcription: null,
      error: error instanceof Error ? error.message : "Failed to transcribe audio.",
    };
  }
}

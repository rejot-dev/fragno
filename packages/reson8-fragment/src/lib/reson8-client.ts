import type { Reson8FragmentConfig } from "../definition";
import type { Reson8AuthToken } from "../routes/auth";
import type {
  Reson8CreateCustomModelInput,
  Reson8CustomModel,
  Reson8ListCustomModelsOutput,
} from "../routes/custom-models";
import type { Reson8PrerecordedQuery, Reson8PrerecordedTranscription } from "../routes/prerecorded";

export interface Reson8ErrorResponse<TCode extends string = string> {
  message: string;
  code: TCode;
}

export type Reson8QueryValue = string | number | boolean | null | undefined;

export type Reson8UpstreamResult<
  TData,
  TErrorCode extends string,
  TErrorStatus extends number,
  TSuccessStatus extends number,
> =
  | {
      ok: true;
      status: TSuccessStatus;
      data: TData;
      headers: Headers;
    }
  | {
      ok: false;
      status: TErrorStatus;
      error: Reson8ErrorResponse<TErrorCode>;
      headers: Headers;
    };

interface Reson8RequestOptions {
  method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  path: string;
  authorization: string;
  query?: Record<string, Reson8QueryValue>;
  body?: BodyInit | ReadableStream<Uint8Array>;
  contentType?: string;
}

export interface Reson8Client {
  requestToken(input: {
    authorization: string;
  }): Promise<
    Reson8UpstreamResult<Reson8AuthToken, "UNAUTHORIZED" | "INTERNAL_ERROR", 401 | 500 | 502, 200>
  >;
  listCustomModels(input: {
    authorization: string;
  }): Promise<
    Reson8UpstreamResult<
      Reson8ListCustomModelsOutput,
      "UNAUTHORIZED" | "INTERNAL_ERROR",
      401 | 500 | 502,
      200
    >
  >;
  getCustomModel(input: {
    authorization: string;
    id: string;
  }): Promise<
    Reson8UpstreamResult<
      Reson8CustomModel,
      "UNAUTHORIZED" | "NOT_FOUND" | "INTERNAL_ERROR",
      401 | 404 | 500 | 502,
      200
    >
  >;
  createCustomModel(input: {
    authorization: string;
    body: Reson8CreateCustomModelInput;
  }): Promise<
    Reson8UpstreamResult<
      Reson8CustomModel,
      "INVALID_REQUEST" | "UNAUTHORIZED" | "INTERNAL_ERROR",
      400 | 401 | 500 | 502,
      201
    >
  >;
  transcribePrerecorded(input: {
    authorization: string;
    query?: Reson8PrerecordedQuery;
    body: ReadableStream<Uint8Array>;
  }): Promise<
    Reson8UpstreamResult<
      Reson8PrerecordedTranscription,
      "INVALID_REQUEST" | "UNAUTHORIZED" | "PAYLOAD_TOO_LARGE" | "INTERNAL_ERROR",
      400 | 401 | 413 | 500 | 502,
      200
    >
  >;
}

const DEFAULT_RESON8_BASE_URL = "https://api.reson8.dev/v1";

const defaultErrorCodeForStatus = (status: number) => {
  switch (status) {
    case 400:
      return "INVALID_REQUEST";
    case 401:
      return "UNAUTHORIZED";
    case 404:
      return "NOT_FOUND";
    case 413:
      return "PAYLOAD_TOO_LARGE";
    default:
      return "INTERNAL_ERROR";
  }
};

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const normalizeErrorResponse = <TCode extends string>(
  status: number,
  payload: unknown,
): Reson8ErrorResponse<TCode> => {
  if (isObject(payload)) {
    const code =
      typeof payload["code"] === "string" ? payload["code"] : defaultErrorCodeForStatus(status);
    const message =
      typeof payload["message"] === "string"
        ? payload["message"]
        : `Reson8 upstream request failed with status ${status}.`;

    return { code: code as TCode, message };
  }

  if (typeof payload === "string" && payload.trim().length > 0) {
    return {
      code: defaultErrorCodeForStatus(status) as TCode,
      message: payload,
    };
  }

  return {
    code: defaultErrorCodeForStatus(status) as TCode,
    message: `Reson8 upstream request failed with status ${status}.`,
  };
};

const readResponsePayload = async (response: Response): Promise<unknown> => {
  const text = await response.text();

  if (text.length === 0) {
    return null;
  }

  try {
    return JSON.parse(text) as unknown;
  } catch {
    return text;
  }
};

const buildUrl = (baseUrl: string, path: string, query?: Record<string, Reson8QueryValue>) => {
  const url = new URL(path.replace(/^\//, ""), baseUrl.endsWith("/") ? baseUrl : `${baseUrl}/`);

  for (const [key, value] of Object.entries(query ?? {})) {
    if (value === undefined || value === null) {
      continue;
    }

    url.searchParams.set(key, String(value));
  }

  return url.toString();
};

export const createReson8Client = (config: Reson8FragmentConfig): Reson8Client => {
  const baseUrl = config.baseUrl ?? DEFAULT_RESON8_BASE_URL;
  const fetcher = config.fetch ?? globalThis.fetch?.bind(globalThis);

  if (!fetcher) {
    throw new Error("Reson8 fragment requires a fetch implementation.");
  }

  const requestJson = async <
    TData,
    TErrorCode extends string,
    TErrorStatus extends number,
    TSuccessStatus extends number,
  >(
    options: Reson8RequestOptions,
  ): Promise<Reson8UpstreamResult<TData, TErrorCode, TErrorStatus, TSuccessStatus>> => {
    const { method, path, authorization, query, body, contentType } = options;

    const headers = new Headers({ Accept: "application/json" });
    headers.set("Authorization", authorization);

    if (contentType) {
      headers.set("Content-Type", contentType);
    }

    const requestInit: RequestInit & { duplex?: "half" } = {
      method,
      headers,
      body,
    };

    if (body instanceof ReadableStream) {
      requestInit.duplex = "half";
    }

    let response: Response;
    try {
      response = await fetcher(buildUrl(baseUrl, path, query), requestInit);
    } catch (error) {
      return {
        ok: false,
        status: 502 as TErrorStatus,
        headers: new Headers(),
        error: {
          code: "INTERNAL_ERROR" as TErrorCode,
          message: error instanceof Error ? error.message : String(error),
        },
      };
    }

    const payload = await readResponsePayload(response);

    if (!response.ok) {
      return {
        ok: false,
        status: response.status as TErrorStatus,
        headers: response.headers,
        error: normalizeErrorResponse<TErrorCode>(response.status, payload),
      };
    }

    if (payload === null || typeof payload === "string") {
      return {
        ok: false,
        status: 502 as TErrorStatus,
        headers: response.headers,
        error: {
          code: "INTERNAL_ERROR" as TErrorCode,
          message: "Reson8 returned a non-JSON success payload.",
        },
      };
    }

    return {
      ok: true,
      status: response.status as TSuccessStatus,
      headers: response.headers,
      data: payload as TData,
    };
  };

  return {
    requestToken({ authorization }) {
      return requestJson<Reson8AuthToken, "UNAUTHORIZED" | "INTERNAL_ERROR", 401 | 500 | 502, 200>({
        method: "POST",
        path: "/auth/token",
        authorization,
      });
    },
    listCustomModels({ authorization }) {
      return requestJson<
        Reson8ListCustomModelsOutput,
        "UNAUTHORIZED" | "INTERNAL_ERROR",
        401 | 500 | 502,
        200
      >({
        method: "GET",
        path: "/custom-model",
        authorization,
      });
    },
    getCustomModel({ authorization, id }) {
      return requestJson<
        Reson8CustomModel,
        "UNAUTHORIZED" | "NOT_FOUND" | "INTERNAL_ERROR",
        401 | 404 | 500 | 502,
        200
      >({
        method: "GET",
        path: `/custom-model/${id}`,
        authorization,
      });
    },
    createCustomModel({ authorization, body }) {
      return requestJson<
        Reson8CustomModel,
        "INVALID_REQUEST" | "UNAUTHORIZED" | "INTERNAL_ERROR",
        400 | 401 | 500 | 502,
        201
      >({
        method: "POST",
        path: "/custom-model",
        authorization,
        contentType: "application/json",
        body: JSON.stringify(body),
      });
    },
    transcribePrerecorded({ authorization, query, body }) {
      return requestJson<
        Reson8PrerecordedTranscription,
        "INVALID_REQUEST" | "UNAUTHORIZED" | "PAYLOAD_TOO_LARGE" | "INTERNAL_ERROR",
        400 | 401 | 413 | 500 | 502,
        200
      >({
        method: "POST",
        path: "/speech-to-text/prerecorded",
        authorization,
        query,
        contentType: "application/octet-stream",
        body,
      });
    },
  };
};

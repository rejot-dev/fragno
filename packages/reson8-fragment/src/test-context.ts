import { vi } from "vitest";

import { createFragmentForTest } from "@fragno-dev/core/test";

import { reson8FragmentDefinition, type Reson8FragmentConfig } from "./definition";
import { reson8RoutesFactory } from "./routes";

export const createJsonResponse = (body: unknown, init: ResponseInit = {}) =>
  new Response(JSON.stringify(body), {
    ...init,
    headers: {
      "content-type": "application/json",
      ...init.headers,
    },
  });

export const readRequestBody = async (init?: RequestInit) => {
  const body = init?.body;

  if (!body) {
    return new Uint8Array();
  }

  return new Uint8Array(await new Response(body as BodyInit).arrayBuffer());
};

export const readRequestText = async (init?: RequestInit) =>
  new TextDecoder().decode(await readRequestBody(init));

export const createBinaryStream = (chunks: Uint8Array[]) =>
  new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) {
        controller.enqueue(chunk);
      }
      controller.close();
    },
  });

export const createReson8TestContext = (configOverrides: Partial<Reson8FragmentConfig> = {}) => {
  const fetchMock = vi.fn<typeof fetch>();
  const config: Reson8FragmentConfig = {
    apiKey: "test-api-key",
    fetch: fetchMock as typeof fetch,
    ...configOverrides,
  };

  const fragment = createFragmentForTest(reson8FragmentDefinition, [reson8RoutesFactory], {
    config,
  });

  return {
    config,
    fetchMock,
    fragment,
    reset() {
      fetchMock.mockReset();
    },
  };
};

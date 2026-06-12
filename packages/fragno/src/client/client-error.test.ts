import { test, expect, describe, assert } from "vitest";

import { FragnoApiError } from "../api/error";
import { RequestOutputContext } from "../api/request-output-context";
import { FragnoClientApiError, FragnoClientUnknownApiError } from "./client-error";

describe("Error Conversion", () => {
  test("should convert API error to client error", async () => {
    const apiError = new FragnoApiError({ message: "API error", code: "API_ERROR" }, 500);
    const apiResponse = apiError.toResponse();
    const clientError = await FragnoClientApiError.fromResponse(apiResponse);
    expect(clientError).toBeInstanceOf(FragnoClientApiError);
    assert(clientError.message === "API error");
    assert(clientError.code === "API_ERROR");
    assert(clientError.status === 500);
  });

  test("error() should never result in an unknown error", async () => {
    const ctx = new RequestOutputContext();
    const response = ctx.error({ message: "test", code: "MY_TEST_ERROR" }, { status: 400 });

    expect(response).toBeInstanceOf(Response);
    assert(response.status === 400);

    const clientError = await FragnoClientApiError.fromResponse(response);
    expect(clientError).toBeInstanceOf(FragnoClientApiError);
    expect(clientError).not.toBeInstanceOf(FragnoClientUnknownApiError);
    assert(clientError.message === "test");
    assert(clientError.code === "MY_TEST_ERROR");
    assert(clientError.status === 400);
  });
});

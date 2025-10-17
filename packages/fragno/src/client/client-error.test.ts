import { test, expect, describe } from "vitest";
import { FragnoClientApiError, FragnoClientUnknownApiError } from "./client-error";
import { FragnoApiError } from "../api/error";
import { RequestOutputContext } from "../api/request-output-context";

describe("Error Conversion", () => {
  test("should convert API error to client error", async () => {
    const apiError = new FragnoApiError({ message: "API error", code: "API_ERROR" }, 500);
    const apiResponse = apiError.toResponse();
    const clientError = await FragnoClientApiError.fromResponse(apiResponse);
    expect(clientError).toBeInstanceOf(FragnoClientApiError);
    expect(clientError.message).toBe("API error");
    expect(clientError.code).toBe("API_ERROR");
    expect(clientError.status).toBe(500);
  });

  test("error() should never result in an unknown error", async () => {
    const ctx = new RequestOutputContext();
    const response = ctx.error({ message: "test", code: "MY_TEST_ERROR" }, { status: 400 });

    expect(response).toBeInstanceOf(Response);
    expect(response.status).toBe(400);

    const clientError = await FragnoClientApiError.fromResponse(response);
    expect(clientError).toBeInstanceOf(FragnoClientApiError);
    expect(clientError).not.toBeInstanceOf(FragnoClientUnknownApiError);
    expect(clientError.message).toBe("test");
    expect(clientError.code).toBe("MY_TEST_ERROR");
    expect(clientError.status).toBe(400);
  });
});

import { test, expect, describe } from "vitest";
import { FragnoClientApiError } from "./client-error";
import { FragnoApiError } from "../api/error";

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
});

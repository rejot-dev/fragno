import { assert, beforeEach, describe, expect, test, vi } from "vitest";

const { marketplaceFetchMock, getMarketplaceDurableObjectMock } = vi.hoisted(() => ({
  marketplaceFetchMock: vi.fn(),
  getMarketplaceDurableObjectMock: vi.fn(),
}));

vi.mock("@/worker-runtime/durable-objects", () => ({
  getMarketplaceDurableObject: getMarketplaceDurableObjectMock,
}));

import { loader } from "./marketplace";

const context = {} as never;

beforeEach(() => {
  marketplaceFetchMock.mockReset();
  getMarketplaceDurableObjectMock.mockReset();
  marketplaceFetchMock.mockResolvedValue(Response.json({ listings: [] }));
  getMarketplaceDurableObjectMock.mockReturnValue({ http: { fetch: marketplaceFetchMock } });
});

describe("Marketplace API proxy", () => {
  test("forwards public metadata requests to the singleton object", async () => {
    const request = new Request(
      "https://example.test/api/marketplace/listings?category=operations",
    );

    const response = await loader({ request, context } as never);

    assert(response.status === 200);
    expect(marketplaceFetchMock).toHaveBeenCalledWith(request);
  });
});

import { afterAll, beforeEach, describe, expect, test } from "vitest";

import { createResendTestContext, domainsGetMock, domainsListMock } from "./test-context";

describe("resend-fragment domains", async () => {
  const ctx = await createResendTestContext();
  const { callRoute } = ctx;

  beforeEach(async () => {
    await ctx.reset();
  });

  afterAll(async () => {
    await ctx.cleanup();
  });

  test("lists configured domains", async () => {
    domainsListMock.mockResolvedValue({
      data: {
        object: "list",
        has_more: false,
        data: [
          {
            id: "domain_123",
            name: "example.com",
            status: "verified",
            created_at: "2026-03-18T10:00:00.000Z",
            region: "us-east-1",
            capabilities: {
              sending: "enabled",
              receiving: "disabled",
            },
          },
        ],
      },
      error: null,
      headers: null,
    });

    const response = await callRoute("GET", "/domains");

    expect(domainsListMock).toHaveBeenCalledWith({ limit: 100 });
    expect(response.type).toBe("json");
    if (response.type !== "json") {
      return;
    }

    expect(response.data).toEqual({
      domains: [
        {
          id: "domain_123",
          name: "example.com",
          status: "verified",
          createdAt: "2026-03-18T10:00:00.000Z",
          region: "us-east-1",
          capabilities: {
            sending: "enabled",
            receiving: "disabled",
          },
        },
      ],
      hasMore: false,
    });
  });

  test("fetches configured domain detail", async () => {
    domainsGetMock.mockResolvedValue({
      data: {
        object: "domain",
        id: "domain_123",
        name: "example.com",
        status: "verified",
        created_at: "2026-03-18T10:00:00.000Z",
        region: "us-east-1",
        capabilities: {
          sending: "enabled",
          receiving: "enabled",
        },
        records: [
          {
            record: "Receiving",
            name: "inbound",
            value: "inbound-smtp.us-east-1.amazonaws.com",
            type: "MX",
            ttl: "Auto",
            status: "verified",
            priority: 10,
          },
        ],
      },
      error: null,
      headers: null,
    });

    const response = await callRoute("GET", "/domains/:domainId", {
      pathParams: { domainId: "domain_123" },
    });

    expect(domainsGetMock).toHaveBeenCalledWith("domain_123");
    expect(response.type).toBe("json");
    if (response.type !== "json") {
      return;
    }

    expect(response.data).toEqual({
      id: "domain_123",
      name: "example.com",
      status: "verified",
      createdAt: "2026-03-18T10:00:00.000Z",
      region: "us-east-1",
      capabilities: {
        sending: "enabled",
        receiving: "enabled",
      },
      records: [
        {
          record: "Receiving",
          name: "inbound",
          value: "inbound-smtp.us-east-1.amazonaws.com",
          type: "MX",
          ttl: "Auto",
          status: "verified",
          priority: 10,
        },
      ],
    });
  });
});

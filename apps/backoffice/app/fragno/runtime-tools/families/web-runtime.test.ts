import { describe, expect, test, assert } from "vitest";

import type { CloudflareObject } from "@/backoffice-runtime/object-registry";

import { NotConfiguredError } from "../runtime-errors";
import { createWebRuntime } from "./web-runtime";

describe("createWebRuntime", () => {
  test("calls the Browser Run extract route", async () => {
    let request: Request | undefined;
    const object: CloudflareObject = {
      fetch: async (nextRequest) => {
        request = nextRequest;
        return Response.json({ action: "markdown", result: "Example" });
      },
    };
    const runtime = createWebRuntime({ object });

    await expect(
      runtime.extract({
        action: "markdown",
        input: { url: "https://example.com" },
      }),
    ).resolves.toEqual({ action: "markdown", result: "Example" });
    assert(request?.url === "https://cloudflare.do/api/cloudflare/browser-run/extract");
  });

  test("classifies missing configuration as NotConfiguredError", async () => {
    const object: CloudflareObject = {
      fetch: async () =>
        Response.json(
          {
            code: "NOT_CONFIGURED",
            message: "Cloudflare credentials are missing.",
          },
          { status: 400 },
        ),
    };
    const runtime = createWebRuntime({ object });

    await expect(
      runtime.extract({
        action: "content",
        input: { url: "https://example.com" },
      }),
    ).rejects.toBeInstanceOf(NotConfiguredError);
  });
});

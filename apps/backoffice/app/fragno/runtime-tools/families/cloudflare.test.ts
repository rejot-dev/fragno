import { assert, describe, expect, test, vi } from "vitest";

import { InMemoryFs } from "just-bash";

import { createBashHost } from "../bash-host";
import { EMPTY_BASH_HOST_CONTEXT } from "../bash-host.test-utils";
import {
  createTrustedSystemBackofficeToolContext,
  type BackofficeToolContext,
} from "../runtime-tools";
import { cloudflareRuntimeTools, type CloudflareRuntime } from "./cloudflare";

const createRuntime = (overrides: Partial<CloudflareRuntime> = {}): CloudflareRuntime => ({
  browserRunExtract: vi.fn(async () => ({
    action: "content" as const,
    result: "<html>example</html>",
  })),
  browserRunCapture: vi.fn(
    async () =>
      new Response(new Uint8Array([0, 255, 1, 2]), {
        headers: { "content-type": "image/png" },
      }),
  ),
  browserRunCrawl: vi.fn(async () => ({
    action: "start" as const,
    result: { jobId: "crawl-123" },
  })),
  ...overrides,
});

describe("cloudflare runtime tools", () => {
  test("exposes extract, capture, and crawl tools", () => {
    expect(cloudflareRuntimeTools.map((tool) => tool.name)).toEqual([
      "browserRunExtract",
      "browserRunCapture",
      "browserRunCrawl",
    ]);
    expect(cloudflareRuntimeTools.map((tool) => tool.adapters?.bash?.command)).toEqual([
      "cloudflare.browser-run.extract",
      "cloudflare.browser-run.capture",
      "cloudflare.browser-run.crawl",
    ]);
  });

  test("parses extract, capture, and crawl actions", () => {
    expect(
      cloudflareRuntimeTools[0].adapters!.bash!.parse([
        "--action",
        "markdown",
        "--input-json",
        '{"url":"https://example.com"}',
      ]),
    ).toEqual({ action: "markdown", input: { url: "https://example.com" } });

    expect(
      cloudflareRuntimeTools[1].adapters!.bash!.parse([
        "--action",
        "screenshot",
        "--input-json",
        '{"html":"<h1>Hello</h1>"}',
      ]),
    ).toEqual({ action: "screenshot", input: { html: "<h1>Hello</h1>" } });

    expect(
      cloudflareRuntimeTools[2].adapters!.bash!.parse(["--action", "get", "--job-id", "crawl-123"]),
    ).toEqual({ action: "get", jobId: "crawl-123" });
  });

  test("delegates extract and crawl actions to the singleton runtime", async () => {
    const runtime = createRuntime();
    const context: BackofficeToolContext<{ cloudflare: CloudflareRuntime }> =
      createTrustedSystemBackofficeToolContext({ runtimes: { cloudflare: runtime } });
    const extractInput = {
      action: "content" as const,
      input: { url: "https://example.com" },
    };
    const crawlInput = {
      action: "start" as const,
      input: { url: "https://example.com" },
    };

    await expect(cloudflareRuntimeTools[0].execute(extractInput, context)).resolves.toEqual({
      action: "content",
      result: "<html>example</html>",
    });
    await expect(cloudflareRuntimeTools[2].execute(crawlInput, context)).resolves.toEqual({
      action: "start",
      result: { jobId: "crawl-123" },
    });
    expect(runtime.browserRunExtract).toHaveBeenCalledWith(extractInput);
    expect(runtime.browserRunCrawl).toHaveBeenCalledWith(crawlInput);
  });

  test("preserves capture bytes through Bash redirection", async () => {
    const fs = new InMemoryFs();
    const { bash, commandCallsResult } = createBashHost({
      fs,
      context: {
        ...EMPTY_BASH_HOST_CONTEXT,
        automation: null,
        automations: null,
        otp: null,
        pi: null,
        reson8: null,
        resend: null,
        telegram: null,
        cloudflare: { runtime: createRuntime() },
      },
    });

    const result = await bash.exec(
      `cloudflare.browser-run.capture --action screenshot --input-json '{"html":"<h1>Hello</h1>"}' > /tmp/page.png`,
    );

    assert(result.exitCode === 0);
    await expect(fs.readFileBuffer("/tmp/page.png")).resolves.toEqual(
      new Uint8Array([0, 255, 1, 2]),
    );
    expect(commandCallsResult).toEqual([
      {
        command: "cloudflare.browser-run.capture",
        output: "<binary>",
        exitCode: 0,
      },
    ]);
  });
});

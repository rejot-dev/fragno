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
  test("exposes capture and crawl tools", () => {
    expect(cloudflareRuntimeTools.map((tool) => tool.name)).toEqual([
      "browserRunCapture",
      "browserRunCrawl",
    ]);
    expect(cloudflareRuntimeTools.map((tool) => tool.adapters?.bash?.command)).toEqual([
      "cloudflare.browser-run.capture",
      "cloudflare.browser-run.crawl",
    ]);
  });

  test("parses capture and crawl actions", () => {
    expect(
      cloudflareRuntimeTools[0].adapters!.bash!.parse([
        "--action",
        "screenshot",
        "--input-json",
        '{"html":"<h1>Hello</h1>"}',
      ]),
    ).toEqual({ action: "screenshot", input: { html: "<h1>Hello</h1>" } });

    expect(
      cloudflareRuntimeTools[1].adapters!.bash!.parse(["--action", "get", "--job-id", "crawl-123"]),
    ).toEqual({ action: "get", jobId: "crawl-123" });
  });

  test("delegates crawl actions to the singleton runtime", async () => {
    const runtime = createRuntime();
    const context: BackofficeToolContext<{ cloudflare: CloudflareRuntime }> =
      createTrustedSystemBackofficeToolContext({ runtimes: { cloudflare: runtime } });
    const crawlInput = {
      action: "start" as const,
      input: { url: "https://example.com" },
    };

    await expect(cloudflareRuntimeTools[1].execute(crawlInput, context)).resolves.toEqual({
      action: "start",
      result: { jobId: "crawl-123" },
    });
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

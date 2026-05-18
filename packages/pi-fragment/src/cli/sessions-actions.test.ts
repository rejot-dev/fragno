import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { run } from "./mod";

const BASE_URL = "https://example.com/api";

const createLogger = () => ({ log: vi.fn(), error: vi.fn() });

let previousBaseUrl: string | undefined;

describe("sessions actions", () => {
  beforeEach(() => {
    previousBaseUrl = process.env["FRAGNO_PI_BASE_URL"];
    process.env["FRAGNO_PI_BASE_URL"] = BASE_URL;
  });

  afterEach(() => {
    if (previousBaseUrl === undefined) {
      delete process.env["FRAGNO_PI_BASE_URL"];
    } else {
      process.env["FRAGNO_PI_BASE_URL"] = previousBaseUrl;
    }
    vi.unstubAllGlobals();
  });

  it("lists sessions via HTTP", async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(
      new Response(
        JSON.stringify([
          {
            id: "session-1",
            agent: "agent-1",
            name: "Session One",
            status: "running",
            updatedAt: "2026-02-13T10:00:00Z",
          },
        ]),
        { status: 200 },
      ),
    );
    vi.stubGlobal("fetch", fetchMock as unknown as typeof fetch);

    const logger = createLogger();
    const exitCode = await run(["node", "fragno-pi", "sessions", "list", "--limit", "5"], {
      logger,
    });

    expect(exitCode).toBe(0);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] ?? [];
    expect(url).toBe(`${BASE_URL}/sessions?limit=5`);
    expect(init?.method).toBe("GET");
    expect(logger.log.mock.calls[0]?.[0]).toContain("ID");
  });

  it("creates sessions via HTTP", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ id: "session-9" }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock as unknown as typeof fetch);

    const logger = createLogger();
    const exitCode = await run(
      ["node", "fragno-pi", "sessions", "create", "--agent", "agent-1", "--name", "New Session"],
      { logger },
    );

    expect(exitCode).toBe(0);
    const [url, init] = fetchMock.mock.calls[0] ?? [];
    expect(url).toBe(`${BASE_URL}/sessions`);
    expect(init?.method).toBe("POST");
    expect(init?.headers).toMatchObject({ "content-type": "application/json" });
    expect(JSON.parse(String(init?.body))).toEqual({
      agent: "agent-1",
      name: "New Session",
    });
  });

  it("fetches session detail with status-only output", async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          id: "session-2",
          status: "running",
          workflow: { status: "running" },
          agent: {
            state: {
              messages: [{ role: "user", content: "hello" }],
            },
            events: [],
          },
          extra: "ignored",
        }),
        { status: 200 },
      ),
    );
    vi.stubGlobal("fetch", fetchMock as unknown as typeof fetch);

    const logger = createLogger();
    const exitCode = await run(
      ["node", "fragno-pi", "sessions", "get", "--session", "session-2", "--status-only", "--json"],
      { logger },
    );

    expect(exitCode).toBe(0);
    const [url] = fetchMock.mock.calls[0] ?? [];
    expect(url).toBe(`${BASE_URL}/sessions/session-2`);
    const output = logger.log.mock.calls[0]?.[0] ?? "";
    expect(JSON.parse(output)).toEqual({
      status: "running",
      workflow: { status: "running" },
      agent: {
        state: {
          messages: 1,
        },
      },
    });
  });

  it("follows session event streams via HTTP", async () => {
    const createStream = (events: unknown[]) =>
      new ReadableStream({
        start(controller) {
          const encoder = new TextEncoder();
          for (const event of events) {
            controller.enqueue(encoder.encode(`${JSON.stringify(event)}\n`));
          }
          controller.close();
        },
      });
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(
          createStream([
            { type: "snapshot", state: { messages: [] } },
            { type: "message_end", message: { role: "assistant", content: "hello there" } },
          ]),
          {
            status: 200,
            headers: { "content-type": "application/x-ndjson; charset=utf-8" },
          },
        ),
      )
      .mockResolvedValueOnce(
        new Response(
          createStream([
            {
              type: "snapshot",
              state: { messages: [{ role: "assistant" }] },
            },
            { type: "message_end", message: { role: "assistant", content: "again" } },
          ]),
          {
            status: 200,
            headers: { "content-type": "application/x-ndjson; charset=utf-8" },
          },
        ),
      )
      .mockRejectedValueOnce(new Error("The operation was aborted."));
    vi.stubGlobal("fetch", fetchMock as unknown as typeof fetch);

    const logger = createLogger();
    const exitCode = await run(
      ["node", "fragno-pi", "--retries", "0", "sessions", "follow", "--session", "session-2"],
      {
        logger,
      },
    );

    expect(exitCode).toBe(0);
    const [url, init] = fetchMock.mock.calls[0] ?? [];
    expect(url).toBe(`${BASE_URL}/sessions/session-2/events`);
    expect(init?.method).toBe("GET");
    expect(fetchMock).toHaveBeenCalledTimes(3);
    const output = logger.log.mock.calls.map((call) => call[0]);
    expect(output.join("\n")).toContain("message_end hello there");
    expect(output).toContain("--- reconnected ---");
    expect(output.join("\n")).toContain("[001] -  snapshot messages=1 events=0");
    expect(output.join("\n")).toContain("[002] -  message_end again");
  });

  it("fetches the full current-run session detail by default", async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          id: "session-2",
          status: "running",
          workflow: { status: "running" },
          agent: {
            state: {
              messages: [{ role: "user", content: "hello", timestamp: 1 }],
            },
            events: [
              { type: "message_end", message: { role: "user", content: "hello", timestamp: 1 } },
            ],
          },
        }),
        { status: 200 },
      ),
    );
    vi.stubGlobal("fetch", fetchMock as unknown as typeof fetch);

    const logger = createLogger();
    const exitCode = await run(
      ["node", "fragno-pi", "sessions", "get", "--session", "session-2", "--json"],
      { logger },
    );

    expect(exitCode).toBe(0);
    const [url] = fetchMock.mock.calls[0] ?? [];
    expect(url).toBe(`${BASE_URL}/sessions/session-2`);
    const output = JSON.parse(logger.log.mock.calls[0]?.[0] ?? "{}");
    expect(output).toMatchObject({
      id: "session-2",
      status: "running",
      agent: {
        state: { messages: [{ role: "user", content: "hello", timestamp: 1 }] },
        events: [{ type: "message_end" }],
      },
    });
  });

  it("renders session detail text output with Pi messages and events", async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          id: "session-2",
          name: "Support",
          agentName: "agent-1",
          status: "running",
          createdAt: "2026-03-06T09:00:00.000Z",
          updatedAt: "2026-03-06T09:01:00.000Z",
          workflow: { status: "running" },
          agent: {
            state: {
              messages: [
                { role: "user", content: "hello", timestamp: 1_700_000_000 },
                {
                  role: "assistant",
                  content: [{ type: "text", text: "hi" }],
                  timestamp: 1_700_000_005,
                },
              ],
            },
            events: [
              {
                type: "message_start",
                timestamp: 1_700_000_000,
                message: { role: "user", content: "hello" },
              },
              { type: "message_end", timestamp: 1_700_000_005 },
            ],
          },
        }),
        { status: 200 },
      ),
    );
    vi.stubGlobal("fetch", fetchMock as unknown as typeof fetch);

    const logger = createLogger();
    const exitCode = await run(["node", "fragno-pi", "sessions", "get", "--session", "session-2"], {
      logger,
    });

    expect(exitCode).toBe(0);
    const [url] = fetchMock.mock.calls[0] ?? [];
    expect(url).toBe(`${BASE_URL}/sessions/session-2`);

    const output = logger.log.mock.calls[0]?.[0] ?? "";
    expect(output).toContain("Session");
    expect(output).toContain("Messages (2)");
    expect(output).toContain("Events (2)");
    expect(output).not.toContain("Trace");
    expect(output).not.toContain("Turns");
    expect(output).toContain("Writer");
    expect(output).toContain("Timestamp");
    expect(output).toContain("Message");
    expect(output).not.toContain("Phase");
    expect(output).not.toContain("Turn");
    expect(output).not.toContain("Waiting");
    expect(output).toContain("message_start");
    expect(output).toContain("message_end");
    expect(output).toContain("hello");
    expect(output).toMatch(/\d{2}:\d{2}:\d{2}/);
    expect(output).not.toContain("1700000000");
    expect(output).not.toContain("1700000005");
    expect(output).not.toContain("2026-03-06T09:00:00.000Z");
    expect(output).not.toContain("2026-03-06T09:01:00.000Z");
  });

  it("returns exit code 2 on server errors", async () => {
    const previousRetries = process.env["FRAGNO_PI_RETRIES"];
    process.env["FRAGNO_PI_RETRIES"] = "0";

    try {
      const fetchMock = vi
        .fn()
        .mockResolvedValueOnce(new Response(JSON.stringify({ message: "boom" }), { status: 500 }));
      vi.stubGlobal("fetch", fetchMock as unknown as typeof fetch);

      const logger = createLogger();
      const exitCode = await run(["node", "fragno-pi", "sessions", "list"], { logger });

      expect(exitCode).toBe(2);
      expect(logger.error.mock.calls[0]?.[0]).toContain("Request failed (500): boom");
    } finally {
      if (previousRetries === undefined) {
        delete process.env["FRAGNO_PI_RETRIES"];
      } else {
        process.env["FRAGNO_PI_RETRIES"] = previousRetries;
      }
    }
  });

  it("sends prompt text via HTTP", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ status: "running" }), { status: 202 }));
    vi.stubGlobal("fetch", fetchMock as unknown as typeof fetch);

    const logger = createLogger();
    const exitCode = await run(
      ["node", "fragno-pi", "sessions", "prompt", "--session", "session-3", "--text", "Hello"],
      { logger },
    );

    expect(exitCode).toBe(0);
    const [url, init] = fetchMock.mock.calls[0] ?? [];
    expect(url).toBe(`${BASE_URL}/sessions/session-3/command`);
    expect(init?.method).toBe("POST");
    expect(JSON.parse(String(init?.body))).toEqual({
      kind: "prompt",
      input: { text: "Hello" },
    });
    const output = logger.log.mock.calls[0]?.[0] ?? "";
    expect(output).toContain("Status: running");
    expect(output).toContain("Message accepted.");
  });

  it("reads prompt text from file", async () => {
    const dir = await mkdtemp(join(tmpdir(), "pi-fragment-cli-"));
    const filePath = join(dir, "message.txt");
    try {
      await writeFile(filePath, "From file");

      const fetchMock = vi
        .fn()
        .mockResolvedValueOnce(new Response(JSON.stringify({ status: "done" }), { status: 202 }));
      vi.stubGlobal("fetch", fetchMock as unknown as typeof fetch);

      const logger = createLogger();
      const exitCode = await run(
        [
          "node",
          "fragno-pi",
          "sessions",
          "prompt",
          "--session",
          "session-4",
          "--file",
          filePath,
          "--json",
        ],
        { logger },
      );

      expect(exitCode).toBe(0);
      const [url, init] = fetchMock.mock.calls[0] ?? [];
      expect(url).toBe(`${BASE_URL}/sessions/session-4/command`);
      expect(JSON.parse(String(init?.body))).toEqual({
        kind: "prompt",
        input: { text: "From file" },
      });
      expect(JSON.parse(logger.log.mock.calls[0]?.[0] ?? "{}")).toEqual({
        status: "done",
      });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

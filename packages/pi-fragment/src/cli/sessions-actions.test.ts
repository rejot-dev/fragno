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
      [
        "node",
        "fragno-pi",
        "sessions",
        "create",
        "--agent",
        "agent-1",
        "--name",
        "New Session",
        "--tag",
        "alpha",
        "--tag",
        "beta",
        "--metadata",
        '{"priority":2}',
        "--steering-mode",
        "all",
      ],
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
      tags: ["alpha", "beta"],
      metadata: { priority: 2 },
      steeringMode: "all",
    });
  });

  it("fetches session detail with status-only output", async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          id: "session-2",
          status: "running",
          workflow: { status: "running" },
          phase: "running-agent",
          turn: 3,
          waitingFor: { type: "assistant", turn: 3, stepKey: "do:assistant-3" },
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
      phase: "running-agent",
      turn: 3,
      waitingFor: { type: "assistant", turn: 3, stepKey: "do:assistant-3" },
    });
  });

  it("fetches the full current-run session detail by default", async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          id: "session-2",
          status: "running",
          workflow: { status: "running" },
          phase: "running-agent",
          turn: 1,
          waitingFor: { type: "assistant", turn: 1, stepKey: "do:assistant-1" },
          messages: [{ role: "user", content: "hello", timestamp: 1 }],
          events: [{ type: "user_message", payload: { text: "hello" } }],
          trace: [{ type: "llm_start" }],
          summaries: [{ turn: 1, summary: "hello" }],
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
      phase: "running-agent",
      turn: 1,
      events: [{ type: "user_message", payload: { text: "hello" } }],
      trace: [{ type: "llm_start" }],
      summaries: [{ turn: 1, summary: "hello" }],
    });
  });

  it("renders session detail text output with timestamps, trace, and summaries", async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          id: "session-2",
          name: "Support",
          agent: "agent-1",
          status: "running",
          phase: "running-agent",
          turn: 1,
          waitingFor: { type: "assistant", turn: 1, stepKey: "do:assistant-1" },
          steeringMode: "all",
          createdAt: "2026-03-06T09:00:00.000Z",
          updatedAt: "2026-03-06T09:01:00.000Z",
          workflow: { status: "running" },
          messages: [
            { role: "user", content: "hello", timestamp: 1_700_000_000 },
            {
              role: "assistant",
              content: [{ type: "text", text: "hi" }],
              timestamp: 1_700_000_005,
            },
          ],
          events: [
            { type: "user_message", timestamp: 1_700_000_000, payload: { text: "hello" } },
            { type: "assistant_reply", timestamp: 1_700_000_005 },
          ],
          trace: [{ type: "llm_start" }],
          summaries: [{ turn: 1, summary: "hello" }],
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
    expect(output).toContain("Trace (1)");
    expect(output).toContain("Summaries (1)");
    expect(output).toContain("Writer");
    expect(output).toContain("Timestamp");
    expect(output).toContain("Message");
    expect(output).toContain("Phase");
    expect(output).toContain("Turn");
    expect(output).toContain("Waiting");
    expect(output).toContain("user_message");
    expect(output).toContain("assistant_reply");
    expect(output).toContain("llm_start");
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

  it("sends message text via HTTP", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ status: "running" }), { status: 202 }));
    vi.stubGlobal("fetch", fetchMock as unknown as typeof fetch);

    const logger = createLogger();
    const exitCode = await run(
      [
        "node",
        "fragno-pi",
        "sessions",
        "send-message",
        "--session",
        "session-3",
        "--text",
        "Hello",
      ],
      { logger },
    );

    expect(exitCode).toBe(0);
    const [url, init] = fetchMock.mock.calls[0] ?? [];
    expect(url).toBe(`${BASE_URL}/sessions/session-3/messages`);
    expect(init?.method).toBe("POST");
    expect(JSON.parse(String(init?.body))).toEqual({ text: "Hello" });
    const output = logger.log.mock.calls[0]?.[0] ?? "";
    expect(output).toContain("Status: running");
    expect(output).toContain("Message accepted.");
  });

  it("reads message text from file", async () => {
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
          "send-message",
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
      expect(url).toBe(`${BASE_URL}/sessions/session-4/messages`);
      expect(JSON.parse(String(init?.body))).toEqual({ text: "From file" });
      expect(JSON.parse(logger.log.mock.calls[0]?.[0] ?? "{}")).toEqual({
        status: "done",
      });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

import { describe, expect, it, vi } from "vitest";

import { __testing, run, type CliActions, type CliContext } from "./mod";

const createActions = (handler: Partial<CliActions>): CliActions => ({
  sessionsList: handler.sessionsList ?? (() => ({})),
  sessionsCreate: handler.sessionsCreate ?? (() => ({})),
  sessionsGet: handler.sessionsGet ?? (() => ({})),
  sessionsSendMessage: handler.sessionsSendMessage ?? (() => ({})),
});

describe("fragno-pi CLI", () => {
  it("prints usage when no command is provided", async () => {
    const logger = { log: vi.fn(), error: vi.fn() };

    const exitCode = await run(["node", "fragno-pi"], { logger });

    expect(exitCode).toBe(0);
    expect(logger.log).toHaveBeenCalledWith(__testing.USAGE);
    expect(logger.error).not.toHaveBeenCalled();
  });

  it("prints usage when help flag is provided", async () => {
    const logger = { log: vi.fn(), error: vi.fn() };

    const exitCode = await run(["node", "fragno-pi", "--help"], { logger });

    expect(exitCode).toBe(0);
    expect(logger.log).toHaveBeenCalledWith(__testing.USAGE);
    expect(logger.error).not.toHaveBeenCalled();
  });

  it("prints usage and returns 1 for explicit help command", async () => {
    const logger = { log: vi.fn(), error: vi.fn() };

    const exitCode = await run(["node", "fragno-pi", "help"], { logger });

    expect(exitCode).toBe(1);
    expect(logger.log).toHaveBeenCalledWith(__testing.USAGE);
  });

  it("rejects unknown commands", async () => {
    const logger = { log: vi.fn(), error: vi.fn() };

    const exitCode = await run(["node", "fragno-pi", "wat"], { logger });

    expect(exitCode).toBe(1);
    expect(logger.error.mock.calls[0]?.[0]).toContain("Unknown command: wat");
  });

  it("rejects unknown options with a suggestion", async () => {
    const logger = { log: vi.fn(), error: vi.fn() };

    const exitCode = await run(
      [
        "node",
        "fragno-pi",
        "sessions",
        "send-message",
        "--session-id",
        "session-1",
        "--text",
        "hello",
      ],
      { logger },
    );

    expect(exitCode).toBe(1);
    expect(logger.error.mock.calls[0]?.[0]).toContain("Unknown option: --session-id");
    expect(logger.error.mock.calls[0]?.[0]).toContain("did you mean --session?");
  });

  it("routes sessions list with parsed options", async () => {
    const logger = { log: vi.fn(), error: vi.fn() };
    const sessionsList = vi.fn(() => ({
      output: {
        format: "table" as const,
        columns: [{ key: "id", label: "ID" }],
        rows: [{ id: "session-1" }],
      },
    }));

    const exitCode = await run(["node", "fragno-pi", "sessions", "list", "--limit", "5"], {
      logger,
      actions: createActions({ sessionsList }),
    });

    expect(exitCode).toBe(0);
    expect(sessionsList).toHaveBeenCalledWith(
      { limit: 5 },
      expect.objectContaining({ config: expect.any(Object) }) as CliContext,
    );
    expect(logger.log.mock.calls[0]?.[0]).toContain("ID");
  });

  it("renders JSON output when --json is provided", async () => {
    const logger = { log: vi.fn(), error: vi.fn() };
    const sessionsGet = vi.fn(() => ({
      output: {
        format: "pretty-json" as const,
        data: { id: "session-1" },
      },
    }));

    const exitCode = await run(
      ["node", "fragno-pi", "sessions", "get", "--session", "session-1", "--json"],
      { logger, actions: createActions({ sessionsGet }) },
    );

    expect(exitCode).toBe(0);
    expect(logger.log.mock.calls[0]?.[0]).toContain('"id":"session-1"');
  });

  it("fails when required args are missing", async () => {
    const logger = { log: vi.fn(), error: vi.fn() };

    const exitCode = await run(["node", "fragno-pi", "sessions", "create"], { logger });

    expect(exitCode).toBe(1);
    expect(logger.error.mock.calls[0]?.[0]).toContain("--agent");
  });

  it("requires message text for send-message", async () => {
    const logger = { log: vi.fn(), error: vi.fn() };

    const exitCode = await run(
      ["node", "fragno-pi", "sessions", "send-message", "--session", "session-1"],
      { logger },
    );

    expect(exitCode).toBe(1);
    expect(logger.error.mock.calls[0]?.[0]).toContain("--text");
  });

  it("rejects invalid steering mode values", async () => {
    const logger = { log: vi.fn(), error: vi.fn() };

    const exitCode = await run(
      ["node", "fragno-pi", "sessions", "create", "--agent", "agent-1", "--steering-mode", "nope"],
      { logger },
    );

    expect(exitCode).toBe(1);
    expect(logger.error.mock.calls[0]?.[0]).toContain("Invalid --steering-mode");
  });

  it("rejects invalid JSON for metadata", async () => {
    const logger = { log: vi.fn(), error: vi.fn() };

    const exitCode = await run(
      ["node", "fragno-pi", "sessions", "create", "--agent", "agent-1", "--metadata", "{"],
      { logger },
    );

    expect(exitCode).toBe(1);
    expect(logger.error.mock.calls[0]?.[0]).toContain("Invalid JSON for --metadata");
  });

  it("requires a base URL for request execution", async () => {
    const logger = { log: vi.fn(), error: vi.fn() };
    const previousBaseUrl = process.env["FRAGNO_PI_BASE_URL"];
    delete process.env["FRAGNO_PI_BASE_URL"];

    try {
      const exitCode = await run(["node", "fragno-pi", "sessions", "list"], { logger });

      expect(exitCode).toBe(1);
      expect(logger.error.mock.calls[0]?.[0]).toContain("Missing required option: --base-url");
    } finally {
      if (previousBaseUrl !== undefined) {
        process.env["FRAGNO_PI_BASE_URL"] = previousBaseUrl;
      }
    }
  });

  it("exposes parseArgs for testing", () => {
    const parsed = __testing.parseArgs(["sessions", "get", "--session", "abc"]);

    expect(parsed.command).toBe("sessions");
    expect(parsed.action).toBe("get");
  });
});

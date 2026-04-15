import { describe, expect, it, vi } from "vitest";

import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { __testing, run } from "./cli.js";

const currentDir = dirname(fileURLToPath(import.meta.url));
const beforeFixture = resolve(currentDir, "../test/fixtures/trace-before");
const afterFixture = resolve(currentDir, "../test/fixtures/trace-after");

const createLogger = () => ({
  log: vi.fn(),
  error: vi.fn(),
});

describe("ts-trace CLI", () => {
  it("prints usage when no command is provided", async () => {
    const logger = createLogger();

    const exitCode = await run(["node", "ts-trace"], { logger });

    expect(exitCode).toBe(0);
    expect(logger.log).toHaveBeenCalledWith(__testing.USAGE);
  });

  it("renders summary JSON with overall and project-local sections", async () => {
    const logger = createLogger();

    const exitCode = await run(
      [
        "node",
        "ts-trace",
        "summary",
        beforeFixture,
        "--format",
        "json",
        "--workspace-root",
        "/repo",
      ],
      { logger },
    );

    expect(exitCode).toBe(0);

    const output = JSON.parse(logger.log.mock.calls[0]?.[0] ?? "{}");
    expect(output.entryCount).toBe(23);
    expect(output.projectLocalFiles[0]).toMatchObject({
      file: "packages/fragno-db/src/schema/create.ts",
      count: 14,
    });
    expect(output.projectLocalSymbols[0]).toMatchObject({ symbol: "MainSelectResult", count: 5 });
    expect(
      output.overallSymbols.some((row: { symbol: string }) => row.symbol === "ErrorConstructor"),
    ).toBe(true);
    expect(
      output.projectLocalSymbols.some(
        (row: { symbol: string }) => row.symbol === "ErrorConstructor",
      ),
    ).toBe(false);
  });

  it("renders file JSON with anonymous group counts and raw samples", async () => {
    const logger = createLogger();

    const exitCode = await run(
      [
        "node",
        "ts-trace",
        "file",
        beforeFixture,
        "packages/fragno-db/src/schema/create.ts",
        "--format",
        "json",
        "--workspace-root",
        "/repo",
        "--samples",
        "3",
      ],
      { logger },
    );

    expect(exitCode).toBe(0);

    const output = JSON.parse(logger.log.mock.calls[0]?.[0] ?? "{}");
    expect(output.entryCount).toBe(14);
    expect(output.symbolCounts[0]).toMatchObject({ symbol: "TableBuilder", count: 4 });
    expect(output.anonymousGroups).toEqual([
      { symbol: "__function", count: 1 },
      { symbol: "__object", count: 1 },
      { symbol: "__type", count: 1 },
    ]);
    expect(output.rawSamples).toHaveLength(3);
  });

  it("renders symbol JSON with declaration files and sample displays", async () => {
    const logger = createLogger();

    const exitCode = await run(
      [
        "node",
        "ts-trace",
        "symbol",
        beforeFixture,
        "TableBuilder",
        "--format",
        "json",
        "--workspace-root",
        "/repo",
        "--samples",
        "2",
      ],
      { logger },
    );

    expect(exitCode).toBe(0);

    const output = JSON.parse(logger.log.mock.calls[0]?.[0] ?? "{}");
    expect(output.totalCount).toBe(4);
    expect(output.declarationFiles).toEqual([
      { file: "packages/fragno-db/src/schema/create.ts", count: 4 },
    ]);
    expect(output.sampleDisplays).toEqual(["TableBuilder<Users>", "TableBuilder<Posts>"]);
  });

  it("renders compare JSON with improvements and regressions", async () => {
    const logger = createLogger();

    const exitCode = await run(
      [
        "node",
        "ts-trace",
        "compare",
        beforeFixture,
        afterFixture,
        "--format",
        "json",
        "--workspace-root",
        "/repo",
      ],
      { logger },
    );

    expect(exitCode).toBe(0);

    const output = JSON.parse(logger.log.mock.calls[0]?.[0] ?? "{}");
    expect(output.biggestImprovements.symbols).toEqual(
      expect.arrayContaining([
        { symbol: "ColumnsToTuple", beforeCount: 2, afterCount: 0, delta: -2 },
      ]),
    );
    expect(output.biggestImprovements.symbols).toEqual(
      expect.arrayContaining([{ symbol: "Table", beforeCount: 3, afterCount: 1, delta: -2 }]),
    );
    expect(output.biggestRegressions.symbols).toEqual(
      expect.arrayContaining([
        { symbol: "MainSelectResult", beforeCount: 5, afterCount: 7, delta: 2 },
      ]),
    );
  });

  it("rejects unknown commands", async () => {
    const logger = createLogger();

    const exitCode = await run(["node", "ts-trace", "wat"], { logger });

    expect(exitCode).toBe(1);
    expect(logger.error).toHaveBeenCalledWith("Unknown command: wat");
  });

  it("documents what count means in help output", () => {
    expect(__testing.USAGE).toContain("Count means the number of matching entries in types.json");
    expect(__testing.SUMMARY_USAGE).toContain(
      "Count means the number of matching entries in types.json",
    );
  });
});

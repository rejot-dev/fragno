import { describe, expect, test } from "vitest";

import {
  MarketplaceWorkspaceFileConflictError,
  planMarketplaceWorkspaceUpdate,
  type MarketplaceIngestionSourceFile,
  type MarketplaceWorkspaceTargetFile,
} from "./marketplace-ingestion-files";

const sourceFile = (
  relativePath: string,
  checksum: string,
  mode: number | null = 0o755,
): MarketplaceIngestionSourceFile => ({
  fileKey: `1.0.0/${relativePath}`,
  relativePath,
  contentType: "text/plain",
  sizeBytes: 10,
  checksum: { algo: "sha256", value: checksum },
  mode,
});

const targetFile = (revision: number, checksum: string): MarketplaceWorkspaceTargetFile => ({
  revision,
  sizeBytes: 10,
  checksum: { algo: "sha256", value: checksum },
});

describe("planMarketplaceWorkspaceUpdate", () => {
  test("writes absent files with their source mode", () => {
    const source = sourceFile("commands/new.ts", "new");

    expect(
      planMarketplaceWorkspaceUpdate({
        observations: [{ source, target: null }],
        previousSourceFilesByPath: new Map(),
      }),
    ).toEqual({
      writes: [{ source, precondition: { kind: "absent" }, mode: 0o755 }],
      assertions: [],
    });
  });

  test("asserts files that already match the requested version", () => {
    const source = sourceFile("commands/current.ts", "same");

    expect(
      planMarketplaceWorkspaceUpdate({
        observations: [{ source, target: targetFile(4, "same") }],
        previousSourceFilesByPath: new Map(),
      }),
    ).toEqual({
      writes: [],
      assertions: [
        {
          path: "/workspace/commands/current.ts",
          precondition: { kind: "revision", revision: 4 },
        },
      ],
    });
  });

  test("replaces files that still match the installed version without replacing their mode", () => {
    const source = sourceFile("commands/current.ts", "next");
    const installedSource = sourceFile("commands/current.ts", "installed", 0o700);

    expect(
      planMarketplaceWorkspaceUpdate({
        observations: [{ source, target: targetFile(7, "installed") }],
        previousSourceFilesByPath: new Map([[source.relativePath, installedSource]]),
      }),
    ).toEqual({
      writes: [{ source, precondition: { kind: "revision", revision: 7 } }],
      assertions: [],
    });
  });

  test("rejects files changed independently of the installed version", () => {
    const source = sourceFile("commands/current.ts", "next");
    const installedSource = sourceFile("commands/current.ts", "installed");

    expect(() =>
      planMarketplaceWorkspaceUpdate({
        observations: [{ source, target: targetFile(7, "local") }],
        previousSourceFilesByPath: new Map([[source.relativePath, installedSource]]),
      }),
    ).toThrow(MarketplaceWorkspaceFileConflictError);
  });
});

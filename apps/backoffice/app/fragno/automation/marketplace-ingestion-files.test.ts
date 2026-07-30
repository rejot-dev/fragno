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
  test("creates files added by the requested version with their source mode", () => {
    const requestedSource = sourceFile("commands/new.ts", "new");

    expect(
      planMarketplaceWorkspaceUpdate({
        observations: [
          {
            relativePath: requestedSource.relativePath,
            requestedSource,
            installedSource: null,
            target: null,
          },
        ],
      }),
    ).toEqual({
      writes: [{ source: requestedSource, precondition: { kind: "absent" }, mode: 0o755 }],
      deletions: [],
      assertions: [],
    });
  });

  test("asserts files that already match the requested version", () => {
    const requestedSource = sourceFile("commands/current.ts", "same");

    expect(
      planMarketplaceWorkspaceUpdate({
        observations: [
          {
            relativePath: requestedSource.relativePath,
            requestedSource,
            installedSource: null,
            target: targetFile(4, "same"),
          },
        ],
      }),
    ).toEqual({
      writes: [],
      deletions: [],
      assertions: [
        {
          path: "/workspace/commands/current.ts",
          precondition: { kind: "revision", revision: 4 },
        },
      ],
    });
  });

  test("replaces files that still match the installed version without replacing their mode", () => {
    const requestedSource = sourceFile("commands/current.ts", "next");
    const installedSource = sourceFile("commands/current.ts", "installed", 0o700);

    expect(
      planMarketplaceWorkspaceUpdate({
        observations: [
          {
            relativePath: requestedSource.relativePath,
            requestedSource,
            installedSource,
            target: targetFile(7, "installed"),
          },
        ],
      }),
    ).toEqual({
      writes: [{ source: requestedSource, precondition: { kind: "revision", revision: 7 } }],
      deletions: [],
      assertions: [],
    });
  });

  test("removes files omitted by the requested version when they still match the installed source", () => {
    const installedSource = sourceFile("commands/removed.ts", "installed");

    expect(
      planMarketplaceWorkspaceUpdate({
        observations: [
          {
            relativePath: installedSource.relativePath,
            requestedSource: null,
            installedSource,
            target: targetFile(9, "installed"),
          },
        ],
      }),
    ).toEqual({
      writes: [],
      deletions: [
        {
          path: "/workspace/commands/removed.ts",
          precondition: { kind: "revision", revision: 9 },
        },
      ],
      assertions: [],
    });
  });

  test("asserts that an already removed file remains absent", () => {
    const installedSource = sourceFile("commands/removed.ts", "installed");

    expect(
      planMarketplaceWorkspaceUpdate({
        observations: [
          {
            relativePath: installedSource.relativePath,
            requestedSource: null,
            installedSource,
            target: null,
          },
        ],
      }),
    ).toEqual({
      writes: [],
      deletions: [],
      assertions: [
        {
          path: "/workspace/commands/removed.ts",
          precondition: { kind: "absent" },
        },
      ],
    });
  });

  test("rejects files changed independently of the installed version", () => {
    const requestedSource = sourceFile("commands/current.ts", "next");
    const installedSource = sourceFile("commands/current.ts", "installed");

    expect(() =>
      planMarketplaceWorkspaceUpdate({
        observations: [
          {
            relativePath: requestedSource.relativePath,
            requestedSource,
            installedSource,
            target: targetFile(7, "local"),
          },
        ],
      }),
    ).toThrow(MarketplaceWorkspaceFileConflictError);
  });

  test("rejects locally modified files that the requested version removes", () => {
    const installedSource = sourceFile("commands/removed.ts", "installed");

    expect(() =>
      planMarketplaceWorkspaceUpdate({
        observations: [
          {
            relativePath: installedSource.relativePath,
            requestedSource: null,
            installedSource,
            target: targetFile(7, "local"),
          },
        ],
      }),
    ).toThrow(MarketplaceWorkspaceFileConflictError);
  });
});

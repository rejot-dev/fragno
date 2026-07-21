import { describe, expect, it, assert } from "vitest";

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

type ConformanceSnapshot = {
  packageVersion: string;
  serverConformanceSourceSha256: string;
  serverConformanceSourceTreeSha256: string;
  clientPackageVersion: string;
  clientSourceTreeSha256: string;
  reviewedClientCheckoutSourceTreeSha256: string;
  reviewedProtocolCommit: string;
  protocolSha256: string;
  reviewedAt: string;
  coveredReadAreas: string[];
  knownUnsupportedReadAreas: string[];
  notApplicableReadAreas: string[];
};

const require = createRequire(import.meta.url);
const serverPackageJsonPath =
  require.resolve("@durable-streams/server-conformance-tests/package.json");
const serverPackageRoot = dirname(serverPackageJsonPath);
const clientPackageJsonPath = require.resolve("@durable-streams/client/package.json");
const clientPackageRoot = dirname(clientPackageJsonPath);
const snapshotPath = fileURLToPath(
  new URL("./durable-streams.conformance-snapshot.json", import.meta.url),
);

const readJson = <T>(path: string): T => JSON.parse(readFileSync(path, "utf8")) as T;
const sha256 = (path: string): string =>
  createHash("sha256").update(readFileSync(path)).digest("hex");

const listFiles = (directory: string): string[] =>
  readdirSync(directory).flatMap((name) => {
    const path = join(directory, name);
    return statSync(path).isDirectory() ? listFiles(path) : [path];
  });

const treeSha256 = (directory: string): string => {
  const hash = createHash("sha256");
  for (const path of listFiles(directory).sort()) {
    hash.update(relative(directory, path));
    hash.update("\0");
    hash.update(readFileSync(path));
    hash.update("\0");
  }
  return hash.digest("hex");
};

const snapshot = readJson<ConformanceSnapshot>(snapshotPath);
const installedServerPackage = readJson<{ version: string }>(serverPackageJsonPath);
const installedClientPackage = readJson<{ version: string }>(clientPackageJsonPath);
const installedTestSource = join(serverPackageRoot, "src", "index.ts");

describe("Durable Streams conformance freshness", () => {
  it("fails when the reviewed upstream server conformance source changes", () => {
    expect(installedServerPackage.version).toBe(snapshot.packageVersion);
    expect(sha256(installedTestSource)).toBe(snapshot.serverConformanceSourceSha256);
    expect(treeSha256(join(serverPackageRoot, "src"))).toBe(
      snapshot.serverConformanceSourceTreeSha256,
    );
  });

  it("fails when the reviewed standard client source changes", () => {
    expect(installedClientPackage.version).toBe(snapshot.clientPackageVersion);
    expect(treeSha256(join(clientPackageRoot, "src"))).toBe(snapshot.clientSourceTreeSha256);
  });

  it("records covered, unsupported, and not-applicable read areas", () => {
    expect(snapshot.reviewedProtocolCommit).toMatch(/^[0-9a-f]{40}$/);
    expect(snapshot.reviewedAt).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(snapshot.coveredReadAreas.length).toBeGreaterThan(0);
    expect(snapshot.knownUnsupportedReadAreas).toEqual(["Server-Sent Events"]);
    expect(snapshot.notApplicableReadAreas.length).toBeGreaterThan(0);
  });

  it.runIf(Boolean(process.env["DURABLE_STREAMS_REPO"]))(
    "matches the exact configured Durable Streams checkout commit and source trees",
    () => {
      const repository = process.env["DURABLE_STREAMS_REPO"] as string;
      const checkoutPackageJson = join(
        repository,
        "packages",
        "server-conformance-tests",
        "package.json",
      );
      const checkoutTestSource = join(
        repository,
        "packages",
        "server-conformance-tests",
        "src",
        "index.ts",
      );
      const checkoutClientPackageJson = join(repository, "packages", "client", "package.json");
      const checkoutProtocol = join(repository, "PROTOCOL.md");

      assert(existsSync(checkoutPackageJson));
      assert(existsSync(checkoutTestSource));
      assert(existsSync(checkoutClientPackageJson));
      assert(existsSync(checkoutProtocol));
      expect(readJson<{ version: string }>(checkoutPackageJson).version).toBe(
        snapshot.packageVersion,
      );
      expect(readJson<{ version: string }>(checkoutClientPackageJson).version).toBe(
        snapshot.clientPackageVersion,
      );
      expect(sha256(checkoutTestSource)).toBe(snapshot.serverConformanceSourceSha256);
      expect(treeSha256(join(repository, "packages", "server-conformance-tests", "src"))).toBe(
        snapshot.serverConformanceSourceTreeSha256,
      );
      expect(treeSha256(join(repository, "packages", "client", "src"))).toBe(
        snapshot.reviewedClientCheckoutSourceTreeSha256,
      );
      expect(sha256(checkoutProtocol)).toBe(snapshot.protocolSha256);
      expect(
        execFileSync("git", ["-C", repository, "rev-parse", "HEAD"], {
          encoding: "utf8",
        }).trim(),
      ).toBe(snapshot.reviewedProtocolCommit);
    },
  );
});

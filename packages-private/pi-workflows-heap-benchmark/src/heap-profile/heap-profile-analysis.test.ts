import { afterEach, assert, describe, expect, it } from "vitest";

import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { analyzeHeapAllocationProfile } from "./heap-profile-analysis";
import { createHeapProfileSourceResolver } from "./heap-profile-source-locations";

const directories: string[] = [];
afterEach(() => {
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function testRepository() {
  const repositoryRoot = mkdtempSync(path.join(tmpdir(), "fragno-heap-analysis-"));
  directories.push(repositoryRoot);
  const compiledFile = path.join(repositoryRoot, "packages", "fragno-db", "dist", "query.js");
  const sourceFile = path.join(repositoryRoot, "packages", "fragno-db", "src", "query.ts");
  mkdirSync(path.dirname(compiledFile), { recursive: true });
  mkdirSync(path.dirname(sourceFile), { recursive: true });
  writeFileSync(sourceFile, "export function compileFind() {}\n");
  writeFileSync(
    `${compiledFile}.map`,
    JSON.stringify({
      version: 3,
      file: "query.js",
      sources: ["../src/query.ts"],
      names: [],
      mappings: "AAAA",
    }),
  );
  return { repositoryRoot, compiledFile };
}

function frame(functionName: string, url: string) {
  return { functionName, url, lineNumber: 0, columnNumber: 0 };
}

describe("heap allocation profile analysis", () => {
  it("attributes dependency allocations to the nearest source-mapped project caller without double counting", () => {
    const { repositoryRoot, compiledFile } = testRepository();
    const dependency = path.join(
      repositoryRoot,
      "node_modules",
      ".pnpm",
      "kysely@0.28.17",
      "node_modules",
      "kysely",
      "visitor.js",
    );
    const profile = {
      head: {
        id: 1,
        selfSize: 0,
        callFrame: frame("(root)", ""),
        children: [
          {
            id: 2,
            selfSize: 0,
            callFrame: frame("compileFind", pathToFileURL(compiledFile).href),
            children: [
              {
                id: 3,
                selfSize: 200,
                callFrame: frame("OperationNodeVisitor", pathToFileURL(dependency).href),
                children: [],
              },
              {
                id: 4,
                selfSize: 80,
                callFrame: frame("compileFind", pathToFileURL(compiledFile).href),
                children: [],
              },
            ],
          },
          { id: 5, selfSize: 50, callFrame: frame("native", ""), children: [] },
        ],
      },
      samples: [
        { nodeId: 3, size: 100, ordinal: 1 },
        { nodeId: 3, size: 100, ordinal: 2 },
        { nodeId: 4, size: 80, ordinal: 3 },
        { nodeId: 5, size: 50, ordinal: 4 },
        { nodeId: 999, size: 25, ordinal: 5 },
      ],
    };
    const analysis = analyzeHeapAllocationProfile(
      profile,
      createHeapProfileSourceResolver(repositoryRoot),
    );

    expect(analysis).toMatchObject({
      sampledBytes: 355,
      resolvedBytes: 330,
      unresolvedBytes: 25,
      unresolvedSamples: 1,
      unattributedBytes: 50,
      treeSelfBytes: 330,
    });
    expect(analysis.projectOwners).toEqual([
      { label: "compileFind packages/fragno-db/src/query.ts:1:1", bytes: 280, samples: 3 },
    ]);
    expect(analysis.inclusiveProjectFrames).toEqual(analysis.projectOwners);
    expect(analysis.modules).toEqual([
      { label: "dependency:kysely", bytes: 200, samples: 2 },
      { label: "packages/fragno-db", bytes: 80, samples: 1 },
      { label: "(native/anonymous)", bytes: 50, samples: 1 },
    ]);
    expect(analysis.ownedCallPaths[0]).toMatchObject({
      bytes: 200,
      label: expect.stringContaining(
        "compileFind packages/fragno-db/src/query.ts:1:1 ← OperationNodeVisitor",
      ),
    });
    assert(analysis.selfAllocators.reduce((sum, group) => sum + group.bytes, 0) === 330);
    assert(
      analysis.projectOwners.reduce((sum, group) => sum + group.bytes, 0) +
        analysis.unattributedBytes ===
        330,
    );
  });

  it("rejects malformed nodes, samples and reused IDs at the file boundary", () => {
    const resolver = createHeapProfileSourceResolver(process.cwd());
    const root = { id: 1, selfSize: 0, callFrame: frame("root", ""), children: [] };
    expect(() =>
      analyzeHeapAllocationProfile(
        { head: root, samples: [{ nodeId: 1, size: -1, ordinal: 1 }] },
        resolver,
      ),
    ).toThrow("invalid allocation sample");
    expect(() =>
      analyzeHeapAllocationProfile({ head: { ...root, children: [root] }, samples: [] }, resolver),
    ).toThrow("duplicate node ID");
    expect(() =>
      analyzeHeapAllocationProfile({ head: root, samples: "invalid" }, resolver),
    ).toThrow("head node and samples array");
  });
});

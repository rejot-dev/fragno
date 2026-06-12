import { describe, expect, it, assert } from "vitest";

import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { loadTypesTrace } from "./types-trace.js";

const fixtureDir = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../../test/fixtures/trace-before",
);

describe("loadTypesTrace", () => {
  it("normalizes declaration paths to repo-relative workspace paths", () => {
    const result = loadTypesTrace(fixtureDir, { workspaceRoot: "/repo" });
    const tableBuilder = result.entries.find((entry) => entry.symbolName === "TableBuilder");
    const mainSelectResult = result.entries.find(
      (entry) => entry.symbolName === "MainSelectResult",
    );
    const tsLib = result.entries.find((entry) => entry.symbolName === "ErrorConstructor");
    const intrinsic = result.entries.find((entry) => entry.intrinsicName === "string");

    assert(result.entryCount === 23);
    assert(tableBuilder?.declaration?.displayPath === "packages/fragno-db/src/schema/create.ts");
    assert(
      mainSelectResult?.declaration?.displayPath ===
        "packages/fragno-db/src/query/simple-query-interface.ts",
    );
    assert(tsLib?.declaration?.isNodeModules);
    assert(tsLib?.declaration?.isTypeScriptLib);
    assert(intrinsic?.normalizedSymbolName === "string");
    expect(intrinsic?.declaration).toBeUndefined();
  });
});

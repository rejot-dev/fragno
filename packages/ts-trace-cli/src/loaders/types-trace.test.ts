import { describe, expect, it } from "vitest";

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

    expect(result.entryCount).toBe(23);
    expect(tableBuilder?.declaration?.displayPath).toBe("packages/fragno-db/src/schema/create.ts");
    expect(mainSelectResult?.declaration?.displayPath).toBe(
      "packages/fragno-db/src/query/simple-query-interface.ts",
    );
    expect(tsLib?.declaration?.isNodeModules).toBe(true);
    expect(tsLib?.declaration?.isTypeScriptLib).toBe(true);
    expect(intrinsic?.normalizedSymbolName).toBe("string");
    expect(intrinsic?.declaration).toBeUndefined();
  });
});

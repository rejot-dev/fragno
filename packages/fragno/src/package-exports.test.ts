import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

type ExportTarget = string | ExportTargetMap;

interface ExportTargetMap {
  [condition: string]: ExportTarget;
}

function resolveExportTarget(target: ExportTarget, conditions: Set<string>): string | null {
  if (typeof target === "string") {
    return target;
  }

  for (const [condition, value] of Object.entries(target)) {
    if (condition !== "default" && !conditions.has(condition)) {
      continue;
    }

    const resolved = resolveExportTarget(value, conditions);
    if (resolved) {
      return resolved;
    }
  }

  return null;
}

const packageJson = JSON.parse(readFileSync(join(process.cwd(), "package.json"), "utf8")) as {
  exports: {
    ".": ExportTarget;
  };
};

describe("@fragno-dev/core package exports", () => {
  it("keeps browser bundles on mod-client even when workerd is present", () => {
    expect(
      resolveExportTarget(
        packageJson.exports["."],
        new Set(["workerd", "worker", "browser", "module", "development"]),
      ),
    ).toBe("./dist/mod-client.js");
  });

  it("keeps SSR bundles on mod.js when both node and browser are present", () => {
    expect(
      resolveExportTarget(
        packageJson.exports["."],
        new Set(["node", "workerd", "worker", "browser", "module", "development"]),
      ),
    ).toBe("./dist/mod.js");
  });

  it("still exposes the server entry for workerd-only resolution", () => {
    expect(resolveExportTarget(packageJson.exports["."], new Set(["workerd", "module"]))).toBe(
      "./dist/mod.js",
    );
  });
});

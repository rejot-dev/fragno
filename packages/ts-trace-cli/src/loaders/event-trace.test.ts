import { describe, expect, it } from "vitest";

import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { loadEventTrace } from "./event-trace.js";

const fixtureDir = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../../test/fixtures/trace-before",
);

describe("loadEventTrace", () => {
  it("splits metadata from normal events and normalizes event paths", () => {
    const result = loadEventTrace(fixtureDir, { workspaceRoot: "/repo" });

    expect(result.metadataEvents).toHaveLength(2);
    expect(result.events).toHaveLength(5);
    expect(result.events[1]?.path?.displayPath).toBe("packages/fragno-db/src/schema/create.ts");
    expect(result.events[2]?.path?.displayPath).toBe("packages/fragno-db/src/schema/create.ts");
    expect(result.events[3]?.duration).toBe(120);
  });
});

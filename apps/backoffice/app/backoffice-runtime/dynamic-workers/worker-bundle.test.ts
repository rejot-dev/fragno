import { describe, expect, test } from "vitest";

import { createWorkerBundle } from "./worker-bundle";

const runtime = {
  compatibilityDate: "2026-06-11",
  compatibilityFlags: ["nodejs_compat", "nodejs_als"],
};

describe("WorkerBundle", () => {
  test("normalizes compatibility flags", () => {
    const bundle = createWorkerBundle({
      mainModule: "worker.js",
      modules: { "worker.js": "export default {};" },
      runtime: {
        compatibilityDate: runtime.compatibilityDate,
        compatibilityFlags: ["nodejs_compat", "nodejs_als", "nodejs_compat"],
      },
    });

    expect(bundle.runtime.compatibilityFlags).toEqual(["nodejs_compat", "nodejs_als"]);
  });

  test("rejects an absent main module and invalid runtime settings", () => {
    expect(() =>
      createWorkerBundle({
        mainModule: "worker.js",
        modules: { "other.js": "export default {};" },
        runtime,
      }),
    ).toThrow("main module 'worker.js' is missing");

    expect(() =>
      createWorkerBundle({
        mainModule: "worker.js",
        modules: { "worker.js": "export default {};" },
        runtime: { compatibilityDate: "2026-02-31" },
      }),
    ).toThrow("valid YYYY-MM-DD date");
  });
});

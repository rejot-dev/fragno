import { describe, expect, test } from "vitest";
import {
  parseCliArgs,
  parseWranglerConfig,
  readDispatchNamespaceFromWranglerConfig,
  readWranglerStringValue,
} from "./upload-debug-dispatch-worker";

describe("parseCliArgs", () => {
  test("rejects --app when the next token is another flag", () => {
    expect(() => parseCliArgs(["--app", "--namespace", "staging"])).toThrowError(
      "Missing value for --app.",
    );
  });

  test("rejects --org when the next token is missing", () => {
    expect(() => parseCliArgs(["--org"])).toThrowError("Missing value for --org.");
  });

  test("parses non-flag option values", () => {
    expect(
      parseCliArgs([
        "--org",
        "org-123",
        "--app",
        "debug-worker",
        "--namespace",
        "staging",
        "--base-url",
        "http://localhost:4000",
      ]),
    ).toEqual({
      orgId: "org-123",
      appId: "debug-worker",
      namespace: "staging",
      baseUrl: "http://localhost:4000",
      help: false,
    });
  });
});

describe("wrangler config parsing", () => {
  test("ignores commented examples and reads top-level values deterministically", () => {
    const config = parseWranglerConfig(`{
      // "compatibility_date": "2099-12-31"
      "compatibility_date": "2025-09-01",
      /*
      "dispatch_namespaces": [{ "namespace": "example" }],
      */
      "dispatch_namespaces": [
        {
          "namespace": "staging",
        },
      ],
    }`);

    expect(readWranglerStringValue(config, "compatibility_date")).toBe("2025-09-01");
    expect(readDispatchNamespaceFromWranglerConfig(config)).toBe("staging");
  });

  test("prefers env-specific values when a wrangler env is selected", () => {
    const config = parseWranglerConfig(`{
      "compatibility_date": "2025-09-01",
      "dispatch_namespaces": [{ "namespace": "staging" }],
      "env": {
        "preview": {
          "compatibility_date": "2025-10-15",
          "dispatch_namespaces": [{ "namespace": "preview-ns" }],
        },
      },
    }`);

    expect(readWranglerStringValue(config, "compatibility_date", "preview")).toBe("2025-10-15");
    expect(readDispatchNamespaceFromWranglerConfig(config, "preview")).toBe("preview-ns");
  });
});

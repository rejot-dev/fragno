import { describe, expect, it } from "vitest";

import {
  downloadBackofficeFile,
  parseBackofficeScope,
  uploadBackofficeWorkspaceFile,
} from "./backoffice-local.js";

describe("parseBackofficeScope", () => {
  it("parses encoded organization and project identifiers", () => {
    expect(parseBackofficeScope("project:org%2Fone:project%3Atwo")).toEqual({
      kind: "project",
      orgId: "org/one",
      projectId: "project:two",
    });
  });

  it("rejects unsupported scope shapes", () => {
    expect(() => parseBackofficeScope("project:missing-project")).toThrow(
      "Invalid Backoffice scope",
    );
  });
});

describe("Backoffice workspace file transfers", () => {
  it("rejects uploads in system scope before making a request", async () => {
    await expect(
      uploadBackofficeWorkspaceFile({
        baseUrl: "https://backoffice.invalid",
        scope: { kind: "system" },
        fileKey: "report.txt",
        content: new Blob([]).stream(),
        sizeBytes: 0,
        contentType: "application/octet-stream",
      }),
    ).rejects.toThrow("system scope does not have a /workspace filesystem");
  });

  it.each(["/workspace/report.txt", "/./workspace/report.txt", "//workspace/report.txt"])(
    "rejects the canonical workspace path %s in system scope before making a request",
    async (path) => {
      await expect(
        downloadBackofficeFile({
          baseUrl: "https://backoffice.invalid",
          scope: { kind: "system" },
          path,
        }),
      ).rejects.toThrow("system scope does not have a /workspace filesystem");
    },
  );
});

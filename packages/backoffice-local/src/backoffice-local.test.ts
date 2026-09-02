import { describe, expect, it } from "vitest";

import {
  downloadBackofficeFile,
  listBackofficeAvailableScopes,
  parseBackofficeScope,
  resolveDefaultBackofficeScope,
  uploadBackofficeWorkspaceFile,
} from "./backoffice-local.js";

describe("parseBackofficeScope", () => {
  it("parses encoded organization slugs and project identifiers", () => {
    expect(parseBackofficeScope("org:acme")).toEqual({
      kind: "org",
      orgSlug: "acme",
    });
    expect(parseBackofficeScope("project:org%2Fone:project%3Atwo")).toEqual({
      kind: "project",
      orgSlug: "org/one",
      projectId: "project:two",
    });
  });

  it("rejects unsupported scope shapes", () => {
    expect(() => parseBackofficeScope("project:missing-project")).toThrow(
      "Invalid Backoffice scope",
    );
  });
});

describe("listBackofficeAvailableScopes", () => {
  it("presents organization scopes by slug and marks the active organization as default", () => {
    const me = {
      user: { id: "user-1", email: "admin@example.com", role: "admin" as const },
      activeOrganizationId: "org-1",
      organizations: [
        { organization: { id: "org-1", name: "Acme", slug: "acme" } },
        { organization: { id: "org-2", name: "Other", slug: "other" } },
      ],
    };

    expect(listBackofficeAvailableScopes(me)).toEqual([
      { argument: "org:acme", label: "Acme", isDefault: true },
      { argument: "org:other", label: "Other", isDefault: false },
      { argument: "user:user-1", label: "admin@example.com", isDefault: false },
      { argument: "system", label: "System administrator", isDefault: false },
    ]);
    expect(resolveDefaultBackofficeScope(me)).toEqual({ kind: "org", orgSlug: "acme" });
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

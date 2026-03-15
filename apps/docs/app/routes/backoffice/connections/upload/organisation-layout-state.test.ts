import { describe, expect, test } from "vitest";

import { resolveUploadWorkspaceTab } from "./organisation-layout-state";

describe("resolveUploadWorkspaceTab", () => {
  test("selects the files tab for the uploads alias route", () => {
    expect(
      resolveUploadWorkspaceTab(["backoffice", "connections", "upload", "org_123", "uploads"]),
    ).toBe("files");
  });

  test("selects the files tab for the files route", () => {
    expect(
      resolveUploadWorkspaceTab(["backoffice", "connections", "upload", "org_123", "files"]),
    ).toBe("files");
  });

  test("falls back to the configuration tab otherwise", () => {
    expect(
      resolveUploadWorkspaceTab([
        "backoffice",
        "connections",
        "upload",
        "org_123",
        "configuration",
      ]),
    ).toBe("configuration");
  });

  test("does not match an org slug that happens to be 'files'", () => {
    expect(
      resolveUploadWorkspaceTab(["backoffice", "connections", "upload", "files", "configuration"]),
    ).toBe("configuration");
  });

  test("does not match deeper child segments outside the workspace slot", () => {
    expect(
      resolveUploadWorkspaceTab([
        "backoffice",
        "connections",
        "upload",
        "org_123",
        "configuration",
        "files",
      ]),
    ).toBe("configuration");
  });
});

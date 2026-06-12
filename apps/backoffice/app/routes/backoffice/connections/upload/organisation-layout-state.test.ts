import { describe, test, assert } from "vitest";

import { resolveUploadWorkspaceTab } from "./organisation-layout-state";

describe("resolveUploadWorkspaceTab", () => {
  test("selects the files tab for the uploads alias route", () => {
    assert(
      resolveUploadWorkspaceTab(["backoffice", "connections", "upload", "org_123", "uploads"]) ===
        "files",
    );
  });

  test("selects the files tab for the files route", () => {
    assert(
      resolveUploadWorkspaceTab(["backoffice", "connections", "upload", "org_123", "files"]) ===
        "files",
    );
  });

  test("falls back to the configuration tab otherwise", () => {
    assert(
      resolveUploadWorkspaceTab([
        "backoffice",
        "connections",
        "upload",
        "org_123",
        "configuration",
      ]) === "configuration",
    );
  });

  test("does not match an org slug that happens to be 'files'", () => {
    assert(
      resolveUploadWorkspaceTab([
        "backoffice",
        "connections",
        "upload",
        "files",
        "configuration",
      ]) === "configuration",
    );
  });

  test("does not match deeper child segments outside the workspace slot", () => {
    assert(
      resolveUploadWorkspaceTab([
        "backoffice",
        "connections",
        "upload",
        "org_123",
        "configuration",
        "files",
      ]) === "configuration",
    );
  });
});

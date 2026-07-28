import { describe, expect, test } from "vitest";

import { summarizeInstalledWorkspace } from "./installed-state";

describe("Installed Marketplace workspace state", () => {
  test("shows one empty state only after every organization reports no records", () => {
    expect(
      summarizeInstalledWorkspace({
        sourceOrganizationIds: ["org-1", "org-2"],
        snapshots: {
          "org-1": { status: "ready", recordCount: 0 },
          "org-2": { status: "ready", recordCount: 0 },
        },
      }),
    ).toEqual({ isLoading: false, showEmpty: true, totalRecordCount: 0 });
  });

  test("does not show an empty state beside records from another organization", () => {
    expect(
      summarizeInstalledWorkspace({
        sourceOrganizationIds: ["org-1", "org-2"],
        snapshots: {
          "org-1": { status: "ready", recordCount: 0 },
          "org-2": { status: "ready", recordCount: 1 },
        },
      }),
    ).toEqual({ isLoading: false, showEmpty: false, totalRecordCount: 1 });
  });

  test("does not report a synchronization failure as an empty workspace", () => {
    expect(
      summarizeInstalledWorkspace({
        sourceOrganizationIds: ["org-1"],
        snapshots: {
          "org-1": { status: "error", recordCount: 0 },
        },
      }),
    ).toEqual({ isLoading: false, showEmpty: false, totalRecordCount: 0 });
  });

  test("keeps the workspace loading until every organization reports", () => {
    expect(
      summarizeInstalledWorkspace({
        sourceOrganizationIds: ["org-1", "org-2"],
        snapshots: {
          "org-1": { status: "ready", recordCount: 0 },
        },
      }),
    ).toEqual({ isLoading: true, showEmpty: false, totalRecordCount: 0 });
  });
});

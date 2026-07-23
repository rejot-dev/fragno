import { describe, expect, test } from "vitest";

import { createUploadDirectoryMarkerMetadata } from "@/files/contributors/upload-markers";
import type { UploadFileRecord } from "@/fragno/upload/file-record";

import { buildUploadWorkspaceScriptRecords } from "./script-records";

const file = (input: Partial<UploadFileRecord> & Pick<UploadFileRecord, "fileKey">) =>
  ({
    provider: "database",
    status: "ready",
    sizeBytes: 1,
    filename: input.fileKey.split("/").at(-1) ?? input.fileKey,
    contentType: "text/javascript",
    ...input,
  }) satisfies UploadFileRecord;

describe("automation script records", () => {
  test("derives workspace scripts from synchronized Upload file metadata", () => {
    const scripts = buildUploadWorkspaceScriptRecords([
      file({ fileKey: "automations/nested/cleanup.cm.js" }),
      file({ fileKey: "automations/setup.workflow.js" }),
      file({ fileKey: "notes/readme.txt" }),
      file({ provider: "r2", fileKey: "automations/remote.sh" }),
      file({
        fileKey: "automations/empty/.fragno/dir-marker",
        contentType: "application/x.fragno-directory-marker",
        metadata: createUploadDirectoryMarkerMetadata(),
      }),
    ]);

    expect(scripts).toEqual([
      expect.objectContaining({
        id: "automation-script:workspace:nested/cleanup.cm.js",
        key: "nested/cleanup.cm",
        name: "Nested Cleanup Cm",
        engine: "codemode",
        layer: "workspace",
        path: "nested/cleanup.cm.js",
        absolutePath: "/workspace/automations/nested/cleanup.cm.js",
        enabled: true,
      }),
      expect.objectContaining({
        id: "automation-script:workspace:setup.workflow.js",
        key: "setup.workflow",
        engine: "bash",
        path: "setup.workflow.js",
        enabled: false,
      }),
    ]);
  });
});

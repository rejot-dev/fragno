import { describe, expect, it, assert } from "vitest";

import { createUploadDirectoryMarkerMetadata } from "@/files/contributors/upload-markers";
import type { UploadFileRecord } from "@/fragno/upload/file-record";

import {
  buildLocalUploadExplorer,
  getLocalUploadDetail,
  type UploadExplorerMount,
} from "./upload-local-tree";

const workspaceMount: UploadExplorerMount = {
  id: "workspace",
  kind: "upload",
  mountPoint: "/workspace",
  title: "Workspace",
  readOnly: false,
  persistence: "persistent",
  uploadProvider: "database",
};

const file = (input: Partial<UploadFileRecord> & Pick<UploadFileRecord, "fileKey">) =>
  ({
    provider: "database",
    status: "ready",
    sizeBytes: 42,
    filename: input.fileKey.split("/").at(-1) ?? input.fileKey,
    contentType: "application/octet-stream",
    ...input,
  }) satisfies UploadFileRecord;

describe("local Upload files explorer", () => {
  it("builds files and explicit empty folders from synchronized metadata", () => {
    const explorer = buildLocalUploadExplorer(
      [workspaceMount],
      [
        file({
          fileKey: "automations/.fragno/dir-marker",
          filename: "dir-marker",
          contentType: "application/x.fragno-directory-marker",
          metadata: createUploadDirectoryMarkerMetadata(),
        }),
        file({ fileKey: "automations/pi-default-agent-configure.workflow.js" }),
        file({ provider: "r2", fileKey: "ignored.txt" }),
      ],
      "org-1",
    );

    expect(explorer.roots).toHaveLength(1);
    expect(explorer.roots[0].children?.map((node) => node.path)).toEqual([
      "/workspace/automations/",
    ]);
    expect(explorer.roots[0].children?.[0].children?.map((node) => node.path)).toEqual([
      "/workspace/automations/pi-default-agent-configure.workflow.js",
    ]);
  });

  it("creates local metadata details while keeping file content separate", () => {
    const explorer = buildLocalUploadExplorer(
      [workspaceMount],
      [file({ fileKey: "automations/pi-default-agent-configure.workflow.js" })],
      "org-1",
    );

    const detail = getLocalUploadDetail(
      explorer,
      "/workspace/automations/pi-default-agent-configure.workflow.js",
      "export default {};",
    );

    expect(detail).toMatchObject({
      node: {
        kind: "file",
        contentType: "text/javascript",
      },
      textContent: "export default {};",
      metadata: {
        provider: "database",
        fileKey: "automations/pi-default-agent-configure.workflow.js",
      },
    });
    assert(
      detail?.metadata?.previewUrl ===
        "/api/upload/org-1/files/by-key/content?provider=database&key=automations%2Fpi-default-agent-configure.workflow.js",
    );
  });
});

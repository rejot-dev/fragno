import { describe, expect, it, assert } from "vitest";

import type { TelegramAttachment } from "@fragno-dev/telegram-fragment";

import {
  buildTelegramAttachmentDownloadPath,
  buildTelegramAttachmentInlinePath,
  getTelegramAttachmentDownloadFileId,
  getTelegramAttachmentOriginalFilename,
} from "./attachment-paths";

describe("telegram attachment path helpers", () => {
  it("prefers the largest photo variant for downloads", () => {
    const attachment: TelegramAttachment = {
      kind: "photo",
      fileId: "photo-small",
      fileUniqueId: "photo-small-unique",
      width: 90,
      height: 90,
      sizes: [
        {
          fileId: "photo-small",
          fileUniqueId: "photo-small-unique",
          width: 90,
          height: 90,
        },
        {
          fileId: "photo-large",
          fileUniqueId: "photo-large-unique",
          width: 1280,
          height: 960,
        },
      ],
    };

    assert(getTelegramAttachmentDownloadFileId(attachment) === "photo-large");
    expect(buildTelegramAttachmentDownloadPath("org_123", attachment)).toContain(
      "fileId=photo-large",
    );
  });

  it("preserves original filenames for downloadable attachments", () => {
    const attachment: TelegramAttachment = {
      kind: "document",
      fileId: "document-file-1",
      fileUniqueId: "document-unique-1",
      fileName: "Quarterly Report.pdf",
      mimeType: "application/pdf",
    };

    assert(getTelegramAttachmentOriginalFilename(attachment) === "Quarterly Report.pdf");

    const downloadUrl = new URL(
      `https://example.com${buildTelegramAttachmentDownloadPath("org_123", attachment)}`,
    );
    assert(downloadUrl.searchParams.get("filename") === "Quarterly Report.pdf");

    const inlineUrl = new URL(
      `https://example.com${buildTelegramAttachmentInlinePath("org_123", attachment)}`,
    );
    assert(inlineUrl.searchParams.get("filename") === "Quarterly Report.pdf");
    assert(inlineUrl.searchParams.get("disposition") === "inline");
  });
});

import { describe, expect, it } from "vitest";

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

    expect(getTelegramAttachmentDownloadFileId(attachment)).toBe("photo-large");
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

    expect(getTelegramAttachmentOriginalFilename(attachment)).toBe("Quarterly Report.pdf");

    const downloadUrl = new URL(
      `https://example.com${buildTelegramAttachmentDownloadPath("org_123", attachment)}`,
    );
    expect(downloadUrl.searchParams.get("filename")).toBe("Quarterly Report.pdf");

    const inlineUrl = new URL(
      `https://example.com${buildTelegramAttachmentInlinePath("org_123", attachment)}`,
    );
    expect(inlineUrl.searchParams.get("filename")).toBe("Quarterly Report.pdf");
    expect(inlineUrl.searchParams.get("disposition")).toBe("inline");
  });
});

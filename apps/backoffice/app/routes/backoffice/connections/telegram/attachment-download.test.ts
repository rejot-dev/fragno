import { beforeEach, describe, expect, it, vi } from "vitest";

const { getAuthMeMock, getTelegramDurableObjectMock } = vi.hoisted(() => ({
  getAuthMeMock: vi.fn(),
  getTelegramDurableObjectMock: vi.fn(),
}));

vi.mock("@/fragno/auth/auth-server", () => ({
  getAuthMe: getAuthMeMock,
}));

vi.mock("@/cloudflare/cloudflare-utils", () => ({
  getTelegramDurableObject: getTelegramDurableObjectMock,
}));

import { buildBackofficeLoginPath } from "../../auth-navigation";
import {
  buildDownloadFilename,
  createContentDisposition,
  guessContentType,
  loader,
} from "./attachment-download";

describe("telegram attachment download route", () => {
  beforeEach(() => {
    getAuthMeMock.mockReset();
    getTelegramDurableObjectMock.mockReset();
  });

  it("redirects anonymous users to login", async () => {
    getAuthMeMock.mockResolvedValue(null);

    const response = await loader(
      createLoaderArgs(
        "https://example.com/backoffice/connections/telegram/org_123/attachment-download?fileId=file-1&kind=voice",
      ),
    );

    expect(response).toBeInstanceOf(Response);
    expect(response.status).toBe(302);
    expect(response.headers.get("Location")).toBe(
      `https://example.com${buildBackofficeLoginPath("/backoffice/connections/telegram/org_123/attachment-download?fileId=file-1&kind=voice")}`,
    );
  });

  it("downloads Telegram attachment bytes with a file-path-derived filename", async () => {
    getAuthMeMock.mockResolvedValue(createAuthMe());
    getTelegramDurableObjectMock.mockReturnValue({
      getAutomationFile: vi.fn(async () => ({
        fileId: "file-1",
        fileUniqueId: "unique-1",
        filePath: "voice/message-1.ogg",
        fileSize: 4,
      })),
      downloadAutomationFile: vi.fn(async () => new Response(new Uint8Array([0, 255, 1, 2]))),
    });

    const response = await loader(
      createLoaderArgs(
        "https://example.com/backoffice/connections/telegram/org_123/attachment-download?fileId=file-1&kind=voice",
      ),
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("audio/ogg");
    expect(response.headers.get("content-disposition")).toContain(
      'attachment; filename="message-1.ogg"',
    );
    const body = new Uint8Array(await response.arrayBuffer());
    expect(body).toEqual(new Uint8Array([0, 255, 1, 2]));
  });

  it("prefers the original filename from the backoffice attachment when available", async () => {
    getAuthMeMock.mockResolvedValue(createAuthMe());
    getTelegramDurableObjectMock.mockReturnValue({
      getAutomationFile: vi.fn(async () => ({
        fileId: "file-1",
        fileUniqueId: "unique-1",
        filePath: "documents/file_123",
        fileSize: 3,
      })),
      downloadAutomationFile: vi.fn(async () => new Response(new Uint8Array([7, 8, 9]))),
    });

    const response = await loader(
      createLoaderArgs(
        "https://example.com/backoffice/connections/telegram/org_123/attachment-download?fileId=file-1&kind=document&filename=Quarterly%20Report.pdf",
      ),
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("content-disposition")).toContain(
      'attachment; filename="Quarterly Report.pdf"',
    );
    expect(response.headers.get("content-type")).toBe("application/pdf");
  });

  it("falls back to the attachment kind when Telegram metadata lacks a file path", async () => {
    getAuthMeMock.mockResolvedValue(createAuthMe());
    getTelegramDurableObjectMock.mockReturnValue({
      getAutomationFile: vi.fn(async () => ({
        fileId: "file/with spaces",
        fileUniqueId: "unique-1",
        filePath: undefined,
        fileSize: 3,
      })),
      downloadAutomationFile: vi.fn(async () => new Response(new Uint8Array([1, 2, 3]))),
    });

    const response = await loader(
      createLoaderArgs(
        "https://example.com/backoffice/connections/telegram/org_123/attachment-download?fileId=file%2Fwith%20spaces&kind=voice",
      ),
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("content-disposition")).toContain(
      'attachment; filename="file-with-spaces.ogg"',
    );
    expect(response.headers.get("content-type")).toBe("audio/ogg");
  });

  it("serves inline disposition when requested for previews", async () => {
    getAuthMeMock.mockResolvedValue(createAuthMe());
    getTelegramDurableObjectMock.mockReturnValue({
      getAutomationFile: vi.fn(async () => ({
        fileId: "file-1",
        fileUniqueId: "unique-1",
        filePath: "photos/thumb.jpg",
        fileSize: 4,
      })),
      downloadAutomationFile: vi.fn(async () => new Response(new Uint8Array([1, 2, 3, 4]))),
    });

    const response = await loader(
      createLoaderArgs(
        "https://example.com/backoffice/connections/telegram/org_123/attachment-download?fileId=file-1&kind=photo&disposition=inline",
      ),
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("content-disposition")).toContain('inline; filename="thumb.jpg"');
    expect(response.headers.get("content-type")).toBe("image/jpeg");
  });

  it("returns 404 for users outside the organisation", async () => {
    getAuthMeMock.mockResolvedValue({
      ...createAuthMe(),
      organizations: [],
    });

    await expect(
      loader(
        createLoaderArgs(
          "https://example.com/backoffice/connections/telegram/org_123/attachment-download?fileId=file-1&kind=voice",
        ),
      ),
    ).rejects.toMatchObject({
      status: 404,
    });
  });

  it("exposes filename and content-type helpers for attachment rendering", () => {
    expect(buildDownloadFilename(undefined, "photos/picture.jpg", "file-1", "photo")).toBe(
      "picture.jpg",
    );
    expect(
      buildDownloadFilename("Quarterly Report.pdf", "documents/file_123", "file-1", "document"),
    ).toBe("Quarterly Report.pdf");
    expect(buildDownloadFilename(undefined, undefined, "file 1", "voice")).toBe("file-1.ogg");
    expect(guessContentType("picture.jpg", "photo")).toBe("image/jpeg");
    expect(guessContentType("voice-note.ogg", "voice")).toBe("audio/ogg");
    expect(createContentDisposition("voice-note.ogg", "inline")).toContain(
      'inline; filename="voice-note.ogg"',
    );
  });
});

const createLoaderArgs = (url: string) =>
  ({
    request: new Request(url),
    context: {} as never,
    params: { orgId: "org_123" },
  }) as Parameters<typeof loader>[0];

const createAuthMe = () => ({
  user: { id: "user_123", email: "dev@fragno.test", role: "admin" },
  organizations: [
    {
      organization: { id: "org_123", name: "Fragno" },
      member: { organizationId: "org_123" },
    },
  ],
  activeOrganization: {
    organization: { id: "org_123", name: "Fragno" },
    member: { organizationId: "org_123" },
  },
  invitations: [],
});

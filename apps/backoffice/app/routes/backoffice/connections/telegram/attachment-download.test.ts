import { beforeEach, describe, expect, it, vi, assert } from "vitest";

const { getAuthMeMock, getTelegramDurableObjectMock } = vi.hoisted(() => ({
  getAuthMeMock: vi.fn(),
  getTelegramDurableObjectMock: vi.fn(),
}));

vi.mock("@/fragno/auth/auth-server", () => ({
  getAuthMe: getAuthMeMock,
}));

vi.mock("@/worker-runtime/durable-objects", () => ({
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
        "https://example.com/backoffice/automations/org/org_123/integrations/telegram/attachment-download?fileId=file-1&kind=voice",
      ),
    );

    expect(response).toBeInstanceOf(Response);
    assert(response.status === 302);
    expect(response.headers.get("Location")).toBe(
      `https://example.com${buildBackofficeLoginPath("/backoffice/automations/org/org_123/integrations/telegram/attachment-download?fileId=file-1&kind=voice")}`,
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
        "https://example.com/backoffice/automations/org/org_123/integrations/telegram/attachment-download?fileId=file-1&kind=voice",
      ),
    );

    assert(response.status === 200);
    assert(response.headers.get("content-type") === "audio/ogg");
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
        "https://example.com/backoffice/automations/org/org_123/integrations/telegram/attachment-download?fileId=file-1&kind=document&filename=Quarterly%20Report.pdf",
      ),
    );

    assert(response.status === 200);
    expect(response.headers.get("content-disposition")).toContain(
      'attachment; filename="Quarterly Report.pdf"',
    );
    assert(response.headers.get("content-type") === "application/pdf");
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
        "https://example.com/backoffice/automations/org/org_123/integrations/telegram/attachment-download?fileId=file%2Fwith%20spaces&kind=voice",
      ),
    );

    assert(response.status === 200);
    expect(response.headers.get("content-disposition")).toContain(
      'attachment; filename="file-with-spaces.ogg"',
    );
    assert(response.headers.get("content-type") === "audio/ogg");
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
        "https://example.com/backoffice/automations/org/org_123/integrations/telegram/attachment-download?fileId=file-1&kind=photo&disposition=inline",
      ),
    );

    assert(response.status === 200);
    expect(response.headers.get("content-disposition")).toContain('inline; filename="thumb.jpg"');
    assert(response.headers.get("content-type") === "image/jpeg");
  });

  it("returns 404 for users outside the organisation", async () => {
    getAuthMeMock.mockResolvedValue({
      ...createAuthMe(),
      organizations: [],
    });

    await expect(
      loader(
        createLoaderArgs(
          "https://example.com/backoffice/automations/org/org_123/integrations/telegram/attachment-download?fileId=file-1&kind=voice",
        ),
      ),
    ).rejects.toMatchObject({
      status: 404,
    });
  });

  it("exposes filename and content-type helpers for attachment rendering", () => {
    assert(
      buildDownloadFilename(undefined, "photos/picture.jpg", "file-1", "photo") === "picture.jpg",
    );
    assert(
      buildDownloadFilename("Quarterly Report.pdf", "documents/file_123", "file-1", "document") ===
        "Quarterly Report.pdf",
    );
    assert(buildDownloadFilename(undefined, undefined, "file 1", "voice") === "file-1.ogg");
    assert(guessContentType("picture.jpg", "photo") === "image/jpeg");
    assert(guessContentType("voice-note.ogg", "voice") === "audio/ogg");
    expect(createContentDisposition("voice-note.ogg", "inline")).toContain(
      'inline; filename="voice-note.ogg"',
    );
  });
});

const createLoaderArgs = (url: string) =>
  ({
    request: new Request(url),
    url: new URL(url),
    pattern:
      "/backoffice/automations/:scopeKind/:scopeId/integrations/telegram/attachment-download",
    context: {
      get: () => ({
        runtime: {
          objects: {
            telegram: {
              for: () => getTelegramDurableObjectMock(),
            },
          },
        },
      }),
    } as never,
    params: { scopeKind: "org", scopeId: "org_123" },
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

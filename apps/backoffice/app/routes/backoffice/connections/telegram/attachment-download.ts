import type { RouterContextProvider } from "react-router";

import { getTelegramDurableObject } from "@/cloudflare/cloudflare-utils";
import { getAuthMe } from "@/fragno/auth/auth-server";

import { buildBackofficeLoginPath } from "../../auth-navigation";

const DEFAULT_DOWNLOAD_NAME = "telegram-attachment";

export async function loader({
  request,
  params,
  context,
}: {
  request: Request;
  params: { orgId?: string };
  context: Readonly<RouterContextProvider>;
}) {
  if (!params.orgId) {
    throw new Response("Not Found", { status: 404 });
  }

  const requestUrl = new URL(request.url);
  const fileId = requestUrl.searchParams.get("fileId")?.trim() ?? "";
  const attachmentKind = requestUrl.searchParams.get("kind")?.trim() ?? "";
  const requestedFilename = requestUrl.searchParams.get("filename")?.trim() ?? "";
  const disposition =
    requestUrl.searchParams.get("disposition") === "inline" ? "inline" : "attachment";
  if (!fileId) {
    throw new Response("Missing Telegram file id.", { status: 400 });
  }

  const returnTo = `${requestUrl.pathname}${requestUrl.search}`;
  const me = await getAuthMe(request, context);
  if (!me?.user) {
    return Response.redirect(new URL(buildBackofficeLoginPath(returnTo), request.url), 302);
  }

  const organisation =
    me.organizations.find((entry) => entry.organization.id === params.orgId)?.organization ?? null;
  if (!organisation) {
    throw new Response("Not Found", { status: 404 });
  }

  const telegramDo = getTelegramDurableObject(context, params.orgId);
  const metadata = await telegramDo.getAutomationFile({ fileId });
  const downloadResponse = await telegramDo.downloadAutomationFile({ fileId });
  const filename = buildDownloadFilename(
    requestedFilename,
    metadata.filePath,
    fileId,
    attachmentKind,
  );
  const contentLength =
    downloadResponse.headers.get("content-length") ??
    (metadata.fileSize != null ? String(metadata.fileSize) : null);

  return new Response(downloadResponse.body, {
    status: 200,
    headers: {
      "content-type": guessContentType(filename, attachmentKind),
      ...(contentLength ? { "content-length": contentLength } : {}),
      "content-disposition": createContentDisposition(filename, disposition),
      "cache-control": "no-store",
    },
  });
}

const readFilenameLeaf = (value: string | null | undefined): string | null => {
  const trimmed = value?.trim();
  if (!trimmed) {
    return null;
  }

  return (
    trimmed
      .split(/[\\/]+/)
      .filter(Boolean)
      .at(-1)
      ?.trim() ?? null
  );
};

const buildDownloadFilename = (
  requestedFilename: string | null | undefined,
  filePath: string | null | undefined,
  fileId: string,
  attachmentKind: string,
): string => {
  const fileNameFromRequest = readFilenameLeaf(requestedFilename);
  if (fileNameFromRequest) {
    return fileNameFromRequest;
  }

  const fileNameFromPath = readFilenameLeaf(filePath);
  if (fileNameFromPath) {
    return fileNameFromPath;
  }

  const safeFileId = fileId.replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/^-+|-+$/g, "");
  const fallbackBase = safeFileId || DEFAULT_DOWNLOAD_NAME;
  const fallbackExtension = guessExtension(attachmentKind);

  return fallbackExtension ? `${fallbackBase}.${fallbackExtension}` : fallbackBase;
};

const guessExtension = (attachmentKind: string): string | null => {
  switch (attachmentKind) {
    case "photo":
      return "jpg";
    case "voice":
      return "ogg";
    case "audio":
      return "mp3";
    case "video":
    case "video_note":
      return "mp4";
    case "animation":
      return "gif";
    case "sticker":
      return "webp";
    default:
      return null;
  }
};

const guessContentType = (filename: string, attachmentKind: string): string => {
  if (/\.jpe?g$/i.test(filename)) {
    return "image/jpeg";
  }
  if (/\.png$/i.test(filename)) {
    return "image/png";
  }
  if (/\.gif$/i.test(filename)) {
    return "image/gif";
  }
  if (/\.webp$/i.test(filename)) {
    return "image/webp";
  }
  if (/\.ogg$/i.test(filename)) {
    return "audio/ogg";
  }
  if (/\.mp3$/i.test(filename)) {
    return "audio/mpeg";
  }
  if (/\.wav$/i.test(filename)) {
    return "audio/wav";
  }
  if (/\.m4a$/i.test(filename)) {
    return "audio/mp4";
  }
  if (/\.mp4$/i.test(filename)) {
    return attachmentKind === "video" || attachmentKind === "video_note"
      ? "video/mp4"
      : "application/octet-stream";
  }
  if (/\.pdf$/i.test(filename)) {
    return "application/pdf";
  }

  if (attachmentKind === "photo") {
    return "image/jpeg";
  }
  if (attachmentKind === "voice") {
    return "audio/ogg";
  }
  if (attachmentKind === "audio") {
    return "audio/mpeg";
  }
  if (attachmentKind === "video" || attachmentKind === "video_note") {
    return "video/mp4";
  }
  if (attachmentKind === "animation") {
    return "image/gif";
  }
  if (attachmentKind === "sticker") {
    return "image/webp";
  }

  return "application/octet-stream";
};

const createContentDisposition = (
  filename: string,
  disposition: "inline" | "attachment" = "attachment",
) => {
  const safeFilename = filename || DEFAULT_DOWNLOAD_NAME;
  const sanitizedFilename = safeFilename.replace(/[\r\n"]/g, "_") || DEFAULT_DOWNLOAD_NAME;
  const encodedFilename = encodeURIComponent(safeFilename);
  return `${disposition}; filename="${sanitizedFilename}"; filename*=UTF-8''${encodedFilename}`;
};

export { buildDownloadFilename, createContentDisposition, guessContentType };

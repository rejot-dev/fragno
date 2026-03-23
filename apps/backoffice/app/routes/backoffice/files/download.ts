import { getAuthMe } from "@/fragno/auth/auth-server";

import { buildBackofficeLoginPath } from "../auth-navigation";
import type { Route } from "./+types/download";
import { createBackofficeFilesFileSystem } from "./data";

export const MAX_BUFFERED_DOWNLOAD_BYTES = 10 * 1024 * 1024;

export async function loader({ request, params, context }: Route.LoaderArgs) {
  if (!params.orgId) {
    throw new Response("Not Found", { status: 404 });
  }

  const requestUrl = new URL(request.url);
  const path = requestUrl.searchParams.get("path")?.trim() ?? "";
  if (!path) {
    throw new Response("Missing file path.", { status: 400 });
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

  const fileSystem = await createBackofficeFilesFileSystem({
    request,
    context,
    orgId: params.orgId,
  });

  let stat: Awaited<ReturnType<typeof fileSystem.stat>>;
  try {
    stat = await fileSystem.stat(path);
  } catch (error) {
    if (isNotFoundError(error)) {
      throw new Response("File not found.", { status: 404 });
    }
    throw error;
  }

  if (!stat.isFile) {
    throw new Response("Only files can be downloaded.", { status: 400 });
  }

  const filename = path.split("/").filter(Boolean).at(-1) ?? "download";
  const contentType = guessContentType(filename);
  const { body, contentLength } = await readDownloadBody(fileSystem, path, stat.size);

  return new Response(body, {
    status: 200,
    headers: {
      "content-type": contentType,
      "content-length": String(contentLength),
      "content-disposition": createAttachmentDisposition(filename),
      "cache-control": "no-store",
    },
  });
}

const readDownloadBody = async (
  fileSystem: Awaited<ReturnType<typeof createBackofficeFilesFileSystem>>,
  path: string,
  size: number,
): Promise<{
  body: ArrayBuffer | ReadableStream<Uint8Array>;
  contentLength: number;
}> => {
  try {
    return {
      body: await fileSystem.readFileStream(path),
      contentLength: size,
    };
  } catch (error) {
    if (isNotFoundError(error)) {
      throw new Response("File not found.", { status: 404 });
    }

    if (!isUnsupportedOperationError(error)) {
      throw error;
    }
  }

  if (size > MAX_BUFFERED_DOWNLOAD_BYTES) {
    throw new Response("File is too large to buffer for download.", { status: 413 });
  }

  let bytes: Awaited<ReturnType<typeof fileSystem.readFileBuffer>>;
  try {
    bytes = await fileSystem.readFileBuffer(path);
  } catch (error) {
    if (isNotFoundError(error)) {
      throw new Response("File not found.", { status: 404 });
    }
    throw error;
  }

  const body = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(body).set(bytes);

  return {
    body,
    contentLength: bytes.byteLength,
  };
};

const isNotFoundError = (error: unknown): boolean => {
  if (error instanceof Response) {
    return error.status === 404;
  }

  if (!(error instanceof Error)) {
    return false;
  }

  const errorCode = (error as Error & { code?: unknown }).code;
  if (errorCode === "ENOENT") {
    return true;
  }

  return (
    /ENOENT|no such file or directory/i.test(error.message) ||
    /^file not found\.?$/i.test(error.message) ||
    /^path not found\.?$/i.test(error.message) ||
    /^path '.+' was not found\.?$/i.test(error.message)
  );
};

const isUnsupportedOperationError = (error: unknown): boolean => {
  if (!(error instanceof Error)) {
    return false;
  }

  const errorCode = (error as Error & { code?: unknown }).code;
  if (errorCode === "ENOTSUP") {
    return true;
  }

  return /ENOTSUP|operation not supported/i.test(error.message);
};

const createAttachmentDisposition = (filename: string) => {
  const sanitizedFilename = filename.replace(/[\r\n"]/g, "_") || "download";
  const encodedFilename = encodeURIComponent(filename || "download");
  return `attachment; filename="${sanitizedFilename}"; filename*=UTF-8''${encodedFilename}`;
};

const guessContentType = (filename: string): string => {
  if (/\.(md|mdx)$/i.test(filename)) {
    return "text/markdown; charset=utf-8";
  }
  if (/\.json$/i.test(filename)) {
    return "application/json; charset=utf-8";
  }
  if (/\.(txt|log|yml|yaml|ts|tsx|js|jsx|mjs|cjs|css|html|xml|sh)$/i.test(filename)) {
    return "text/plain; charset=utf-8";
  }
  return "application/octet-stream";
};

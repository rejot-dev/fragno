import { backofficeRuntimeScopeFromResolvedScope } from "@/backoffice-runtime/resolved-scope";
import { inferFileContentType } from "@/file-collection/file-content-type";
import { requireScopeSelection } from "@/layouts/backoffice-shell-request.server";

import type { Route } from "./+types/download";
import { createFilesOverviewCollections } from "./file-collections.server";

export async function loader({ request, context, url }: Route.LoaderArgs) {
  const path = url.searchParams.get("path")?.trim() ?? "";
  if (!path) {
    throw new Response("Missing file path.", { status: 400 });
  }

  const scope = backofficeRuntimeScopeFromResolvedScope(requireScopeSelection(context));
  const registrations = await createFilesOverviewCollections({ request, context, scope });
  const target = registrations.find(
    (registration) => path.startsWith(`${registration.rootPath}/`) && !path.endsWith("/"),
  );
  if (!target) {
    throw new Response("File not found.", { status: 404 });
  }

  const relativePath = path.slice(target.rootPath.length + 1);
  const content = await target.collection.getFile(relativePath);
  if (!content) {
    throw new Response("File not found.", { status: 404 });
  }

  const filename = relativePath.split("/").at(-1) ?? "download";
  const contentType = content.contentType ?? guessContentType(filename);
  const headers = new Headers({
    "content-type": contentType,
    "content-disposition": createDisposition(
      url.searchParams.get("disposition") === "inline" && isImageContentType(contentType)
        ? "inline"
        : "attachment",
      filename,
    ),
    "cache-control": "no-store",
    // Inline SVGs opened directly would otherwise run scripts on the Backoffice origin.
    "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'; sandbox",
    "x-content-type-options": "nosniff",
  });
  if (content.sizeBytes !== null) {
    headers.set("content-length", String(content.sizeBytes));
  }

  return new Response(content.body, { headers });
}

const createDisposition = (disposition: "attachment" | "inline", filename: string) => {
  const sanitizedFilename = filename.replace(/[\r\n"]/g, "_") || "download";
  const encodedFilename = encodeURIComponent(filename || "download");
  return `${disposition}; filename="${sanitizedFilename}"; filename*=UTF-8''${encodedFilename}`;
};

const isImageContentType = (contentType: string) =>
  contentType.trimStart().toLowerCase().startsWith("image/");

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
  return inferFileContentType(filename);
};

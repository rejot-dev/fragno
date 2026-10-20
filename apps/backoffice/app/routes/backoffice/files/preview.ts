import { backofficeRuntimeScopeFromResolvedScope } from "@/backoffice-runtime/resolved-scope";
import { absoluteFilePathSchema } from "@/file-collection/absolute-file-path";
import { inferFileContentType } from "@/file-collection/file-content-type";
import { requireScopeSelection } from "@/layouts/backoffice-shell-request.server";
import { rasterImageContentType } from "@/lib/raster-image-content-type";

import type { Route } from "./+types/preview";
import { createFilesOverviewCollections } from "./file-collections.server";

export async function loader({ request, context, url }: Route.LoaderArgs) {
  const scope = backofficeRuntimeScopeFromResolvedScope(requireScopeSelection(context));
  const parsedPath = absoluteFilePathSchema.safeParse(url.searchParams.get("path"));
  if (!parsedPath.success) {
    throw new Response("A safe absolute file path is required.", { status: 400 });
  }
  const path = parsedPath.data;
  const registrations = await createFilesOverviewCollections({ request, context, scope });
  const target = registrations.find(({ rootPath }) => path.startsWith(`${rootPath}/`));
  const content = target
    ? await target.collection.getFile(path.slice(target.rootPath.length + 1))
    : null;
  if (!content) {
    throw new Response("File not found.", { status: 404 });
  }

  // Upload MIME metadata and filenames are user-controlled. Serve recognized raster bytes, and
  // markup only when the file declares itself SVG; the sandbox policy below keeps an SVG opened
  // directly from running scripts on this authenticated origin. Never serve HTML.
  const reader = content.body.getReader();
  const chunks: Uint8Array[] = [];
  const prefix = new Uint8Array(12);
  let prefixLength = 0;
  try {
    while (prefixLength < prefix.length) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }
      chunks.push(value);
      const part = value.subarray(0, prefix.length - prefixLength);
      prefix.set(part, prefixLength);
      prefixLength += part.length;
    }
  } catch (error) {
    await reader.cancel();
    throw error;
  }
  const contentType =
    rasterImageContentType(prefix.subarray(0, prefixLength)) ??
    svgImageContentType(
      content.contentType ?? inferFileContentType(path),
      prefix.subarray(0, prefixLength),
    );
  if (!contentType) {
    await reader.cancel();
    throw new Response("Only PNG, JPEG, GIF, WebP, and SVG images can be previewed.", {
      status: 415,
    });
  }

  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) {
        controller.enqueue(chunk);
      }
    },
    async pull(controller) {
      const { done, value } = await reader.read();
      if (done) {
        controller.close();
        reader.releaseLock();
      } else {
        controller.enqueue(value);
      }
    },
    cancel(reason) {
      return reader.cancel(reason);
    },
  });
  const headers = new Headers({
    "content-type": contentType,
    "content-disposition": "inline",
    "cache-control": "private, no-store",
    "x-content-type-options": "nosniff",
    // SVG images style themselves with inline styles; nothing else is loaded or run.
    "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'; sandbox",
    "cross-origin-resource-policy": "same-origin",
  });
  if (content.sizeBytes !== null) {
    headers.set("content-length", String(content.sizeBytes));
  }
  return new Response(body, { headers });
}

/** Markup that declares itself SVG; a file claiming another type never previews as SVG. */
function svgImageContentType(declaredContentType: string, prefix: Uint8Array): string | null {
  if (declaredContentType.split(";", 1)[0]?.trim().toLowerCase() !== "image/svg+xml") {
    return null;
  }
  const text = new TextDecoder("utf-8")
    .decode(prefix)
    .replace(/^\uFEFF/u, "")
    .trimStart();
  return text.startsWith("<") ? "image/svg+xml" : null;
}

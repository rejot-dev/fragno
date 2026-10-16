import { backofficeRuntimeScopeFromResolvedScope } from "@/backoffice-runtime/resolved-scope";
import { absoluteFilePathSchema } from "@/file-collection/absolute-file-path";
import { requireScopeSelection } from "@/layouts/backoffice-shell-request.server";

import type { Route } from "./+types/preview";
import { createFilesOverviewCollections } from "./file-collections.server";

export async function loader({ request, context, url }: Route.LoaderArgs) {
  const scope = backofficeRuntimeScopeFromResolvedScope(await requireScopeSelection(context));
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

  // Upload MIME metadata and filenames are user-controlled. Only serve recognized raster bytes,
  // never SVG/HTML, from this authenticated same-origin inline endpoint.
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
  const contentType = rasterImageContentType(prefix.subarray(0, prefixLength));
  if (!contentType) {
    await reader.cancel();
    throw new Response("Only PNG, JPEG, GIF, and WebP images can be previewed.", { status: 415 });
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
    "content-security-policy": "default-src 'none'; sandbox",
    "cross-origin-resource-policy": "same-origin",
  });
  if (content.sizeBytes !== null) {
    headers.set("content-length", String(content.sizeBytes));
  }
  return new Response(body, { headers });
}

function rasterImageContentType(prefix: Uint8Array): string | null {
  if ([137, 80, 78, 71, 13, 10, 26, 10].every((byte, index) => prefix[index] === byte)) {
    return "image/png";
  }
  if (prefix[0] === 255 && prefix[1] === 216 && prefix[2] === 255) {
    return "image/jpeg";
  }
  const signature = new TextDecoder("ascii").decode(prefix);
  if (signature.startsWith("GIF87a") || signature.startsWith("GIF89a")) {
    return "image/gif";
  }
  if (signature.startsWith("RIFF") && signature.slice(8, 12) === "WEBP") {
    return "image/webp";
  }
  return null;
}

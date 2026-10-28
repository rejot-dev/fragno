import { redirect } from "react-router";

import type { Route } from "./+types/large-files-download";
import {
  blobsFailure,
  openSelectedLargeFiles,
  refusalFailure,
  type LargeFilesFailure,
} from "./large-files.server";

/** Sends the browser to a short-lived storage URL, so the bytes never pass through Backoffice. */
export async function loader({ request, context, url }: Route.LoaderArgs) {
  const key = url.searchParams.get("key") ?? "";
  if (!key) {
    throw new Response("Missing large file key.", { status: 400 });
  }

  const largeFiles = await openSelectedLargeFiles({ request, context });
  if (largeFiles.status !== "available") {
    throw new Response("This scope has no large files.", { status: 404 });
  }

  let result: { url: string } | LargeFilesFailure;
  try {
    result = await largeFiles.files.read(async (blobs) => {
      const response = await blobs("GET", "/blobs/by-key/download-url", {
        query: { key },
      });
      return response.type === "json" ? response.data : blobsFailure(response);
    });
  } catch (error) {
    result = refusalFailure(error);
  }
  if (!("url" in result)) {
    throw new Response(result.message, { status: result.status });
  }
  return redirect(result.url, { headers: { "cache-control": "no-store" } });
}

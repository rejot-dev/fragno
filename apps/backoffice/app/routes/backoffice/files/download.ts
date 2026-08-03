import { getAuthMe } from "@/fragno/auth/auth-server";

import { buildBackofficeLoginPath } from "../auth-navigation";
import type { Route } from "./+types/download";
import { createFilesOverviewCollections } from "./file-collections.server";

export async function loader({ request, params, context, url }: Route.LoaderArgs) {
  if (!params.orgId) {
    throw new Response("Not Found", { status: 404 });
  }

  const path = url.searchParams.get("path")?.trim() ?? "";
  if (!path) {
    throw new Response("Missing file path.", { status: 400 });
  }

  const returnTo = `${url.pathname}${url.search}`;
  const me = await getAuthMe(request, context);
  if (!me?.user) {
    return Response.redirect(new URL(buildBackofficeLoginPath(returnTo), request.url), 302);
  }

  const organisation =
    me.organizations.find((entry) => entry.organization.id === params.orgId)?.organization ?? null;
  if (!organisation) {
    throw new Response("Not Found", { status: 404 });
  }

  const registrations = await createFilesOverviewCollections({
    request,
    context,
    orgId: params.orgId,
  });
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
  const headers = new Headers({
    "content-type": content.contentType ?? guessContentType(filename),
    "content-disposition": createAttachmentDisposition(filename),
    "cache-control": "no-store",
  });
  if (content.sizeBytes !== null) {
    headers.set("content-length", String(content.sizeBytes));
  }

  return new Response(content.body, { headers });
}

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

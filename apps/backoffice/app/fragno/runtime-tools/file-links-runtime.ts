import type { BackofficeRoutableScope } from "@fragno-dev/backoffice-api/v0/shared/scope";
import type { FileLink, FileLinkInput } from "@fragno-dev/backoffice-api/v0/state";
import { getStaticGlobPrefix } from "@fragno-dev/upload/text-index";
import { z } from "zod";

import type { FetchObject } from "@/backoffice-runtime/object-registry";
import { BackofficeOperationError } from "@/backoffice-runtime/operation-error";
import { backofficeContextScopeRoutePath } from "@/backoffice-runtime/scope-codec";
import { UPLOAD_PROVIDER_DATABASE } from "@/fragno/upload";

export type FileLinkRuntime = {
  createDownloadLink(input: FileLinkInput): Promise<FileLink>;
  createUploadLink(input: FileLinkInput): Promise<FileLink>;
};

const WORKSPACE_ROOT = "/workspace/";
const DEFAULT_FILE_LINK_SECONDS = 15 * 60;

const uploadErrorPayloadSchema = z.object({
  message: z.string().optional(),
  error: z.object({ message: z.string().optional() }).optional(),
});

/** Folders and wildcard paths link many files; any other path links exactly one file. */
function workspaceFileLinkTarget(path: string) {
  const workspacePath = path === "/workspace" ? WORKSPACE_ROOT : path;
  if (!workspacePath.startsWith(WORKSPACE_ROOT)) {
    throw new BackofficeOperationError("invalid_request", "File links address /workspace paths.");
  }
  const key = workspacePath.slice(WORKSPACE_ROOT.length);
  if (key === "" || key.endsWith("/")) {
    return { kind: "glob" as const, glob: `${key}**` };
  }
  return /[*?]/u.test(key)
    ? { kind: "glob" as const, glob: key }
    : { kind: "file" as const, fileKey: key };
}

/**
 * Links to one scope's workspace. They reach it through the `/api/file-links` route at the origin
 * sandboxes use, so a sandbox of any scope can move this scope's files.
 */
export function createFileLinkRuntime({
  uploadObject,
  scope,
  baseUrl,
}: {
  uploadObject: () => FetchObject;
  scope: BackofficeRoutableScope;
  baseUrl: string | null;
}): FileLinkRuntime {
  async function createLink(
    access: "read" | "write",
    { path, expiresInSeconds = DEFAULT_FILE_LINK_SECONDS }: FileLinkInput,
  ): Promise<FileLink> {
    if (!baseUrl) {
      throw new BackofficeOperationError(
        "operation_failed",
        "File links need DOCS_PUBLIC_BASE_URL to be configured.",
      );
    }
    const target = workspaceFileLinkTarget(path);
    const response = await uploadObject().fetch(
      new Request("https://upload.internal/api/upload/file-links", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          provider: UPLOAD_PROVIDER_DATABASE,
          access,
          target,
          expiresInSeconds,
        }),
      }),
    );
    if (!response.ok) {
      const payload = uploadErrorPayloadSchema.safeParse(await response.json().catch(() => null));
      throw new Error(
        (payload.success && (payload.data.message ?? payload.data.error?.message)) ||
          `Upload request failed (${response.status}).`,
      );
    }
    const { token, expiresAt } = z
      .object({ token: z.string(), expiresAt: z.iso.datetime() })
      .parse(await response.json());
    const url = new URL(
      `api/file-links/${backofficeContextScopeRoutePath(scope)}/${UPLOAD_PROVIDER_DATABASE}/${token}`,
      baseUrl,
    );
    return target.kind === "file"
      ? {
          format: "file",
          url: url.toString(),
          path: `${WORKSPACE_ROOT}${target.fileKey}`,
          expiresAt,
        }
      : {
          format: "tar",
          url: `${url}/archive.tar`,
          glob: `${WORKSPACE_ROOT}${target.glob}`,
          root: `${WORKSPACE_ROOT}${getStaticGlobPrefix(target.glob)}`,
          expiresAt,
        };
  }

  return {
    createDownloadLink: async (input) => await createLink("read", input),
    createUploadLink: async (input) => await createLink("write", input),
  };
}

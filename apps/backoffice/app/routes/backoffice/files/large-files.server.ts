import { BACKOFFICE_PERMISSION } from "@fragno-dev/backoffice-api/v0/shared/permissions";
import type { RouterContextProvider } from "react-router";

import type { BackofficeExecutionContext } from "@/backoffice-runtime/context";
import { isBackofficeForbiddenError } from "@/backoffice-runtime/kernel";
import { isBackofficeObjectAvailableInContext } from "@/backoffice-runtime/object-registry";
import { backofficeRuntimeScopeFromResolvedScope } from "@/backoffice-runtime/resolved-scope";
import { requireBackofficeContext } from "@/fragno/auth/backoffice-principal.server";
import { createBlobsRouteCaller, type BlobsRouteCaller } from "@/fragno/blobs-server";
import { requireScopeSelection } from "@/layouts/backoffice-shell-request.server";
import { BackofficeWorkerContext } from "@/worker-runtime/router-context";

/** Why a scope has no large files: none are configured, or the scope cannot hold them. */
export type LargeFilesUnavailable = "not-configured" | "scope";

/** The selected scope's large files, each operation authorized as the requesting person. */
export type LargeFiles = {
  read<T>(operation: (blobs: BlobsRouteCaller) => Promise<T>): Promise<T>;
  modify<T>(operation: (blobs: BlobsRouteCaller) => Promise<T>): Promise<T>;
  /** Whether the person may upload and delete, so the page hides what would be refused. */
  canModify(): Promise<boolean>;
};

/** A failed large-file request, with the HTTP status the route answers it with. */
export type LargeFilesFailure = { status: number; message: string };

/**
 * Large files are the scope's blobs, kept in its Blobs object. Routes call the Blobs routes
 * directly, so Blobs' statuses reach the browser: a missing blob stays a 404 and a storage
 * outage a 5xx.
 */
export function openLargeFiles(
  context: Readonly<RouterContextProvider>,
  execution: BackofficeExecutionContext,
): { status: "available"; files: LargeFiles } | { status: LargeFilesUnavailable } {
  const { runtime, kernel } = context.get(BackofficeWorkerContext);
  if (!runtime.config.bindings.blobs) {
    return { status: "not-configured" };
  }
  if (!isBackofficeObjectAvailableInContext("BLOBS", execution.scope)) {
    return { status: "scope" };
  }

  const blobs = () =>
    createBlobsRouteCaller(kernel.scoped("BLOBS", execution.scope, runtime.objects.blobs).http);
  return {
    status: "available",
    files: {
      read: (operation) =>
        kernel.invoke({
          execution,
          operation: BACKOFFICE_PERMISSION.upload.read,
          execute: () => operation(blobs()),
        }),
      modify: (operation) =>
        kernel.invoke({
          execution,
          operation: BACKOFFICE_PERMISSION.upload.modify,
          execute: () => operation(blobs()),
        }),
      canModify: async () => {
        try {
          await kernel.assertAuthorized({
            execution,
            operation: BACKOFFICE_PERMISSION.upload.modify,
          });
          return true;
        } catch (error) {
          if (isBackofficeForbiddenError(error)) {
            return false;
          }
          throw error;
        }
      },
    },
  };
}

/** The large files of the scope a Files page shows, as the signed-in person. */
export async function openSelectedLargeFiles({
  request,
  context,
}: {
  request: Request;
  context: Readonly<RouterContextProvider>;
}) {
  const scope = backofficeRuntimeScopeFromResolvedScope(requireScopeSelection(context));
  return openLargeFiles(context, await requireBackofficeContext(request, context, scope));
}

/** Why Blobs answered a request without its result. */
export function blobsFailure(
  response: { status: number } & (
    | { type: "error"; error: { message: string } }
    | { type: "empty" | "jsonStream" }
  ),
): LargeFilesFailure {
  return response.type === "error"
    ? { status: response.status, message: response.error.message }
    : { status: 502, message: `Blobs answered unexpectedly (${response.status}).` };
}

/** A refused operation; anything else thrown is a bug. */
export function refusalFailure(error: unknown): LargeFilesFailure {
  if (isBackofficeForbiddenError(error)) {
    return { status: 403, message: error.message };
  }
  throw error;
}

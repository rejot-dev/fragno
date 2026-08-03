import type { RouterContextProvider } from "react-router";

import type { BackofficeExecutionContext } from "@/backoffice-runtime/context";
import { BackofficeKernel } from "@/backoffice-runtime/kernel";
import type { UploadObject } from "@/backoffice-runtime/object-registry";
import type { FilesExplorerSource } from "@/components/backoffice/files-explorer";
import { createUploadFileCollection } from "@/file-collection/create-upload-file-collection";
import type { FileCollection } from "@/file-collection/file-collection";
import { createBackofficeStaticFileCollection } from "@/files/content/static";
import { systemFileCollection } from "@/files/content/system";
import { requireBackofficeContext } from "@/fragno/auth/backoffice-principal.server";
import { createCodemodeStaticArtifactsResolver } from "@/fragno/codemode/static-codemode-artifacts";
import { UPLOAD_PROVIDER_DATABASE } from "@/fragno/upload";
import { createUploadRouteCaller } from "@/fragno/upload-server";
import { BackofficeWorkerContext } from "@/worker-runtime/router-context";

export type FilesOverviewCollection = Omit<FilesExplorerSource, "tree"> & {
  collection: FileCollection;
  clientSynchronization?: {
    kind: "upload";
    provider: string;
  };
};

export async function createFilesOverviewCollections({
  request,
  context,
  orgId,
}: {
  request: Request;
  context: Readonly<RouterContextProvider>;
  orgId: string;
}): Promise<FilesOverviewCollection[]> {
  const { runtime } = context.get(BackofficeWorkerContext);
  const execution = await requireBackofficeContext(request, context, { kind: "org", orgId });
  const kernel = new BackofficeKernel({ objects: runtime.objects });
  const collections: FilesOverviewCollection[] = [
    {
      rootPath: "/static",
      rootTitle: "Static",
      rootDescription:
        "Immutable product-owned guidance, skills, codemode declarations, and static automations.",
      rootKind: "static",
      readOnly: true,
      persistence: "persistent",
      collection: createBackofficeStaticFileCollection(
        createCodemodeStaticArtifactsResolver({
          objects: runtime.objects,
          config: runtime.config,
          execution,
        }),
      ),
    },
  ];

  if (canSeeSystemFiles(execution)) {
    collections.push({
      rootPath: "/system",
      rootTitle: "System",
      rootDescription: "Admin-only system-scope automations and metadata.",
      rootKind: "static",
      readOnly: true,
      persistence: "persistent",
      collection: systemFileCollection,
    });
  }

  const uploadObject = kernel.scoped("UPLOAD", execution.scope, runtime.objects.upload);
  collections.push({
    rootPath: "/workspace",
    rootTitle: "Workspace",
    rootDescription: "Persistent organization-scoped workspace files.",
    rootKind: "upload",
    readOnly: false,
    persistence: "persistent",
    collection: createWorkspaceFileCollection(uploadObject, request),
    clientSynchronization: {
      kind: "upload",
      provider: UPLOAD_PROVIDER_DATABASE,
    },
  });

  return collections;
}

function createWorkspaceFileCollection(
  uploadObject: UploadObject,
  request: Request,
): FileCollection {
  return createUploadFileCollection({
    routes: createUploadRouteCaller(uploadObject, request),
    provider: UPLOAD_PROVIDER_DATABASE,
    getFileResponse: ({ provider, fileKey }) =>
      fetchUploadFile(uploadObject, request, provider, fileKey),
  });
}

function fetchUploadFile(
  uploadObject: UploadObject,
  request: Request,
  provider: string,
  fileKey: string,
): Promise<Response> {
  const url = new URL("/api/upload/files/by-key/content", request.url);
  url.searchParams.set("provider", provider);
  url.searchParams.set("key", fileKey);
  return uploadObject.fetch(new Request(url, { headers: request.headers }));
}

function canSeeSystemFiles(execution: BackofficeExecutionContext): boolean {
  return (
    execution.scope.kind === "system" ||
    execution.actor.type === "system" ||
    (execution.actor.type === "user" && execution.actor.role === "admin")
  );
}

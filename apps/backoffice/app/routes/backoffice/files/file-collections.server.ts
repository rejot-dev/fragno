import type { RouterContextProvider } from "react-router";

import type { BackofficeContextScope } from "@/backoffice-runtime/context";
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

export const filesOverviewRootPathsForScope = (
  scope: BackofficeContextScope,
): readonly string[] => {
  switch (scope.kind) {
    case "system":
      return ["/system"];
    case "org":
      return ["/static", "/workspace"];
    case "project":
    case "user":
      return ["/workspace"];
  }

  throw new Error("Unsupported Backoffice file scope kind.");
};

export async function createFilesOverviewCollections({
  request,
  context,
  scope,
}: {
  request: Request;
  context: Readonly<RouterContextProvider>;
  scope: BackofficeContextScope;
}): Promise<FilesOverviewCollection[]> {
  const { runtime, kernel } = context.get(BackofficeWorkerContext);
  const execution = await requireBackofficeContext(request, context, scope);
  const rootPaths = filesOverviewRootPathsForScope(execution.scope);
  const collections: FilesOverviewCollection[] = [];

  if (rootPaths.includes("/system")) {
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

  if (rootPaths.includes("/static")) {
    collections.push({
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
    });
  }

  if (rootPaths.includes("/workspace")) {
    const uploadObject = kernel.scoped("UPLOAD", execution.scope, runtime.objects.upload);
    collections.push({
      rootPath: "/workspace",
      rootTitle: "Workspace",
      rootDescription: `Persistent ${execution.scope.kind}-scoped workspace files.`,
      rootKind: "upload",
      readOnly: false,
      persistence: "persistent",
      collection: createWorkspaceFileCollection(uploadObject, request),
      clientSynchronization: {
        kind: "upload",
        provider: UPLOAD_PROVIDER_DATABASE,
      },
    });
  }

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

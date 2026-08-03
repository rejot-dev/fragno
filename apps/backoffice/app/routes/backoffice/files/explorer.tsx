import { Suspense, use, useMemo } from "react";
import { useLoaderData, useOutletContext } from "react-router";

import { and, eq, useLiveQuery } from "@tanstack/react-db";

import {
  FilesExplorerView,
  type FilesExplorerSource,
} from "@/components/backoffice/files-explorer";
import { ClientOnly } from "@/components/client-only";
import { createUploadFileTree } from "@/file-collection/create-upload-file-tree";
import { resolveSynchronizedFileTree } from "@/file-collection/resolve-synchronized-file-tree";
import { toUploadFileRecord, type UploadFileRecord } from "@/fragno/upload/file-record";
import {
  describeUploadCollectionSource,
  getUploadBrowserDatabase,
} from "@/fragno/upload/tanstack/browser-database";

import type { Route } from "./+types/explorer";
import { loadFilesExplorerData, type FilesExplorerSourceSnapshot } from "./data";
import type { FilesLayoutContext } from "./layout-context";

export async function loader({ request, params, context }: Route.LoaderArgs) {
  if (!params.orgId) {
    throw new Response("Not Found", { status: 404 });
  }

  return loadFilesExplorerData({ request, context, orgId: params.orgId });
}

export function meta({ loaderData }: Route.MetaArgs) {
  const selectedTitle = loaderData?.selectedPath?.split("/").filter(Boolean).at(-1);
  return [{ title: selectedTitle ? `Files · ${selectedTitle}` : "Files Explorer" }];
}

export default function BackofficeFilesExplorer() {
  const loaderData = useLoaderData<typeof loader>();
  const { orgId } = useOutletContext<FilesLayoutContext>();
  const synchronizedSource = loaderData.sources.find(hasUploadSynchronization);
  const initialView = <FilesExplorerRouteView {...loaderData} orgId={orgId} />;

  if (!synchronizedSource?.synchronization) {
    return initialView;
  }

  return (
    <ClientOnly fallback={initialView}>
      <Suspense fallback={initialView}>
        <SynchronizedFilesExplorer
          key={
            describeUploadCollectionSource(synchronizedSource.synchronization.source).resourceKey
          }
          {...loaderData}
          orgId={orgId}
          synchronizedSource={synchronizedSource}
        />
      </Suspense>
    </ClientOnly>
  );
}

function SynchronizedFilesExplorer({
  sources,
  selectedPath,
  selectedContent,
  loadError,
  orgId,
  synchronizedSource,
}: FilesExplorerRouteViewProps & {
  synchronizedSource: SynchronizedFilesExplorerSource;
}) {
  const database = use(getUploadBrowserDatabase());
  const collections = database.collectionsFor(synchronizedSource.synchronization.source);
  const filesQuery = useLiveQuery(
    (query) =>
      query
        .from({ file: collections.files })
        .where(({ file }) =>
          and(
            eq(file.status, "ready"),
            eq(file.provider, synchronizedSource.synchronization.provider),
          ),
        ),
    [collections.files, synchronizedSource.synchronization.provider],
  );
  const files = useMemo<UploadFileRecord[]>(
    () => (filesQuery.data ?? []).map(toUploadFileRecord),
    [filesQuery.data],
  );
  const localTree = useMemo(
    () =>
      createUploadFileTree(files, {
        provider: synchronizedSource.synchronization.provider,
      }),
    [files, synchronizedSource.synchronization.provider],
  );
  const synchronizationFailure = filesQuery.isError ? collections.files.utils.getLastError() : null;
  const synchronizedTree = resolveSynchronizedFileTree(
    synchronizedSource.tree,
    synchronizationFailure
      ? { status: "error", error: synchronizationFailure }
      : filesQuery.isReady
        ? { status: "ready", tree: localTree }
        : { status: "loading" },
  );
  const effectiveSources = useMemo<readonly FilesExplorerSource[]>(
    () =>
      sources.map((source) =>
        source.rootPath === synchronizedSource.rootPath
          ? { ...source, tree: synchronizedTree }
          : source,
      ),
    [sources, synchronizedSource.rootPath, synchronizedTree],
  );
  const synchronizationError = synchronizationFailure
    ? readSynchronizationError(synchronizationFailure)
    : null;
  const selectedPathError =
    filesQuery.isReady &&
    selectedPath &&
    isPathWithinRoot(selectedPath, synchronizedSource.rootPath) &&
    !fileTreeContainsPath(localTree, synchronizedSource.rootPath, selectedPath)
      ? `Path '${selectedPath}' could not be found.`
      : null;

  return (
    <FilesExplorerRouteView
      sources={effectiveSources}
      selectedPath={selectedPath}
      selectedContent={selectedContent}
      loadError={appendErrors(loadError, synchronizationError, selectedPathError)}
      orgId={orgId}
    />
  );
}

type FilesExplorerRouteViewProps = {
  sources: readonly FilesExplorerSourceSnapshot[];
  selectedPath: string | null;
  selectedContent: { path: string; text: string } | null;
  loadError: string | null;
  orgId: string;
};

function FilesExplorerRouteView({
  sources,
  selectedPath,
  selectedContent,
  loadError,
  orgId,
}: FilesExplorerRouteViewProps) {
  return (
    <FilesExplorerView
      sources={sources}
      selectedPath={selectedPath}
      selectedContent={selectedContent}
      loadError={loadError}
      defaultCollapsedRootPaths={["/static", "/system"]}
      buildNodeTo={(path) => ({ pathname: buildExplorerPathname(orgId, path) })}
      buildDownloadHref={(path) => buildDownloadHref(orgId, path)}
    />
  );
}

type SynchronizedFilesExplorerSource = FilesExplorerSourceSnapshot & {
  synchronization: NonNullable<FilesExplorerSourceSnapshot["synchronization"]>;
};

function hasUploadSynchronization(
  source: FilesExplorerSourceSnapshot,
): source is SynchronizedFilesExplorerSource {
  return source.synchronization?.kind === "upload";
}

function fileTreeContainsPath(
  tree: FilesExplorerSource["tree"],
  rootPath: string,
  path: string,
): boolean {
  if (path === rootPath) {
    return true;
  }
  if (!path.startsWith(`${rootPath}/`)) {
    return false;
  }

  const relativePath = path.slice(rootPath.length + 1).replace(/\/$/u, "");
  const entry = tree.entries.find((candidate) => candidate.path === relativePath);
  return Boolean(entry && path.endsWith("/") === (entry.kind === "directory"));
}

function isPathWithinRoot(path: string, rootPath: string): boolean {
  return path === rootPath || path.startsWith(`${rootPath}/`);
}

function readSynchronizationError(error: unknown): string {
  return error instanceof Error
    ? `Workspace local synchronization failed: ${error.message}`
    : "Workspace local synchronization failed.";
}

function appendErrors(...errors: Array<string | null>): string | null {
  const messages = errors.filter((error): error is string => Boolean(error));
  return messages.length > 0 ? messages.join(" ") : null;
}

function buildExplorerPathname(orgId: string, path: string): string {
  const encodedPath = path.split("/").filter(Boolean).map(encodeURIComponent).join("/");
  return `/backoffice/files/${encodeURIComponent(orgId)}/${encodedPath}`;
}

function buildDownloadHref(orgId: string, path: string) {
  const params = new URLSearchParams();
  params.set("path", path);
  return `/backoffice/files/${orgId}/download?${params.toString()}`;
}

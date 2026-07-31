import { Suspense, use, useMemo } from "react";
import { useLoaderData, useOutletContext } from "react-router";

import { eq, useLiveQuery } from "@tanstack/react-db";

import { BackofficeSystemState } from "@/components/backoffice";
import { FilesExplorerView } from "@/components/backoffice/files-explorer";
import { ClientOnly } from "@/components/client-only";
import { toUploadFileRecord, type UploadFileRecord } from "@/fragno/upload/file-record";
import {
  describeUploadCollectionSource,
  getUploadBrowserDatabase,
  type UploadCollectionSource,
} from "@/fragno/upload/tanstack/browser-database";

import type { Route } from "./+types/explorer";
import { handleFilesExplorerAction, loadFilesExplorerData } from "./data";
import type { FilesLayoutContext } from "./layout-context";
import {
  buildLocalUploadExplorer,
  getLocalUploadDetail,
  isUploadExplorerMount,
} from "./upload-local-tree";

export async function loader({ request, params, context }: Route.LoaderArgs) {
  if (!params.orgId) {
    throw new Response("Not Found", { status: 404 });
  }

  return loadFilesExplorerData({ request, context, orgId: params.orgId });
}

export async function action({ request, params, context }: Route.ActionArgs) {
  if (!params.orgId) {
    throw new Response("Not Found", { status: 404 });
  }

  return handleFilesExplorerAction({ request, context, orgId: params.orgId });
}

export function meta({ loaderData }: Route.MetaArgs) {
  const selectedTitle = loaderData?.selectedDetail?.node.title;
  return [{ title: selectedTitle ? `Files · ${selectedTitle}` : "Files Explorer" }];
}

const FILES_EXPLORER_LOADING = <FilesExplorerLoading />;

export default function BackofficeFilesExplorer() {
  const layoutContext = useOutletContext<FilesLayoutContext>();
  const uploadMounts = layoutContext.mounts.filter(isUploadExplorerMount);

  if (uploadMounts.length === 0) {
    return <FilesExplorerRouteView />;
  }

  if (!layoutContext.uploadCollectionSource) {
    return (
      <FilesExplorerRouteView
        localUploadProjection={{
          files: [],
          ready: true,
          error:
            layoutContext.uploadCollectionError ?? "Local Upload file metadata is unavailable.",
        }}
      />
    );
  }

  return (
    <ClientOnly fallback={FILES_EXPLORER_LOADING}>
      <Suspense fallback={FILES_EXPLORER_LOADING}>
        <SynchronizedFilesExplorer
          key={describeUploadCollectionSource(layoutContext.uploadCollectionSource).resourceKey}
          source={layoutContext.uploadCollectionSource}
        />
      </Suspense>
    </ClientOnly>
  );
}

function FilesExplorerLoading() {
  return (
    <BackofficeSystemState
      tone="loading"
      label="Mounting filesystem"
      title="Synchronizing workspace files…"
      description="Loading mounted roots, upload metadata, and local file projections."
    >
      <noscript>
        <span className="text-[var(--bo-failed)]">
          JavaScript is required to open synchronized files.
        </span>
      </noscript>
    </BackofficeSystemState>
  );
}

function SynchronizedFilesExplorer({ source }: { source: UploadCollectionSource }) {
  const database = use(getUploadBrowserDatabase());
  const collections = database.collectionsFor(source);
  const filesQuery = useLiveQuery(
    (query) =>
      query.from({ file: collections.files }).where(({ file }) => eq(file.status, "ready")),
    [collections.files],
  );
  const files = useMemo<UploadFileRecord[]>(
    () => (filesQuery.data ?? []).map(toUploadFileRecord),
    [filesQuery.data],
  );
  const sourceError = filesQuery.isError ? collections.files.utils.getLastError() : undefined;
  const filesError =
    sourceError instanceof Error
      ? sourceError.message
      : filesQuery.isError
        ? "Upload file metadata synchronization failed."
        : null;

  if (!filesQuery.isReady && files.length === 0) {
    return <FilesExplorerLoading />;
  }

  return (
    <FilesExplorerRouteView
      localUploadProjection={{
        files,
        ready: filesQuery.isReady,
        error: filesError,
      }}
    />
  );
}

type LocalUploadProjection = {
  files: UploadFileRecord[];
  ready: boolean;
  error: string | null;
};

function FilesExplorerRouteView({
  localUploadProjection,
}: {
  localUploadProjection?: LocalUploadProjection;
}) {
  const {
    tree: serverTree,
    selectedPath,
    selectedDetail: serverSelectedDetail,
    selectedUploadTextContent,
    loadError: serverLoadError,
  } = useLoaderData<typeof loader>();
  const { orgId, mounts } = useOutletContext<FilesLayoutContext>();
  const uploadMounts = useMemo(() => mounts.filter(isUploadExplorerMount), [mounts]);
  const localUploadExplorer = useMemo(
    () => buildLocalUploadExplorer(uploadMounts, localUploadProjection?.files ?? [], orgId),
    [localUploadProjection?.files, orgId, uploadMounts],
  );
  const tree = useMemo(() => {
    const rootByMountPoint = new Map(
      [...serverTree, ...localUploadExplorer.roots].map((root) => [root.mountPoint, root]),
    );
    return mounts.flatMap((mount) => {
      const root = rootByMountPoint.get(mount.mountPoint);
      return root ? [root] : [];
    });
  }, [localUploadExplorer.roots, mounts, serverTree]);
  const localSelectedDetail = selectedPath
    ? getLocalUploadDetail(localUploadExplorer, selectedPath, selectedUploadTextContent)
    : null;
  const selectedDetail = serverSelectedDetail ?? localSelectedDetail;
  const selectedUploadMount = selectedPath
    ? uploadMounts.find(
        (mount) =>
          selectedPath === mount.mountPoint || selectedPath.startsWith(`${mount.mountPoint}/`),
      )
    : undefined;
  const loadError =
    serverLoadError ??
    localUploadProjection?.error ??
    (localUploadProjection?.ready && selectedPath && selectedUploadMount && !selectedDetail
      ? `Path '${selectedPath}' could not be found.`
      : null);

  return (
    <FilesExplorerView
      tree={tree}
      selectedPath={selectedPath}
      selectedDetail={selectedDetail}
      loadError={loadError}
      buildNodeTo={(path) => ({
        pathname: `/backoffice/files/${orgId}`,
        search: buildExplorerSearch(path),
      })}
      buildDownloadHref={(path) => buildDownloadHref(orgId, path)}
    />
  );
}

function buildExplorerSearch(path: string) {
  const params = new URLSearchParams();
  params.set("path", path);
  return `?${params.toString()}`;
}

function buildDownloadHref(orgId: string, path: string) {
  const params = new URLSearchParams();
  params.set("path", path);
  return `/backoffice/files/${orgId}/download?${params.toString()}`;
}

import { Download, File as FileIcon, Folder, HardDrive } from "lucide-react";
import { Suspense, use, useMemo, type ReactNode } from "react";
import { Link, useLoaderData, useOutletContext } from "react-router";

import { eq, useLiveQuery } from "@tanstack/react-db";

import { BackofficeSystemState } from "@/components/backoffice";
import { ClientOnly } from "@/components/client-only";
import type { FilesExplorerTreeNode, FilesNodeDetail } from "@/files";
import { toUploadFileRecord, type UploadFileRecord } from "@/fragno/upload/file-record";
import {
  describeUploadCollectionSource,
  getUploadBrowserDatabase,
  type UploadCollectionSource,
} from "@/fragno/upload/tanstack/browser-database";

import type { Route } from "./+types/explorer";
import { resolveFilesContentRenderer } from "./content-renderers";
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
    return <FilesExplorerView uploadFiles={[]} uploadFilesReady uploadFilesError={null} />;
  }

  if (!layoutContext.uploadCollectionSource) {
    return (
      <FilesExplorerView
        uploadFiles={[]}
        uploadFilesReady
        uploadFilesError={
          layoutContext.uploadCollectionError ?? "Local Upload file metadata is unavailable."
        }
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
    <FilesExplorerView
      uploadFiles={files}
      uploadFilesReady={filesQuery.isReady}
      uploadFilesError={filesError}
    />
  );
}

function FilesExplorerView({
  uploadFiles,
  uploadFilesReady,
  uploadFilesError,
}: {
  uploadFiles: UploadFileRecord[];
  uploadFilesReady: boolean;
  uploadFilesError: string | null;
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
    () => buildLocalUploadExplorer(uploadMounts, uploadFiles, orgId),
    [orgId, uploadFiles, uploadMounts],
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
    uploadFilesError ??
    (uploadFilesReady && selectedPath && selectedUploadMount && !selectedDetail
      ? `Path '${selectedPath}' could not be found.`
      : null);

  const selectedContentRenderer = selectedDetail
    ? resolveFilesContentRenderer(selectedDetail)
    : null;
  const selectedMount = selectedDetail?.node.kind === "root" ? selectedDetail : null;

  return (
    <div className="space-y-4">
      {loadError ? <MessageTone tone="error">{loadError}</MessageTone> : null}

      {tree.length === 0 ? (
        <BackofficeSystemState
          tone="empty"
          label="No mounted roots"
          title="This workspace has no filesystems yet."
          description="Configure a filesystem contributor or upload integration to make files available here."
        />
      ) : (
        <section className="grid gap-4 xl:grid-cols-[20rem_minmax(0,1fr)]">
          <aside className="border border-[color:var(--bo-border)] bg-[var(--bo-panel)] p-3">
            <p className="px-1 text-[10px] tracking-[0.24em] text-[var(--bo-muted-2)] uppercase">
              File tree
            </p>

            <nav aria-label="Files explorer" className="mt-3 space-y-0.5">
              {tree.map((node) => (
                <TreeNodeRow
                  key={node.path}
                  node={node}
                  selectedPath={selectedPath}
                  orgId={orgId}
                  depth={0}
                />
              ))}
            </nav>
          </aside>

          <div className="space-y-4">
            {selectedMount ? (
              <MountSelectionState detail={selectedMount} />
            ) : selectedDetail ? (
              <section className="border border-[color:var(--bo-border)] bg-[var(--bo-panel)] p-4">
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div>
                    <p className="text-[10px] tracking-[0.24em] text-[var(--bo-muted-2)] uppercase">
                      Selection
                    </p>
                    <h2 className="mt-2 text-2xl font-semibold text-balance text-[var(--bo-fg)]">
                      {selectedDetail.node.title}
                    </h2>
                  </div>
                  {selectedDetail.node.kind === "file" ? (
                    <a
                      href={buildDownloadHref(orgId, selectedDetail.node.path)}
                      className="inline-flex min-h-10 items-center gap-2 border border-[color:var(--bo-border)] bg-[var(--bo-panel-2)] px-3 py-2 text-[10px] font-semibold tracking-[0.22em] text-[var(--bo-muted)] uppercase transition-[scale,background-color,border-color,color] duration-150 ease-out hover:border-[color:var(--bo-border-strong)] hover:text-[var(--bo-fg)] focus-visible:ring-2 focus-visible:ring-[color:var(--bo-accent)]/30 focus-visible:outline-none active:scale-[0.96]"
                    >
                      <Download className="h-3.5 w-3.5" aria-hidden="true" />
                      Download
                    </a>
                  ) : null}
                </div>

                {selectedContentRenderer ? (
                  <div className="mt-4 border border-[color:var(--bo-border)] bg-[var(--bo-panel-2)] p-3">
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <p className="text-[10px] tracking-[0.22em] text-[var(--bo-muted-2)] uppercase">
                        {selectedContentRenderer.label}
                      </p>
                      {selectedDetail.node.contentType ? (
                        <p className="text-[10px] text-[var(--bo-muted-2)]">
                          {selectedDetail.node.contentType}
                        </p>
                      ) : null}
                    </div>
                    <div className="mt-3">{selectedContentRenderer.render(selectedDetail)}</div>
                  </div>
                ) : null}

                <dl className="mt-4 grid gap-x-4 gap-y-2 border-t border-[color:var(--bo-border)] pt-3 md:grid-cols-2 xl:grid-cols-3">
                  {selectedDetail.fields.map((field) => (
                    <div key={`${field.label}-${field.value}`} className="min-w-0">
                      <dt className="text-[9px] tracking-[0.18em] text-[var(--bo-muted-2)] uppercase">
                        {field.label}
                      </dt>
                      <dd className="mt-1 text-xs break-all text-[var(--bo-muted)]">
                        {field.value}
                      </dd>
                    </div>
                  ))}
                </dl>

                {selectedDetail.metadata && Object.keys(selectedDetail.metadata).length > 0 ? (
                  <div className="mt-4 border-t border-[color:var(--bo-border)] pt-3">
                    <p className="text-[9px] tracking-[0.18em] text-[var(--bo-muted-2)] uppercase">
                      Metadata
                    </p>
                    <pre className="mt-2 max-h-72 overflow-auto text-[11px] text-[var(--bo-muted)]">
                      {JSON.stringify(selectedDetail.metadata, null, 2)}
                    </pre>
                  </div>
                ) : null}
              </section>
            ) : null}
          </div>
        </section>
      )}
    </div>
  );
}

function MountSelectionState({ detail }: { detail: FilesNodeDetail }) {
  const isEmpty = (detail.node.fileCount ?? 0) + (detail.node.folderCount ?? 0) === 0;

  return (
    <section className="bo-fragment-surface bo-panel-surface flex min-h-80 items-center justify-center bg-[var(--bo-panel)] p-6">
      <div className="max-w-sm text-center">
        <div className="mx-auto flex size-12 items-center justify-center bg-[var(--bo-panel-2)] shadow-[0_1px_2px_rgba(15,23,42,0.08),0_8px_24px_rgba(15,23,42,0.06)] dark:shadow-[0_1px_2px_rgba(0,0,0,0.35),0_8px_24px_rgba(0,0,0,0.2)]">
          <HardDrive className="size-5 text-[var(--bo-muted)]" aria-hidden="true" />
        </div>
        <p className="mt-4 font-mono text-[9px] tracking-[0.18em] text-[var(--bo-muted-2)] uppercase">
          Mount selected
        </p>
        <h2 className="mt-2 text-xl font-semibold tracking-tight text-balance text-[var(--bo-fg)]">
          {detail.node.title}
        </h2>
        <p className="mt-2 text-sm text-pretty text-[var(--bo-muted)]">
          {isEmpty
            ? "This mount is empty. Files and folders will appear here when they become available."
            : "Choose a file or folder in the sidebar to inspect its contents."}
        </p>
      </div>
    </section>
  );
}

function TreeNodeRow({
  node,
  selectedPath,
  orgId,
  depth,
}: {
  node: FilesExplorerTreeNode;
  selectedPath: string | null;
  orgId: string;
  depth: number;
}) {
  const isSelected = selectedPath === node.path;
  const Icon = node.kind === "root" ? HardDrive : node.kind === "folder" ? Folder : FileIcon;

  return (
    <div>
      <Link
        to={{ pathname: `/backoffice/files/${orgId}`, search: buildExplorerSearch(node.path) }}
        preventScrollReset
        aria-current={isSelected ? "page" : undefined}
        className={
          isSelected
            ? "flex min-h-10 items-center gap-1.5 rounded-sm border border-[color:var(--bo-border-strong)] bg-[var(--bo-panel-2)] px-1.5 py-1 text-[13px] text-[var(--bo-fg)] transition-[scale] duration-150 ease-out outline-none focus-visible:ring-2 focus-visible:ring-[color:var(--bo-accent)]/30 active:scale-[0.96]"
            : "flex min-h-10 items-center gap-1.5 rounded-sm border border-transparent px-1.5 py-1 text-[13px] text-[var(--bo-muted)] transition-[scale,background-color,border-color,color] duration-150 ease-out outline-none hover:border-[color:var(--bo-border)] hover:bg-[var(--bo-panel-2)] hover:text-[var(--bo-fg)] focus-visible:ring-2 focus-visible:ring-[color:var(--bo-accent)]/30 active:scale-[0.96]"
        }
        style={{ paddingLeft: `${0.25 + depth * 0.75}rem` }}
      >
        <Icon className="h-4 w-4 shrink-0" />
        <span className="min-w-0 truncate">{node.title}</span>
      </Link>

      {node.children?.length ? (
        <div className="space-y-0.5">
          {node.children.map((child) => (
            <TreeNodeRow
              key={child.path}
              node={child}
              selectedPath={selectedPath}
              orgId={orgId}
              depth={depth + 1}
            />
          ))}
        </div>
      ) : null}
    </div>
  );
}

function MessageTone({ tone, children }: { tone: "error" | "success"; children: ReactNode }) {
  const toneClass =
    tone === "error"
      ? "border-[color:var(--bo-failed)] bg-[var(--bo-failed-bg)] text-[var(--bo-failed)]"
      : "border-[color:var(--bo-live)] bg-[var(--bo-live-bg)] text-[var(--bo-live)]";

  return <section className={`border p-3 text-sm ${toneClass}`}>{children}</section>;
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

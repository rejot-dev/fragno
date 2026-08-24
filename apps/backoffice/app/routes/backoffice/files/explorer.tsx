import { Suspense, use, useMemo } from "react";
import { useLoaderData, useOutletContext } from "react-router";

import { and, eq, useLiveQuery } from "@tanstack/react-db";

import type { BackofficeScopeSelection } from "@/backoffice-runtime/resolved-scope";
import {
  useCurrentBackofficeContext,
  type AutomationCollectionSourceState,
} from "@/components/backoffice/current-context";
import {
  FilesExplorerView,
  type FilesExplorerSource,
} from "@/components/backoffice/files-explorer";
import type { WorkflowFileRouting } from "@/components/backoffice/files-explorer/content-renderers";
import type { FilesExplorerSearchGroup } from "@/components/backoffice/files-explorer/view";
import { ClientOnly } from "@/components/client-only";
import { createUploadFileTree } from "@/file-collection/create-upload-file-tree";
import { resolveSynchronizedFileTree } from "@/file-collection/resolve-synchronized-file-tree";
import {
  getAutomationBrowserDatabase,
  type AutomationCollectionSource,
} from "@/fragno/automation/tanstack/browser-database";
import { useAutomationRoutes } from "@/fragno/automation/tanstack/use-automation-routes";
import { toUploadFileRecord, type UploadFileRecord } from "@/fragno/upload/file-record";
import {
  describeUploadCollectionSource,
  getUploadBrowserDatabase,
} from "@/fragno/upload/tanstack/browser-database";

import type { Route } from "./+types/explorer";
import {
  loadFilesExplorerData,
  resolveAuthorizedFilesRouteScope,
  type FilesExplorerSourceSnapshot,
} from "./data";
import type { FilesLayoutContext } from "./layout-context";
import { filesDownloadPath, filesExplorerPath } from "./scope";

export async function loader({ request, params, context, url }: Route.LoaderArgs) {
  const scope = await resolveAuthorizedFilesRouteScope({ request, context, params, url });
  if (scope instanceof Response) {
    return scope;
  }
  return loadFilesExplorerData({ request, context, scope });
}

export function meta({ loaderData }: Route.MetaArgs) {
  const selectedTitle = loaderData?.selectedPath?.split("/").filter(Boolean).at(-1);
  return [{ title: selectedTitle ? `Files · ${selectedTitle}` : "Files Explorer" }];
}

export default function BackofficeFilesExplorer() {
  const loaderData = useLoaderData<typeof loader>();
  const { selectedScope } = useOutletContext<FilesLayoutContext>();
  const { automationCollectionSource } = useCurrentBackofficeContext();
  const initialView = (
    <FilesExplorerRouteView
      {...loaderData}
      selectedScope={selectedScope}
      workflowRouting={{ status: "loading" }}
    />
  );

  return (
    <ClientOnly fallback={initialView}>
      <Suspense fallback={initialView}>
        <LocalFirstFilesExplorer
          {...loaderData}
          selectedScope={selectedScope}
          automationCollectionSource={automationCollectionSource}
        />
      </Suspense>
    </ClientOnly>
  );
}

function LocalFirstFilesExplorer({
  automationCollectionSource,
  ...props
}: FilesExplorerLocalDataProps & {
  automationCollectionSource: AutomationCollectionSourceState;
}) {
  if (automationCollectionSource.status === "unavailable") {
    return (
      <FilesExplorerWithLocalData
        {...props}
        workflowRouting={{ status: "error", message: automationCollectionSource.message }}
      />
    );
  }

  return (
    <SynchronizedAutomationRoutesFilesExplorer
      {...props}
      collectionSource={automationCollectionSource.source}
    />
  );
}

function SynchronizedAutomationRoutesFilesExplorer({
  collectionSource,
  ...props
}: FilesExplorerLocalDataProps & {
  collectionSource: AutomationCollectionSource;
}) {
  const { collections } = use(getAutomationBrowserDatabase(collectionSource));
  const routesState = useAutomationRoutes(collections);
  const workflowRouting: WorkflowFileRouting =
    routesState.status === "loading"
      ? { status: "loading" }
      : routesState.status === "error"
        ? { status: "error", message: routesState.message }
        : { status: "ready", routes: routesState.routes };

  return <FilesExplorerWithLocalData {...props} workflowRouting={workflowRouting} />;
}

function FilesExplorerWithLocalData(props: FilesExplorerRouteViewProps) {
  const synchronizedSource = props.sources.find(hasUploadSynchronization);
  if (!synchronizedSource?.synchronization) {
    return <FilesExplorerRouteView {...props} />;
  }

  return (
    <SynchronizedFilesExplorer
      key={describeUploadCollectionSource(synchronizedSource.synchronization.source).resourceKey}
      {...props}
      synchronizedSource={synchronizedSource}
    />
  );
}

function SynchronizedFilesExplorer({
  sources,
  selectedPath,
  selectedContent,
  loadError,
  searchQuery,
  searchGroups,
  selectedScope,
  workflowRouting,
  synchronizedSource,
}: FilesExplorerRouteViewProps & {
  synchronizedSource: SynchronizedFilesExplorerSource;
}) {
  const database = use(getUploadBrowserDatabase());
  const collections = use(database.readyCollectionsFor(synchronizedSource.synchronization.source));
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
      searchQuery={searchQuery}
      searchGroups={searchGroups}
      selectedScope={selectedScope}
      workflowRouting={workflowRouting}
    />
  );
}

type FilesExplorerLocalDataProps = Omit<FilesExplorerRouteViewProps, "workflowRouting">;

type FilesExplorerRouteViewProps = {
  sources: readonly FilesExplorerSourceSnapshot[];
  selectedPath: string | null;
  selectedContent: { path: string; text: string } | null;
  loadError: string | null;
  searchQuery: string;
  searchGroups: FilesExplorerSearchGroup[];
  selectedScope: BackofficeScopeSelection;
  workflowRouting: WorkflowFileRouting;
};

function FilesExplorerRouteView({
  sources,
  selectedPath,
  selectedContent,
  loadError,
  searchQuery,
  searchGroups,
  selectedScope,
  workflowRouting,
}: FilesExplorerRouteViewProps) {
  return (
    <FilesExplorerView
      sources={sources}
      selectedPath={selectedPath}
      selectedContent={selectedContent}
      loadError={loadError}
      contentSearch={{ query: searchQuery, groups: searchGroups }}
      defaultCollapsedRootPaths={["/static", "/system"]}
      buildNodeTo={(path) => ({ pathname: filesExplorerPath(selectedScope, path) })}
      buildDownloadHref={(path) => filesDownloadPath(selectedScope, path)}
      workflowRouting={workflowRouting}
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

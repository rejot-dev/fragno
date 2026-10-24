import type { LofiSqliteReplica } from "@fragno-dev/lofi/sqlite";
import { ClientOnly } from "@fragno-private/design-system/client-only";
import { Suspense, use, useMemo } from "react";
import { useLoaderData, useOutletContext } from "react-router";

import {
  backofficeRuntimeScopeFromResolvedScope,
  type BackofficeScopeSelection,
} from "@/backoffice-runtime/resolved-scope";
import { useCurrentBackofficeContext } from "@/components/backoffice/current-context";
import type { AutomationCollectionSourceState } from "@/components/backoffice/current-context-state";
import {
  FilesExplorerView,
  type FilesExplorerSource,
} from "@/components/backoffice/files-explorer";
import type { WorkflowFileRouting } from "@/components/backoffice/files-explorer/content-renderers";
import type { FilesExplorerSearchGroup } from "@/components/backoffice/files-explorer/view";
import { createUploadFileTree } from "@/file-collection/create-upload-file-tree";
import { resolveSynchronizedFileTree } from "@/file-collection/resolve-synchronized-file-tree";
import {
  getAutomationBrowserDatabase,
  type AutomationCollectionSource,
} from "@/fragno/automation/tanstack/browser-database";
import { useAutomationRoutes } from "@/fragno/automation/tanstack/use-automation-routes";
import { LofiReplicaGate, useLofiSqliteReplicaStatus } from "@/fragno/lofi/replica-gate";
import { useLofiSqliteRead } from "@/fragno/lofi/use-lofi-sqlite-read";
import {
  describeUploadReplicaSource,
  getUploadReplica,
  readReadyUploadFiles,
} from "@/fragno/upload/lofi/replica";
import { requireScopeSelection } from "@/layouts/backoffice-shell-request.server";

import { pageName, pagePath } from "../pages/path";
import type { Route } from "./+types/explorer";
import { loadFilesExplorerData, type FilesExplorerSourceSnapshot } from "./data";
import type { FilesLayoutContext } from "./layout-context";
import { filesDownloadPath, filesExplorerPath } from "./scope";

export async function loader({ request, context }: Route.LoaderArgs) {
  const scope = backofficeRuntimeScopeFromResolvedScope(requireScopeSelection(context));
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
  // The server's snapshot shows until this tab's replica opens.
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

  const replica = use(getUploadReplica(synchronizedSource.synchronization.source));
  return (
    <LofiReplicaGate replica={replica} title="Downloading workspace files…">
      <SynchronizedFilesExplorer
        key={describeUploadReplicaSource(synchronizedSource.synchronization.source).resourceKey}
        {...props}
        synchronizedSource={synchronizedSource}
        replica={replica}
      />
    </LofiReplicaGate>
  );
}

function SynchronizedFilesExplorer({
  sources,
  selectedPath,
  loadError,
  synchronizedSource,
  replica,
  ...props
}: FilesExplorerRouteViewProps & {
  synchronizedSource: SynchronizedFilesExplorerSource;
  replica: LofiSqliteReplica;
}) {
  const { provider } = synchronizedSource.synchronization;
  const status = useLofiSqliteReplicaStatus(replica);
  const files = useLofiSqliteRead(replica, provider, (replica) =>
    readReadyUploadFiles(replica, provider),
  );
  const localTree = useMemo(
    () => (files.status === "ready" ? createUploadFileTree(files.data, { provider }) : null),
    [files, provider],
  );
  const synchronizedTree = resolveSynchronizedFileTree(
    synchronizedSource.tree,
    files.status === "error"
      ? { status: "error", error: files.error }
      : localTree
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
  const synchronizationError =
    files.status === "error"
      ? "Workspace files could not be read from this browser's copy."
      : status.error !== null
        ? `Workspace local synchronization failed and is retrying: ${status.error}`
        : null;
  const selectedPathError =
    localTree &&
    selectedPath &&
    isPathWithinRoot(selectedPath, synchronizedSource.rootPath) &&
    !fileTreeContainsPath(localTree, synchronizedSource.rootPath, selectedPath)
      ? `Path '${selectedPath}' could not be found.`
      : null;

  return (
    <FilesExplorerRouteView
      {...props}
      sources={effectiveSources}
      selectedPath={selectedPath}
      loadError={appendErrors(loadError, synchronizationError, selectedPathError)}
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
      buildFileHref={(path, disposition) => filesDownloadPath(selectedScope, path, disposition)}
      workflowRouting={workflowRouting}
      pageHref={(sourcePath) => pagePath(selectedScope, pageName(sourcePath))}
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

function appendErrors(...errors: Array<string | null>): string | null {
  const messages = errors.filter((error): error is string => Boolean(error));
  return messages.length > 0 ? messages.join(" ") : null;
}

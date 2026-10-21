import { Button } from "@fragno-private/design-system/button";
import { underlineTabClassName } from "@fragno-private/design-system/underline-tab-class-name";
import { useEffect, useMemo, useState, type ReactNode } from "react";
import { Link, useFetcher, useLocation } from "react-router";
import { Streamdown } from "streamdown";

import {
  FilesExplorerView,
  type FilesExplorerSource,
} from "@/components/backoffice/files-explorer";
import { WorkflowFilePreview } from "@/components/backoffice/files-explorer/content-renderers";
import type { FileTreeEntry } from "@/file-collection/file-collection";
import { MARKETPLACE_INSTALL_WORKFLOW_PATH } from "@/fragno/marketplace/package-files";

import {
  MARKETPLACE_PACKAGE_ROOT_PATH,
  type MarketplacePackageExplorerData,
  type MarketplacePackageSelectedContent,
} from "./package-files-model";
import { marketplacePackageTabFromSearch, type MarketplacePackageTab } from "./package-tabs";
type ReadyPackageData = Extract<MarketplacePackageExplorerData, { state: "ready" }>;

export function MarketplacePackageFiles({
  data,
  selectedContent = null,
}: {
  data: MarketplacePackageExplorerData;
  selectedContent?: MarketplacePackageSelectedContent | null;
}) {
  if (data.state !== "ready") {
    return (
      <section className="mt-5">
        <h3 className="text-lg font-semibold tracking-tight text-balance text-[var(--bo-fg)]">
          Package contents unavailable
        </h3>
        <p
          className={`mt-2 text-sm leading-6 text-pretty ${data.state === "error" ? "text-[var(--bo-failed)]" : "text-[var(--bo-muted)]"}`}
        >
          {data.message}
        </p>
      </section>
    );
  }

  return <ReadyMarketplacePackageFiles data={data} selectedContent={selectedContent} />;
}

function ReadyMarketplacePackageFiles({
  data,
  selectedContent,
}: {
  data: ReadyPackageData;
  selectedContent: MarketplacePackageSelectedContent | null;
}) {
  const location = useLocation();
  const overview = useFetcher<string>();
  const [requestedOverviewPath, setRequestedOverviewPath] = useState<string | null>(null);
  const activeTab = marketplacePackageTabFromSearch(location.search);
  const overviewResourcePath = data.overviewPath
    ? buildPackageFileResourcePath(location.pathname, data.overviewPath)
    : null;
  const loadOverview = () => {
    if (overviewResourcePath && requestedOverviewPath !== overviewResourcePath) {
      setRequestedOverviewPath(overviewResourcePath);
      void overview.load(overviewResourcePath);
    }
  };
  useEffect(() => {
    if (
      activeTab === "overview" &&
      overviewResourcePath &&
      requestedOverviewPath !== overviewResourcePath
    ) {
      setRequestedOverviewPath(overviewResourcePath);
      void overview.load(overviewResourcePath);
    }
  }, [activeTab, overview, overviewResourcePath, requestedOverviewPath]);

  return (
    <>
      {activeTab === "overview" ? (
        <MarketplacePackageOverview
          path={data.overviewPath}
          requested={requestedOverviewPath === overviewResourcePath}
          loading={overview.state !== "idle"}
          markdown={
            requestedOverviewPath === overviewResourcePath && typeof overview.data === "string"
              ? overview.data
              : null
          }
          onLoad={loadOverview}
        />
      ) : activeTab === "workflows" ? (
        <MarketplacePackageWorkflows data={data} selectedContent={selectedContent} />
      ) : (
        <MarketplacePackageExplorer data={data} selectedContent={selectedContent} />
      )}
    </>
  );
}

function MarketplacePackageExplorer({
  data,
  selectedContent,
}: {
  data: ReadyPackageData;
  selectedContent: MarketplacePackageSelectedContent | null;
}) {
  const location = useLocation();
  const search = new URLSearchParams(location.search);
  const explicitRequestedPath = search.get("packagePath")?.trim() || null;
  const entriesByExplorerPath = useMemo(
    () => createMarketplacePackageEntriesByExplorerPath(data.fileTree.entries),
    [data.fileTree.entries],
  );
  const defaultPath = `${MARKETPLACE_PACKAGE_ROOT_PATH}/${data.selectedVersion}/`;
  const requestedPath = explicitRequestedPath ?? defaultPath;
  const selectedPath =
    requestedPath === MARKETPLACE_PACKAGE_ROOT_PATH || entriesByExplorerPath.has(requestedPath)
      ? requestedPath
      : defaultPath;
  const selectedEntry = entriesByExplorerPath.get(selectedPath);
  const displayedContent =
    selectedEntry?.kind === "file" &&
    shouldLoadTextContent({ path: selectedPath, contentType: selectedEntry.contentType })
      ? selectedContent?.path === selectedPath
        ? selectedContent
        : { path: selectedPath, text: "File contents are unavailable." }
      : null;
  const sources = useMemo<readonly FilesExplorerSource[]>(
    () => [
      {
        tree: data.fileTree,
        rootPath: MARKETPLACE_PACKAGE_ROOT_PATH,
        rootTitle: "Package contents",
        rootDescription: "Files published for this Marketplace package.",
      },
    ],
    [data],
  );

  return (
    <div className="mt-5">
      <FilesExplorerView
        sources={sources}
        selectedPath={selectedPath}
        selectedContent={displayedContent}
        loadError={
          explicitRequestedPath &&
          explicitRequestedPath !== MARKETPLACE_PACKAGE_ROOT_PATH &&
          !entriesByExplorerPath.has(explicitRequestedPath)
            ? `Package path '${explicitRequestedPath}' could not be found.`
            : null
        }
        treeAriaLabel="Marketplace package files"
        rootIcon={"package"}
        rootSelection="detail"
        detailHeadingLevel={4}
        emptySelection={
          <div className="flex min-h-64 items-center justify-center p-6 text-center">
            <p className="max-w-xs text-sm text-pretty text-[var(--bo-muted)]">
              Select a folder or file to inspect its published details.
            </p>
          </div>
        }
        workflowRouting={{ status: "unavailable" }}
        pages={{ status: "unavailable" }}
        buildNodeTo={(path) => {
          const entry = entriesByExplorerPath.get(path);
          return buildPackageSelectionPath(
            location.pathname,
            location.search,
            "files",
            path,
            entry?.kind === "file" &&
              shouldLoadTextContent({ path, contentType: entry.contentType }),
          );
        }}
      />
    </div>
  );
}

function MarketplacePackageWorkflows({
  data,
  selectedContent,
}: {
  data: ReadyPackageData;
  selectedContent: MarketplacePackageSelectedContent | null;
}) {
  const location = useLocation();
  const installationWorkflowPath = `${MARKETPLACE_PACKAGE_ROOT_PATH}/${data.selectedVersion}/${MARKETPLACE_INSTALL_WORKFLOW_PATH}`;
  const workflowPaths = useMemo(() => {
    const installer = findMarketplacePackageEntry(
      data,
      `${data.selectedVersion}/${MARKETPLACE_INSTALL_WORKFLOW_PATH}`,
    );
    const workflowPathPrefix = `${data.selectedVersion}/automations/`;
    const paths: string[] = [];

    for (const entry of data.fileTree.entries) {
      if (
        entry.kind === "file" &&
        entry.path.startsWith(workflowPathPrefix) &&
        entry.path.toLowerCase().endsWith(".workflow.js")
      ) {
        paths.push(`${MARKETPLACE_PACKAGE_ROOT_PATH}/${entry.path}`);
      }
    }

    const sortedPaths = paths.sort((left, right) => left.localeCompare(right));
    return installer?.kind === "file" ? [installationWorkflowPath, ...sortedPaths] : sortedPaths;
  }, [data, installationWorkflowPath]);
  const requestedPath = new URLSearchParams(location.search).get("packagePath")?.trim();
  const selectedPath =
    requestedPath && workflowPaths.includes(requestedPath) ? requestedPath : null;

  if (workflowPaths.length === 0) {
    return (
      <MarketplacePackageMessage
        title="No workflows found"
        description="This release does not contain any .workflow.js files."
      />
    );
  }

  return (
    <div className="mt-5">
      <div
        role="tablist"
        aria-label="Published workflows"
        className="flex gap-4 overflow-x-auto shadow-[inset_0_-1px_0_var(--bo-border)]"
      >
        {workflowPaths.map((path) => {
          const selected = selectedPath === path;
          return (
            <Link
              key={path}
              to={buildPackageSelectionPath(
                location.pathname,
                location.search,
                "workflows",
                path,
                true,
              )}
              role="tab"
              aria-selected={selected}
              preventScrollReset
              className={underlineTabClassName(selected ? "selected" : "idle")}
            >
              {path === installationWorkflowPath
                ? MARKETPLACE_INSTALL_WORKFLOW_PATH
                : path.split("/").at(-1)}
            </Link>
          );
        })}
      </div>

      {!selectedPath ? (
        <MarketplacePackageMessage title="Select a workflow" />
      ) : selectedContent?.path === selectedPath ? (
        <section className="mt-5 overflow-hidden shadow-[0_0_0_1px_var(--bo-border)]">
          <div className="border-b border-[color:var(--bo-border)] bg-[var(--bo-panel)] px-3 py-2.5">
            <p
              className="truncate font-mono text-[10px] text-[var(--bo-muted)]"
              title={selectedPath}
            >
              {selectedPath}
            </p>
          </div>
          <div className="h-[36rem] max-h-[calc(100vh-10rem)] min-h-64 p-3">
            <WorkflowFilePreview
              key={selectedPath}
              preview={{
                title: selectedPath,
                contentType: "text/javascript",
                metadata: null,
                textContent: selectedContent.text,
                inlineHref: null,
                workflowRouting: { status: "unavailable" },
                page: { status: "unavailable" },
              }}
            />
          </div>
        </section>
      ) : (
        <MarketplacePackageMessage title="Workflow source unavailable" />
      )}
    </div>
  );
}

function MarketplacePackageOverview({
  path,
  requested,
  loading,
  markdown,
  onLoad,
}: {
  path: string | null;
  requested: boolean;
  loading: boolean;
  markdown: string | null;
  onLoad: () => void;
}) {
  if (!path) {
    return (
      <MarketplacePackageMessage
        title="No package overview"
        description="Add a README.md at the top level or in this release to provide an overview for this Marketplace listing."
      />
    );
  }
  if (!requested) {
    return (
      <MarketplacePackageMessage
        title="Package overview"
        action={<LoadContentButton onClick={onLoad}>Load overview</LoadContentButton>}
      />
    );
  }
  if (loading || markdown === null) {
    return <MarketplacePackageMessage title="Loading overview…" />;
  }

  return (
    <article className="mt-5">
      <Streamdown
        mode="streaming"
        className="bo-session-markdown max-w-4xl text-sm leading-7 text-pretty [&_h1]:text-2xl [&_h2]:text-xl"
        controls={{ code: true, table: true }}
        skipHtml
      >
        {markdown}
      </Streamdown>
    </article>
  );
}

function MarketplacePackageMessage({
  title,
  description,
  action,
}: {
  title: string;
  description?: string;
  action?: ReactNode;
}) {
  return (
    <div className="mt-5 flex min-h-64 items-center justify-center bg-[var(--bo-panel-2)] p-6 text-center shadow-[inset_0_0_0_1px_var(--bo-border)]">
      <div className="max-w-sm">
        <p className="text-sm font-medium text-[var(--bo-fg)]">{title}</p>
        {description ? (
          <p className="mt-2 text-sm leading-6 text-pretty text-[var(--bo-muted)]">{description}</p>
        ) : null}
        {action}
      </div>
    </div>
  );
}

function LoadContentButton({ onClick, children }: { onClick: () => void; children: ReactNode }) {
  return (
    <Button onClick={onClick} variant="secondary" className="mt-4">
      {children}
    </Button>
  );
}

function createMarketplacePackageEntriesByExplorerPath(
  entries: readonly FileTreeEntry[],
): ReadonlyMap<string, FileTreeEntry> {
  return new Map(
    entries.map((entry) => [
      `${MARKETPLACE_PACKAGE_ROOT_PATH}/${entry.path}${entry.kind === "directory" ? "/" : ""}`,
      entry,
    ]),
  );
}

function findMarketplacePackageEntry(
  data: ReadyPackageData,
  relativePath: string,
): FileTreeEntry | undefined {
  return data.fileTree.entries.find((entry) => entry.path === relativePath);
}

function buildPackageSelectionPath(
  pathname: string,
  currentSearch: string,
  tab: Extract<MarketplacePackageTab, "files" | "workflows">,
  path: string,
  loadTextContent: boolean,
): string {
  const search = new URLSearchParams(currentSearch);
  search.set("packageTab", tab);
  search.set("packagePath", path);
  if (loadTextContent) {
    search.set("packageContent", "text");
  } else {
    search.delete("packageContent");
  }
  return `${pathname}?${search}`;
}

function shouldLoadTextContent(node: { path: string; contentType?: string | null }): boolean {
  const contentType = node.contentType?.toLowerCase() ?? "";
  return (
    contentType.startsWith("text/") ||
    contentType.includes("json") ||
    contentType.includes("javascript") ||
    contentType.includes("xml") ||
    contentType.includes("yaml") ||
    /\.(md|mdx|txt|json|js|jsx|ts|tsx|css|html|xml|yml|yaml|toml|ini|sh)$/iu.test(node.path)
  );
}

function buildPackageFileResourcePath(pathname: string, path: string): string {
  const resourcePath = pathname.endsWith("/")
    ? `${pathname}package-file`
    : `${pathname}/package-file`;
  const search = new URLSearchParams({ packagePath: path });
  return `${resourcePath}?${search}`;
}

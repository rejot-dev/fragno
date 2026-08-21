import { PackageOpen } from "lucide-react";
import { useMemo, useState, type ReactNode } from "react";
import { Link, useFetcher, useLocation } from "react-router";
import { Streamdown } from "streamdown";

import {
  visualizeWorkflowSource,
  type WorkflowVisualizationSnapshot,
} from "@fragno-dev/workflow-visualizer-tokens";

import {
  FilesExplorerView,
  type FilesExplorerSource,
} from "@/components/backoffice/files-explorer";
import type { FileTreeEntry } from "@/file-collection/file-collection";
import type { ResolvedWorkflowRuntimeToolCall } from "@/fragno/runtime-tools/workflow-catalog";

import { ScriptWorkflowGraph } from "../automations/script-view/workflow-graph";
import { AutomationSubpageTabs } from "../automations/shared";
import {
  MARKETPLACE_ARTIFACT_ROOT_PATH,
  type MarketplaceArtifactExplorerData,
  type MarketplaceArtifactSelectedContent,
  type MarketplaceArtifactWorkflowSource,
} from "./artifact-files-model";

type MarketplaceArtifactTab = "overview" | "workflows" | "files";
type ReadyArtifactData = Extract<MarketplaceArtifactExplorerData, { state: "ready" }>;

type VisualizedMarketplaceArtifactWorkflow = {
  path: string;
  visualization: WorkflowVisualizationSnapshot;
};

const EMPTY_RUNTIME_TOOL_CALLS: ReadonlyMap<string, readonly ResolvedWorkflowRuntimeToolCall[]> =
  new Map();

export function MarketplaceArtifactFiles({
  data,
  selectedContent = null,
}: {
  data: MarketplaceArtifactExplorerData;
  selectedContent?: MarketplaceArtifactSelectedContent | null;
}) {
  if (data.state !== "ready") {
    return (
      <section className="bo-panel-surface bg-[var(--bo-panel)] p-5 md:p-6">
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

  return <ReadyMarketplaceArtifactFiles data={data} selectedContent={selectedContent} />;
}

function ReadyMarketplaceArtifactFiles({
  data,
  selectedContent,
}: {
  data: ReadyArtifactData;
  selectedContent: MarketplaceArtifactSelectedContent | null;
}) {
  const location = useLocation();
  const overview = useFetcher<string>();
  const [overviewRequested, setOverviewRequested] = useState(false);
  const requestedTab = new URLSearchParams(location.search).get("artifactTab");
  const activeTab: MarketplaceArtifactTab =
    requestedTab === "overview" || requestedTab === "workflows" || requestedTab === "files"
      ? requestedTab
      : "files";
  const overviewPath =
    findMarketplaceArtifactEntry(data, "README.md")?.kind === "file"
      ? `${MARKETPLACE_ARTIFACT_ROOT_PATH}/README.md`
      : null;
  const overviewResourcePath = overviewPath
    ? buildArtifactFileResourcePath(location.pathname, overviewPath)
    : null;
  const loadOverview = () => {
    if (overviewResourcePath) {
      setOverviewRequested(true);
      void overview.load(overviewResourcePath);
    }
  };
  const tabs = (["overview", "workflows", "files"] as const).map((tab) => ({
    id: tab,
    label: tab === "overview" ? "Overview" : tab === "workflows" ? "Workflows" : "Files",
    to: buildArtifactTabPath(location.pathname, location.search, tab),
    onSelect: tab === "overview" ? loadOverview : undefined,
  }));

  return (
    <section className="bo-panel-surface bg-[var(--bo-panel)] p-5 md:p-6">
      <AutomationSubpageTabs
        tabs={tabs}
        activeTab={activeTab}
        ariaLabel="Marketplace package sections"
      />

      {activeTab === "overview" ? (
        <MarketplaceArtifactOverview
          path={overviewPath}
          requested={overviewRequested}
          loading={overview.state !== "idle"}
          markdown={typeof overview.data === "string" ? overview.data : null}
          onLoad={loadOverview}
        />
      ) : activeTab === "workflows" ? (
        <MarketplaceArtifactWorkflows data={data} selectedContent={selectedContent} />
      ) : (
        <MarketplaceArtifactExplorer data={data} selectedContent={selectedContent} />
      )}
    </section>
  );
}

function MarketplaceArtifactExplorer({
  data,
  selectedContent,
}: {
  data: ReadyArtifactData;
  selectedContent: MarketplaceArtifactSelectedContent | null;
}) {
  const location = useLocation();
  const search = new URLSearchParams(location.search);
  const explicitRequestedPath = search.get("artifactPath")?.trim() || null;
  const entriesByExplorerPath = useMemo(
    () => createMarketplaceArtifactEntriesByExplorerPath(data.fileTree.entries),
    [data.fileTree.entries],
  );
  const defaultPath = `${MARKETPLACE_ARTIFACT_ROOT_PATH}/${data.selectedVersion}/`;
  const requestedPath = explicitRequestedPath ?? defaultPath;
  const selectedPath =
    requestedPath === MARKETPLACE_ARTIFACT_ROOT_PATH || entriesByExplorerPath.has(requestedPath)
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
        rootPath: MARKETPLACE_ARTIFACT_ROOT_PATH,
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
          explicitRequestedPath !== MARKETPLACE_ARTIFACT_ROOT_PATH &&
          !entriesByExplorerPath.has(explicitRequestedPath)
            ? `Artifact path '${explicitRequestedPath}' could not be found.`
            : null
        }
        treeAriaLabel="Marketplace artifact files"
        rootIcon={PackageOpen}
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
        buildNodeTo={(path) => {
          const entry = entriesByExplorerPath.get(path);
          return buildArtifactSelectionPath(
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

function MarketplaceArtifactWorkflows({
  data,
  selectedContent,
}: {
  data: ReadyArtifactData;
  selectedContent: MarketplaceArtifactSelectedContent | null;
}) {
  const location = useLocation();
  const workflowPaths = useMemo(() => {
    const workflowPathPrefix = `${data.selectedVersion}/automations/`;
    const paths: string[] = [];

    for (const entry of data.fileTree.entries) {
      if (
        entry.kind === "file" &&
        entry.path.startsWith(workflowPathPrefix) &&
        entry.path.toLowerCase().endsWith(".workflow.js")
      ) {
        paths.push(`${MARKETPLACE_ARTIFACT_ROOT_PATH}/${entry.path}`);
      }
    }

    return paths.sort((left, right) => left.localeCompare(right));
  }, [data.fileTree.entries, data.selectedVersion]);
  const requestedPath = new URLSearchParams(location.search).get("artifactPath")?.trim();
  const selectedPath =
    requestedPath && workflowPaths.includes(requestedPath) ? requestedPath : null;

  if (workflowPaths.length === 0) {
    return (
      <MarketplaceArtifactMessage
        title="No workflows found"
        description="This release does not contain any .workflow.js files."
      />
    );
  }

  const workflowSource: MarketplaceArtifactWorkflowSource | null =
    selectedPath && selectedContent?.path === selectedPath
      ? { path: selectedPath, source: selectedContent.text }
      : null;

  return (
    <div className="mt-5">
      <div
        role="tablist"
        aria-label="Published workflows"
        className="flex gap-1 overflow-x-auto border-b border-[color:var(--bo-border)]"
      >
        {workflowPaths.map((path) => {
          const selected = selectedPath === path;
          return (
            <Link
              key={path}
              to={buildArtifactSelectionPath(
                location.pathname,
                location.search,
                "workflows",
                path,
                true,
              )}
              role="tab"
              aria-selected={selected}
              preventScrollReset
              className={
                selected
                  ? "flex min-h-10 shrink-0 items-center border-b-2 border-[color:var(--bo-accent)] px-2 font-mono text-[10px] text-[var(--bo-accent-fg)]"
                  : "flex min-h-10 shrink-0 items-center border-b-2 border-transparent px-2 font-mono text-[10px] text-[var(--bo-muted)] hover:text-[var(--bo-fg)]"
              }
            >
              {path.split("/").at(-1)}
            </Link>
          );
        })}
      </div>

      {!selectedPath ? (
        <MarketplaceArtifactMessage title="Select a workflow" />
      ) : workflowSource ? (
        <MarketplaceArtifactWorkflowGraphs workflows={[workflowSource]} />
      ) : (
        <MarketplaceArtifactMessage title="Workflow source unavailable" />
      )}
    </div>
  );
}

export function MarketplaceArtifactWorkflowGraphs({
  workflows: workflowSources,
}: {
  workflows: readonly MarketplaceArtifactWorkflowSource[];
}) {
  const workflows = useMemo(
    () =>
      workflowSources.flatMap((workflow): VisualizedMarketplaceArtifactWorkflow[] => {
        const visualization = visualizeWorkflowSource(workflow.path, workflow.source, {
          fallbackName: workflow.path
            .split("/")
            .at(-1)
            ?.replace(/\.workflow\.js$/iu, ""),
        });
        return visualization.graph.nodes.some((node) => node.kind === "workflow")
          ? [{ path: workflow.path, visualization }]
          : [];
      }),
    [workflowSources],
  );

  if (workflows.length === 0) {
    return (
      <MarketplaceArtifactMessage
        title="No workflow definition found"
        description="This file does not contain a direct defineWorkflow() call."
      />
    );
  }

  return (
    <div className="mt-5 space-y-5">
      {workflows.map((workflow) => (
        <section
          key={workflow.path}
          className="overflow-hidden shadow-[0_0_0_1px_var(--bo-border)]"
        >
          <div className="flex min-h-11 items-center justify-between gap-3 border-b border-[color:var(--bo-border)] bg-[var(--bo-panel)] px-3 py-2.5">
            <p className="min-w-0 truncate font-mono text-[10px] text-[var(--bo-muted)]">
              {workflow.path}
            </p>
            <span className="shrink-0 text-[9px] font-semibold tracking-[0.16em] text-[var(--bo-muted-2)] uppercase">
              Workflow graph
            </span>
          </div>
          <ScriptWorkflowGraph
            visualization={workflow.visualization}
            detailMode="simple"
            runtimeToolCallsByStepId={EMPTY_RUNTIME_TOOL_CALLS}
            selectedRun={null}
          />
        </section>
      ))}
    </div>
  );
}

function MarketplaceArtifactOverview({
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
      <MarketplaceArtifactMessage
        title="No package overview"
        description="Add a top-level README.md to provide an overview for this Marketplace listing."
      />
    );
  }
  if (!requested) {
    return (
      <MarketplaceArtifactMessage
        title="Package overview"
        action={<LoadContentButton onClick={onLoad}>Load overview</LoadContentButton>}
      />
    );
  }
  if (loading || markdown === null) {
    return <MarketplaceArtifactMessage title="Loading overview…" />;
  }

  return (
    <article className="mt-5">
      <Streamdown
        mode="streaming"
        className="bo-session-markdown max-w-4xl text-sm leading-7 text-pretty"
        controls={{ code: true, table: true }}
        skipHtml
      >
        {markdown}
      </Streamdown>
    </article>
  );
}

function MarketplaceArtifactMessage({
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
    <button
      type="button"
      onClick={onClick}
      className="bo-control-surface mt-4 min-h-9 bg-[var(--bo-panel)] px-3 text-[9px] font-semibold tracking-[0.14em] text-[var(--bo-muted)] uppercase transition-colors hover:text-[var(--bo-fg)]"
    >
      {children}
    </button>
  );
}

function createMarketplaceArtifactEntriesByExplorerPath(
  entries: readonly FileTreeEntry[],
): ReadonlyMap<string, FileTreeEntry> {
  return new Map(
    entries.map((entry) => [
      `${MARKETPLACE_ARTIFACT_ROOT_PATH}/${entry.path}${entry.kind === "directory" ? "/" : ""}`,
      entry,
    ]),
  );
}

function findMarketplaceArtifactEntry(
  data: ReadyArtifactData,
  relativePath: string,
): FileTreeEntry | undefined {
  return data.fileTree.entries.find((entry) => entry.path === relativePath);
}

function buildArtifactTabPath(
  pathname: string,
  currentSearch: string,
  tab: MarketplaceArtifactTab,
): string {
  const search = new URLSearchParams(currentSearch);
  search.set("artifactTab", tab);
  if (tab === "overview") {
    search.delete("artifactPath");
    search.delete("artifactContent");
  }
  return `${pathname}?${search}`;
}

function buildArtifactSelectionPath(
  pathname: string,
  currentSearch: string,
  tab: Extract<MarketplaceArtifactTab, "files" | "workflows">,
  path: string,
  loadTextContent: boolean,
): string {
  const search = new URLSearchParams(currentSearch);
  search.set("artifactTab", tab);
  search.set("artifactPath", path);
  if (loadTextContent) {
    search.set("artifactContent", "text");
  } else {
    search.delete("artifactContent");
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

function buildArtifactFileResourcePath(pathname: string, path: string): string {
  const resourcePath = pathname.endsWith("/")
    ? `${pathname}artifact-file`
    : `${pathname}/artifact-file`;
  const search = new URLSearchParams({ artifactPath: path });
  return `${resourcePath}?${search}`;
}

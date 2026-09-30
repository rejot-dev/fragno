import {
  FileTreeExplorer,
  type FileTreeExplorerNode,
} from "@fragno-private/design-system/file-tree-explorer";
import { Icon, type IconName } from "@fragno-private/design-system/icon";
import { Input } from "@fragno-private/design-system/input";
import { BackofficeSystemState } from "@fragno-private/design-system/system-state";
import { useMemo, useState, type ReactNode } from "react";
import { Form, Link, type To } from "react-router";

import type { FileTree, FileTreeEntry } from "@/file-collection/file-collection";

import { resolveFilesContentRenderer, type WorkflowFileRouting } from "./content-renderers";

type FilesExplorerRootKind = "static" | "upload" | "custom";
type FilesExplorerPersistence = "ephemeral" | "persistent" | "session";

type FilesExplorerDetailField = {
  label: string;
  value: string;
};

type FilesExplorerNode = {
  kind: "root" | "directory" | "file";
  path: string;
  title: string;
  sizeBytes?: number | null;
  contentType?: string | null;
  updatedAt?: string | null;
  fileCount?: number;
  folderCount?: number;
  children: FilesExplorerNode[];
};

type ExplorerNodeDetail = {
  node: FilesExplorerNode;
  description: string;
  fields: FilesExplorerDetailField[];
  metadata: Record<string, unknown> | null;
  textContent: string | null;
};

const PUBLIC_FILE_METADATA_FIELDS = [
  "provider",
  "filename",
  "status",
  "visibility",
  "createdAt",
  "previewUrl",
] as const;

const UTC_DATE_TIME_FORMATTER = new Intl.DateTimeFormat("en", {
  dateStyle: "medium",
  timeStyle: "short",
  timeZone: "UTC",
});

export type FilesExplorerSource = {
  tree: FileTree;
  rootPath: string;
  rootTitle: string;
  rootDescription?: string;
  rootKind?: FilesExplorerRootKind;
  readOnly?: boolean;
  persistence?: FilesExplorerPersistence;
  detailFields?: readonly FilesExplorerDetailField[];
};

export type FilesExplorerSelectedContent = {
  path: string;
  text: string;
};

type FilesExplorerSearchMatch = {
  path: string;
  line: number;
  column: number;
  text: string;
  contextBefore: readonly string[];
  contextAfter: readonly string[];
};

export type FilesExplorerSearchGroup = {
  rootPath: string;
  rootTitle: string;
  matches: readonly FilesExplorerSearchMatch[];
};

type FilesExplorerContentSearch = {
  query: string;
  groups: readonly FilesExplorerSearchGroup[];
};

export type FilesExplorerViewProps = {
  sources: readonly FilesExplorerSource[];
  selectedPath: string | null;
  selectedContent?: FilesExplorerSelectedContent | null;
  loadError: string | null;
  buildNodeTo: (path: string) => To;
  onNodeSelect?: (node: FileTreeExplorerNode) => void;
  buildDownloadHref?: (path: string) => string | null;
  defaultCollapsedRootPaths?: readonly string[];
  collapsedRootPaths?: readonly string[];
  onCollapsedRootPathsChange?: (paths: readonly string[]) => void;
  treeAriaLabel?: string;
  rootIcon?: IconName;
  rootSelection?: "summary" | "detail";
  detailHeadingLevel?: 2 | 3 | 4;
  emptySelection?: ReactNode;
  contentSearch?: FilesExplorerContentSearch;
  workflowRouting: WorkflowFileRouting;
};

export function FilesExplorerView({
  sources,
  selectedPath,
  selectedContent = null,
  loadError,
  buildNodeTo,
  onNodeSelect,
  buildDownloadHref,
  defaultCollapsedRootPaths = [],
  collapsedRootPaths,
  onCollapsedRootPathsChange,
  treeAriaLabel = "Files explorer",
  rootIcon = "hard-drive",
  rootSelection = "summary",
  detailHeadingLevel = 2,
  emptySelection = null,
  contentSearch,
  workflowRouting,
}: FilesExplorerViewProps) {
  const [isMobileTreeCollapsed, setIsMobileTreeCollapsed] = useState(false);
  const { tree, selectedDetail } = useMemo(
    () => createExplorerViewModel(sources, selectedPath, selectedContent),
    [selectedContent, selectedPath, sources],
  );
  const selectedRoot =
    rootSelection === "summary" && selectedDetail?.node.kind === "root" ? selectedDetail : null;

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-4">
      {loadError ? <MessageTone tone="error">{loadError}</MessageTone> : null}

      {tree.length === 0 ? (
        <BackofficeSystemState
          tone="empty"
          label="No file sources"
          title="This workspace has no files yet."
          description="Files will appear here when a collection becomes available."
        />
      ) : (
        // The tree column plus the 1px gap divider matches the top bar's w-72 project selector,
        // whose border-r sits inside its width, so both dividers line up.
        <section
          className={`${isMobileTreeCollapsed ? "grid-rows-[auto_minmax(22rem,1fr)]" : "grid-rows-[auto_minmax(22rem,1fr)_minmax(22rem,1fr)]"} grid min-h-[22rem] flex-1 gap-px overflow-hidden bg-[var(--bo-border)] shadow-[0_0_0_1px_var(--bo-border)] md:min-h-0 md:grid-cols-[calc(--spacing(72)-1px)_minmax(0,1fr)] md:grid-rows-1`}
        >
          <button
            type="button"
            aria-expanded={!isMobileTreeCollapsed}
            aria-controls="files-explorer-tree"
            onClick={() => {
              setIsMobileTreeCollapsed((collapsed) => !collapsed);
            }}
            className="flex min-h-10 items-center justify-between bg-[var(--bo-sidebar-bg)] px-3 text-[10px] font-semibold tracking-[0.18em] text-[var(--bo-muted)] uppercase transition-[background-color,color] duration-150 ease-out hover:bg-[var(--bo-panel)] hover:text-[var(--bo-fg)] focus-visible:ring-2 focus-visible:ring-[color:var(--bo-accent)]/30 focus-visible:outline-none md:hidden"
          >
            <span>{isMobileTreeCollapsed ? "Show file tree" : "Hide file tree"}</span>
            {isMobileTreeCollapsed ? (
              <Icon name="chevrons-right" className="size-4" />
            ) : (
              <Icon name="chevrons-left" className="size-4" />
            )}
          </button>

          <aside
            id="files-explorer-tree"
            className={`${isMobileTreeCollapsed ? "hidden md:flex" : "flex"} min-h-0 flex-col overflow-hidden bg-[var(--bo-sidebar-bg)]`}
          >
            <FileTreeExplorer
              nodes={tree}
              selectedPath={selectedPath}
              buildNodeTo={buildNodeTo}
              onNodeSelect={onNodeSelect}
              defaultCollapsedRootPaths={defaultCollapsedRootPaths}
              collapsedRootPaths={collapsedRootPaths}
              onCollapsedRootPathsChange={onCollapsedRootPathsChange}
              ariaLabel={treeAriaLabel}
              rootIcon={rootIcon}
            />
          </aside>

          <div className="flex min-h-0 min-w-0 flex-col bg-[var(--bo-panel)]">
            {contentSearch ? (
              <div className="shrink-0 border-b border-[var(--bo-border)] bg-[var(--bo-panel-2)] p-3 md:p-4">
                <Form method="get" className="relative">
                  <Icon
                    name="search"
                    className="pointer-events-none absolute top-1/2 left-3.5 size-4 -translate-y-1/2 text-[var(--bo-muted-2)]"
                  />
                  <Input
                    key={contentSearch.query}
                    type="text"
                    role="searchbox"
                    name="q"
                    defaultValue={contentSearch.query}
                    placeholder="Search file contents"
                    aria-label="Search file contents"
                    className="min-h-11 w-full pr-11 pl-10"
                  />
                  {contentSearch.query ? (
                    <Link
                      to={buildNodeTo(selectedPath ?? tree[0]?.path ?? "")}
                      aria-label="Clear file search"
                      className="absolute top-1/2 right-0 flex size-10 -translate-y-1/2 items-center justify-center text-[var(--bo-muted-2)] transition-[scale,color] duration-150 ease-out hover:text-[var(--bo-fg)] focus-visible:ring-2 focus-visible:ring-[color:var(--bo-accent)]/30 focus-visible:outline-none active:scale-[0.96]"
                    >
                      <Icon name="x" className="size-4" />
                    </Link>
                  ) : null}
                </Form>
              </div>
            ) : null}

            <div className="min-h-0 flex-1">
              {contentSearch?.query ? (
                <FilesSearchResults
                  query={contentSearch.query}
                  groups={contentSearch.groups}
                  buildNodeTo={buildNodeTo}
                />
              ) : selectedRoot ? (
                <RootSelectionState
                  detail={selectedRoot}
                  icon={rootIcon}
                  headingLevel={detailHeadingLevel}
                />
              ) : selectedDetail ? (
                <ExplorerNodeDetailPanel
                  detail={selectedDetail}
                  buildDownloadHref={buildDownloadHref}
                  rootIcon={rootIcon}
                  headingLevel={detailHeadingLevel}
                  workflowRouting={workflowRouting}
                />
              ) : (
                emptySelection
              )}
            </div>
          </div>
        </section>
      )}
    </div>
  );
}

function FilesSearchResults({
  query,
  groups,
  buildNodeTo,
}: {
  query: string;
  groups: readonly FilesExplorerSearchGroup[];
  buildNodeTo: (path: string) => To;
}) {
  const matchCount = groups.reduce((count, group) => count + group.matches.length, 0);

  if (matchCount === 0) {
    return (
      <div className="flex min-h-full items-center justify-center p-6">
        <div className="max-w-sm border border-dashed border-[var(--bo-border)] px-6 py-8 text-center">
          <p className="text-sm font-medium text-[var(--bo-fg)]">No content matches</p>
          <p className="mt-1.5 text-xs text-pretty text-[var(--bo-muted-2)]">
            No indexed files contain “{query}”.
          </p>
        </div>
      </div>
    );
  }

  return (
    <nav
      aria-label="File search results"
      className="backoffice-scroll h-full overflow-x-hidden overflow-y-auto p-4 md:p-5"
    >
      <div className="flex items-end justify-between gap-4 border-b border-[var(--bo-border)] pb-3">
        <div>
          <p className="text-[9px] font-semibold tracking-[0.2em] text-[var(--bo-muted-2)] uppercase">
            Search results
          </p>
          <h2 className="mt-1 text-xl font-semibold tracking-tight text-[var(--bo-fg)]">
            “{query}”
          </h2>
        </div>
        <p className="shrink-0 text-[10px] text-[var(--bo-muted-2)]">
          {matchCount} {matchCount === 1 ? "match" : "matches"}
        </p>
      </div>

      <div className="mt-5 space-y-6">
        {groups.map((group) =>
          group.matches.length > 0 ? (
            <section key={group.rootPath}>
              <p className="text-[9px] font-semibold tracking-[0.16em] text-[var(--bo-muted-2)] uppercase">
                {group.rootTitle}
              </p>
              <div className="mt-2 grid gap-2">
                {groupSearchMatchesByPath(group.matches).map(({ path, matches }) => (
                  <Link
                    key={path}
                    to={buildNodeTo(path)}
                    preventScrollReset
                    className="block min-w-0 bg-[var(--bo-panel-2)] px-4 py-3 shadow-[inset_0_0_0_1px_var(--bo-border)] transition-[background-color,box-shadow] hover:bg-[var(--bo-accent-bg)] hover:shadow-[inset_0_0_0_1px_var(--bo-accent)] focus-visible:ring-2 focus-visible:ring-[color:var(--bo-accent)]/30 focus-visible:outline-none"
                  >
                    <span className="flex min-w-0 items-center justify-between gap-3">
                      <span className="truncate text-sm font-medium text-[var(--bo-fg)]">
                        {path}
                      </span>
                      <span className="shrink-0 text-[9px] text-[var(--bo-muted-2)] tabular-nums">
                        {matches.length} {matches.length === 1 ? "match" : "matches"}
                      </span>
                    </span>
                    <span className="mt-2 grid gap-1.5">
                      {matches.map((match) => (
                        <span
                          key={`${path}:${match.line}:${match.column}`}
                          className="block min-w-0 truncate font-mono text-[11px] leading-5 text-[var(--bo-muted)]"
                        >
                          <span className="text-[var(--bo-accent)] tabular-nums">
                            {match.line}:{match.column}
                          </span>{" "}
                          · {searchMatchPreview(match)}
                        </span>
                      ))}
                    </span>
                  </Link>
                ))}
              </div>
            </section>
          ) : null,
        )}
      </div>
    </nav>
  );
}

function groupSearchMatchesByPath(matches: readonly FilesExplorerSearchMatch[]) {
  const matchesByPath = new Map<string, FilesExplorerSearchMatch[]>();

  for (const match of matches) {
    matchesByPath.set(match.path, [...(matchesByPath.get(match.path) ?? []), match]);
  }

  return [...matchesByPath].map(([path, pathMatches]) => ({ path, matches: pathMatches }));
}

function searchMatchPreview(match: FilesExplorerSearchMatch): string {
  return [...match.contextBefore, match.text, ...match.contextAfter].join(" ").trim();
}

function ExplorerNodeDetailPanel({
  detail,
  buildDownloadHref,
  rootIcon,
  headingLevel,
  workflowRouting,
}: {
  detail: ExplorerNodeDetail;
  buildDownloadHref?: (path: string) => string | null;
  rootIcon: IconName;
  headingLevel: 2 | 3 | 4;
  workflowRouting: WorkflowFileRouting;
}) {
  const selectedWorkflowRouting: WorkflowFileRouting =
    workflowRouting.status === "ready"
      ? {
          status: "ready",
          routes: workflowRouting.routes.filter(
            (route) =>
              route.action.kind === "start_workflow" &&
              route.action.workflowScriptPath === detail.node.path,
          ),
        }
      : workflowRouting;
  const contentPreview = {
    title: detail.node.title,
    contentType: detail.node.contentType ?? null,
    metadata: detail.metadata,
    textContent: detail.textContent,
    workflowRouting: selectedWorkflowRouting,
  };
  const contentRenderer = resolveFilesContentRenderer(contentPreview);
  const contentPreamble = contentRenderer?.renderBefore?.(contentPreview) ?? null;
  const downloadHref =
    detail.node.kind === "file" ? (buildDownloadHref?.(detail.node.path) ?? null) : null;
  const Heading = getHeadingComponent(headingLevel);
  const detailIcon: IconName =
    detail.node.kind === "root" ? rootIcon : detail.node.kind === "directory" ? "folder" : "file";
  const displayedMetadata = Object.fromEntries(
    PUBLIC_FILE_METADATA_FIELDS.flatMap((field) => {
      const value = detail.metadata?.[field];
      return value === undefined ? [] : [[field, value]];
    }),
  );

  return (
    <section className="flex h-full min-h-0 flex-col p-4 md:p-5">
      <div className="flex shrink-0 flex-wrap items-start justify-between gap-4 pb-4">
        <div className="flex min-w-0 items-start gap-3">
          <span className="flex size-10 shrink-0 items-center justify-center bg-[var(--bo-panel-2)] text-[var(--bo-accent)] shadow-[inset_0_0_0_1px_var(--bo-border)]">
            <Icon name={detailIcon} className="size-[18px]" />
          </span>
          <div className="min-w-0">
            <p className="text-[9px] font-semibold tracking-[0.2em] text-[var(--bo-muted-2)] uppercase">
              {detail.node.kind}
            </p>
            <Heading className="mt-1 text-2xl font-semibold tracking-tight text-balance break-all text-[var(--bo-fg)]">
              {detail.node.title}
            </Heading>
          </div>
        </div>
        <div className="relative flex items-center gap-2">
          {downloadHref ? (
            <a
              href={downloadHref}
              className="bo-control-surface inline-flex min-h-10 items-center gap-2 bg-[var(--bo-panel-2)] px-3.5 text-[10px] font-semibold tracking-[0.2em] text-[var(--bo-muted)] uppercase transition-[scale,background-color,color,box-shadow] duration-150 ease-out hover:bg-[var(--bo-panel)] hover:text-[var(--bo-fg)] focus-visible:ring-2 focus-visible:ring-[color:var(--bo-accent)]/30 focus-visible:outline-none active:scale-[0.96]"
            >
              <Icon name="download" className="h-3.5 w-3.5" />
              Download
            </a>
          ) : null}
          <details className="group relative">
            <summary className="bo-control-surface flex size-10 cursor-pointer list-none items-center justify-center bg-[var(--bo-panel-2)] text-[var(--bo-muted)] transition-[scale,background-color,color,box-shadow] duration-150 ease-out marker:content-none hover:bg-[var(--bo-panel)] hover:text-[var(--bo-fg)] focus-visible:ring-2 focus-visible:ring-[color:var(--bo-accent)]/30 focus-visible:outline-none active:scale-[0.96] [&::-webkit-details-marker]:hidden">
              <Icon name="info" className="size-4" />
              <span className="sr-only">File information</span>
            </summary>
            <div className="backoffice-scroll absolute top-12 right-0 z-20 max-h-[calc(100dvh-8rem)] w-[min(24rem,calc(100vw-2rem))] overflow-y-auto overscroll-contain bg-[var(--bo-panel)] p-3 shadow-[0_12px_32px_rgba(0,0,0,0.2),0_0_0_1px_var(--bo-border)]">
              <p className="text-[9px] font-semibold tracking-[0.18em] text-[var(--bo-muted-2)] uppercase">
                File information
              </p>
              <dl className="mt-3 grid gap-2 sm:grid-cols-2">
                {detail.fields.map((field) => (
                  <div
                    key={`${field.label}-${field.value}`}
                    className="min-w-0 bg-[var(--bo-panel-2)] px-3 py-2.5"
                  >
                    <dt className="text-[9px] tracking-[0.18em] text-[var(--bo-muted-2)] uppercase">
                      {field.label}
                    </dt>
                    <dd className="mt-1.5 text-xs break-all text-[var(--bo-muted)]">
                      {field.value}
                    </dd>
                  </div>
                ))}
              </dl>
              {Object.keys(displayedMetadata).length > 0 ? (
                <pre className="backoffice-scroll mt-3 max-h-56 overflow-auto bg-[var(--bo-panel-2)] p-3 font-mono text-[11px] leading-5 text-[var(--bo-muted)]">
                  {JSON.stringify(displayedMetadata, null, 2)}
                </pre>
              ) : null}
            </div>
          </details>
        </div>
      </div>

      {contentPreamble ? <div className="mt-2 shrink-0">{contentPreamble}</div> : null}

      {contentRenderer ? (
        <div className="mt-2 flex min-h-0 flex-1 flex-col bg-[var(--bo-panel-2)] p-3 shadow-[inset_0_0_0_1px_var(--bo-border)] md:p-4">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <p className="text-[9px] font-semibold tracking-[0.2em] text-[var(--bo-muted-2)] uppercase">
              {contentRenderer.label}
            </p>
            {detail.node.contentType ? (
              <p className="text-[9px] text-[var(--bo-muted-2)]">{detail.node.contentType}</p>
            ) : null}
          </div>
          <div className="mt-3 min-h-0 flex-1 overflow-auto">
            {contentRenderer.render(contentPreview)}
          </div>
        </div>
      ) : null}
    </section>
  );
}

function RootSelectionState({
  detail,
  icon,
  headingLevel,
}: {
  detail: ExplorerNodeDetail;
  icon: IconName;
  headingLevel: 2 | 3 | 4;
}) {
  const isEmpty = (detail.node.fileCount ?? 0) + (detail.node.folderCount ?? 0) === 0;
  const Heading = getHeadingComponent(headingLevel);

  return (
    <section className="flex min-h-full items-center justify-center bg-[var(--bo-panel)] p-6">
      <div className="max-w-sm text-center">
        <div className="bo-control-surface mx-auto flex size-12 items-center justify-center bg-[var(--bo-panel-2)] text-[var(--bo-accent)]">
          <Icon name={icon} className="size-5" />
        </div>
        <p className="mt-4 text-[9px] tracking-[0.18em] text-[var(--bo-muted-2)] uppercase">
          Root selected
        </p>
        <Heading className="mt-2 text-xl font-semibold tracking-tight text-balance text-[var(--bo-fg)]">
          {detail.node.title}
        </Heading>
        <p className="mt-2 text-sm text-pretty text-[var(--bo-muted)]">
          {isEmpty
            ? "This root is empty. Files and folders will appear here when they become available."
            : "Choose a file or folder in the sidebar to inspect its contents."}
        </p>
      </div>
    </section>
  );
}

type ExplorerViewNode = {
  explorerNode: FilesExplorerNode;
  entry: FileTreeEntry | null;
  source: FilesExplorerSource;
  children: ExplorerViewNode[];
};

function createExplorerViewModel(
  sources: readonly FilesExplorerSource[],
  selectedPath: string | null,
  selectedContent: FilesExplorerSelectedContent | null,
): {
  tree: FilesExplorerNode[];
  selectedDetail: ExplorerNodeDetail | null;
} {
  const nodesByPath = new Map<string, ExplorerViewNode>();
  const roots = sources.map((source) => {
    const rootPath = source.rootPath.replace(/\/$/u, "");
    const root: ExplorerViewNode = {
      explorerNode: {
        kind: "root",
        path: rootPath,
        title: source.rootTitle,
        children: [],
      },
      entry: null,
      source,
      children: [],
    };
    nodesByPath.set(rootPath, root);

    const nodesByRelativePath = new Map<string, ExplorerViewNode>();
    for (const entry of source.tree.entries) {
      const path = `${rootPath}/${entry.path}${entry.kind === "directory" ? "/" : ""}`;
      const node: ExplorerViewNode = {
        explorerNode: {
          kind: entry.kind,
          path,
          title: entry.displayName ?? leafName(entry.path),
          ...(entry.kind === "file"
            ? {
                sizeBytes: entry.sizeBytes,
                contentType: entry.contentType,
              }
            : {}),
          updatedAt: entry.updatedAt,
          children: [],
        },
        entry,
        source,
        children: [],
      };
      nodesByRelativePath.set(entry.path, node);
      nodesByPath.set(path, node);
    }

    for (const [relativePath, node] of nodesByRelativePath) {
      const parentPath = relativePath.includes("/")
        ? relativePath.slice(0, relativePath.lastIndexOf("/"))
        : null;
      const parent = parentPath ? nodesByRelativePath.get(parentPath) : root;
      parent?.children.push(node);
    }

    populateExplorerChildren(root);
    return root.explorerNode;
  });

  const selectedNode = selectedPath ? (nodesByPath.get(selectedPath) ?? null) : null;
  return {
    tree: roots,
    selectedDetail: selectedNode
      ? createExplorerNodeDetail(
          selectedNode,
          selectedContent?.path === selectedNode.explorerNode.path ? selectedContent.text : null,
        )
      : null,
  };
}

function populateExplorerChildren(node: ExplorerViewNode): void {
  node.children.sort((left, right) => {
    const kindOrder =
      (left.explorerNode.kind === "directory" ? 0 : 1) -
      (right.explorerNode.kind === "directory" ? 0 : 1);
    return (
      kindOrder ||
      left.explorerNode.title.localeCompare(right.explorerNode.title, "en", {
        numeric: true,
        sensitivity: "base",
      })
    );
  });

  for (const child of node.children) {
    populateExplorerChildren(child);
  }

  node.explorerNode.children = node.children.map((child) => child.explorerNode);
  if (node.explorerNode.kind !== "file") {
    node.explorerNode.folderCount = node.children.filter(
      (child) => child.explorerNode.kind === "directory",
    ).length;
    node.explorerNode.fileCount = node.children.filter(
      (child) => child.explorerNode.kind === "file",
    ).length;
  }
}

function createExplorerNodeDetail(
  node: ExplorerViewNode,
  textContent: string | null,
): ExplorerNodeDetail {
  const { explorerNode, source } = node;
  const fields: FilesExplorerDetailField[] = [
    { label: "Path", value: explorerNode.path },
    {
      label: "Type",
      value:
        explorerNode.kind === "root"
          ? "Root"
          : explorerNode.kind === "directory"
            ? "Folder"
            : "File",
    },
    { label: "Root", value: source.rootTitle },
    { label: "Kind", value: source.rootKind ?? "custom" },
    { label: "Access", value: source.readOnly === false ? "Writable" : "Read-only" },
    { label: "Persistence", value: source.persistence ?? "persistent" },
    ...(source.detailFields ?? []),
  ];

  if (explorerNode.kind === "file") {
    if (explorerNode.sizeBytes !== null && explorerNode.sizeBytes !== undefined) {
      fields.push({ label: "Size", value: formatBytesValue(explorerNode.sizeBytes) });
    }
    if (explorerNode.contentType) {
      fields.push({ label: "Content type", value: explorerNode.contentType });
    }
    if (explorerNode.updatedAt) {
      fields.push({ label: "Updated", value: formatDateValue(explorerNode.updatedAt) });
    }
  } else {
    fields.push(
      { label: "Folders", value: String(explorerNode.folderCount ?? 0) },
      { label: "Files", value: String(explorerNode.fileCount ?? 0) },
    );
  }

  return {
    node: explorerNode,
    description:
      source.rootDescription ??
      (explorerNode.kind === "root"
        ? `Top-level file tree at ${source.rootPath}.`
        : `${explorerNode.kind === "directory" ? "Folder" : "File"} in ${source.rootTitle}.`),
    fields,
    metadata: node.entry?.metadata ?? null,
    textContent: explorerNode.kind === "file" ? textContent : null,
  };
}

function leafName(path: string): string {
  return path.replace(/\/$/u, "").split("/").at(-1) ?? path;
}

function formatBytesValue(value: number): string {
  if (value === 0) {
    return "0 B";
  }
  const units = ["B", "KB", "MB", "GB", "TB"];
  const exponent = Math.min(Math.floor(Math.log(value) / Math.log(1024)), units.length - 1);
  const size = value / 1024 ** exponent;
  return `${size >= 10 || exponent === 0 ? size.toFixed(0) : size.toFixed(1)} ${units[exponent]}`;
}

function formatDateValue(value: string | Date): string {
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? "—" : UTC_DATE_TIME_FORMATTER.format(date);
}

function MessageTone({ tone, children }: { tone: "error" | "success"; children: ReactNode }) {
  const toneClass =
    tone === "error"
      ? "border-[color:var(--bo-failed)] bg-[var(--bo-failed-bg)] text-[var(--bo-failed)]"
      : "border-[color:var(--bo-live)] bg-[var(--bo-live-bg)] text-[var(--bo-live)]";

  return <section className={`border p-3 text-sm ${toneClass}`}>{children}</section>;
}

function getHeadingComponent(level: 2 | 3 | 4): "h2" | "h3" | "h4" {
  if (level === 3) {
    return "h3";
  }
  if (level === 4) {
    return "h4";
  }
  return "h2";
}

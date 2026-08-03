import {
  ChevronDown,
  ChevronRight,
  Download,
  File as FileIcon,
  Folder,
  HardDrive,
  type LucideIcon,
} from "lucide-react";
import { useMemo, useState, type ReactNode } from "react";
import { Link, type To } from "react-router";

import type { FileTree, FileTreeEntry } from "@/file-collection/file-collection";

import { BackofficeSystemState } from "../system-state";
import { resolveFilesContentRenderer } from "./content-renderers";

export type FilesExplorerRootKind = "static" | "upload" | "custom";
export type FilesExplorerPersistence = "ephemeral" | "persistent" | "session";

export type FilesExplorerDetailField = {
  label: string;
  value: string;
};

export type FilesExplorerNode = {
  kind: "root" | "directory" | "file";
  path: string;
  title: string;
  sizeBytes?: number | null;
  contentType?: string | null;
  updatedAt?: string | null;
  fileCount?: number;
  folderCount?: number;
  children?: FilesExplorerNode[];
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

export type FilesExplorerViewProps = {
  sources: readonly FilesExplorerSource[];
  selectedPath: string | null;
  selectedContent?: FilesExplorerSelectedContent | null;
  loadError: string | null;
  buildNodeTo: (path: string) => To;
  onNodeSelect?: (node: FilesExplorerNode) => void;
  buildDownloadHref?: (path: string) => string | null;
  defaultCollapsedRootPaths?: readonly string[];
  collapsedRootPaths?: readonly string[];
  onCollapsedRootPathsChange?: (paths: readonly string[]) => void;
  treeLabel?: string;
  treeAriaLabel?: string;
  rootIcon?: LucideIcon;
  rootSelection?: "summary" | "detail";
  detailHeadingLevel?: 2 | 3 | 4;
  emptySelection?: ReactNode;
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
  treeLabel = "File tree",
  treeAriaLabel = "Files explorer",
  rootIcon = HardDrive,
  rootSelection = "summary",
  detailHeadingLevel = 2,
  emptySelection = null,
}: FilesExplorerViewProps) {
  const [uncontrolledCollapsedRootPaths, setUncontrolledCollapsedRootPaths] = useState(
    () => new Set(defaultCollapsedRootPaths),
  );
  const [expandedDirectoryPaths, setExpandedDirectoryPaths] = useState<ReadonlySet<string>>(
    () => new Set(),
  );
  const [explicitlyCollapsedPaths, setExplicitlyCollapsedPaths] = useState<ReadonlySet<string>>(
    () => new Set(),
  );
  const effectiveCollapsedRootPaths = useMemo(
    () => new Set(collapsedRootPaths ?? uncontrolledCollapsedRootPaths),
    [collapsedRootPaths, uncontrolledCollapsedRootPaths],
  );
  const setNodeCollapsed = (node: FilesExplorerNode, collapsed: boolean) => {
    setExplicitlyCollapsedPaths((current) => {
      const next = new Set(current);
      if (collapsed) {
        next.add(node.path);
      } else {
        next.delete(node.path);
      }
      return next;
    });

    if (node.kind === "root") {
      const next = new Set(effectiveCollapsedRootPaths);
      if (collapsed) {
        next.add(node.path);
      } else {
        next.delete(node.path);
      }
      if (collapsedRootPaths === undefined) {
        setUncontrolledCollapsedRootPaths(next);
      }
      onCollapsedRootPathsChange?.([...next]);
      return;
    }

    if (node.kind === "directory") {
      setExpandedDirectoryPaths((current) => {
        const next = new Set(current);
        if (collapsed) {
          next.delete(node.path);
        } else {
          next.add(node.path);
        }
        return next;
      });
    }
  };
  const { tree, selectedDetail } = useMemo(
    () => createExplorerViewModel(sources, selectedPath, selectedContent),
    [selectedContent, selectedPath, sources],
  );
  const selectedRoot =
    rootSelection === "summary" && selectedDetail?.node.kind === "root" ? selectedDetail : null;

  return (
    <div className="space-y-4">
      {loadError ? <MessageTone tone="error">{loadError}</MessageTone> : null}

      {tree.length === 0 ? (
        <BackofficeSystemState
          tone="empty"
          label="No file sources"
          title="This workspace has no files yet."
          description="Files will appear here when a collection becomes available."
        />
      ) : (
        <section className="grid min-h-[22rem] gap-px overflow-hidden bg-[var(--bo-border)] shadow-[0_0_0_1px_var(--bo-border)] lg:grid-cols-[18rem_minmax(0,1fr)]">
          <aside className="bg-[var(--bo-panel-2)] p-3">
            <div className="flex min-h-8 items-center justify-between gap-3 px-1">
              <p className="font-mono text-[9px] font-semibold tracking-[0.2em] text-[var(--bo-muted-2)] uppercase">
                {treeLabel}
              </p>
              <span className="font-mono text-[9px] text-[var(--bo-muted-2)]">
                {tree.length} {tree.length === 1 ? "root" : "roots"}
              </span>
            </div>

            <nav aria-label={treeAriaLabel} className="mt-2 space-y-0.5">
              {tree.map((node) => (
                <FilesTreeNodeRow
                  key={node.path}
                  node={node}
                  selectedPath={selectedPath}
                  buildNodeTo={buildNodeTo}
                  onNodeSelect={onNodeSelect}
                  rootIcon={rootIcon}
                  collapsedRootPaths={effectiveCollapsedRootPaths}
                  expandedDirectoryPaths={expandedDirectoryPaths}
                  explicitlyCollapsedPaths={explicitlyCollapsedPaths}
                  onSetCollapsed={setNodeCollapsed}
                  depth={0}
                />
              ))}
            </nav>
          </aside>

          <div className="min-w-0 bg-[var(--bo-panel)]">
            {selectedRoot ? (
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
              />
            ) : (
              emptySelection
            )}
          </div>
        </section>
      )}
    </div>
  );
}

function ExplorerNodeDetailPanel({
  detail,
  buildDownloadHref,
  rootIcon: RootIcon,
  headingLevel,
}: {
  detail: ExplorerNodeDetail;
  buildDownloadHref?: (path: string) => string | null;
  rootIcon: LucideIcon;
  headingLevel: 2 | 3 | 4;
}) {
  const contentPreview = {
    title: detail.node.title,
    contentType: detail.node.contentType ?? null,
    metadata: detail.metadata,
    textContent: detail.textContent,
  };
  const contentRenderer = resolveFilesContentRenderer(contentPreview);
  const downloadHref =
    detail.node.kind === "file" ? (buildDownloadHref?.(detail.node.path) ?? null) : null;
  const Heading = getHeadingComponent(headingLevel);
  const DetailIcon =
    detail.node.kind === "root" ? RootIcon : detail.node.kind === "directory" ? Folder : FileIcon;
  const displayedMetadata = Object.fromEntries(
    PUBLIC_FILE_METADATA_FIELDS.flatMap((field) => {
      const value = detail.metadata?.[field];
      return value === undefined ? [] : [[field, value]];
    }),
  );

  return (
    <section className="min-h-full p-4 md:p-5">
      <div className="flex flex-wrap items-start justify-between gap-4 pb-4">
        <div className="flex min-w-0 items-start gap-3">
          <span className="flex size-10 shrink-0 items-center justify-center bg-[var(--bo-panel-2)] text-[var(--bo-accent)] shadow-[inset_0_0_0_1px_var(--bo-border)]">
            <DetailIcon className="size-[18px]" aria-hidden="true" />
          </span>
          <div className="min-w-0">
            <p className="font-mono text-[9px] font-semibold tracking-[0.2em] text-[var(--bo-muted-2)] uppercase">
              {detail.node.kind}
            </p>
            <Heading className="mt-1 text-2xl font-semibold tracking-tight text-balance break-all text-[var(--bo-fg)]">
              {detail.node.title}
            </Heading>
          </div>
        </div>
        {downloadHref ? (
          <a
            href={downloadHref}
            className="bo-control-surface inline-flex min-h-10 items-center gap-2 bg-[var(--bo-panel-2)] px-3.5 text-[10px] font-semibold tracking-[0.2em] text-[var(--bo-muted)] uppercase transition-[scale,background-color,color,box-shadow] duration-150 ease-out hover:bg-[var(--bo-panel)] hover:text-[var(--bo-fg)] focus-visible:ring-2 focus-visible:ring-[color:var(--bo-accent)]/30 focus-visible:outline-none active:scale-[0.96]"
          >
            <Download className="h-3.5 w-3.5" aria-hidden="true" />
            Download
          </a>
        ) : null}
      </div>

      {contentRenderer ? (
        <div className="mt-5 bg-[var(--bo-panel-2)] p-3 shadow-[inset_0_0_0_1px_var(--bo-border)] md:p-4">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <p className="font-mono text-[9px] font-semibold tracking-[0.2em] text-[var(--bo-muted-2)] uppercase">
              {contentRenderer.label}
            </p>
            {detail.node.contentType ? (
              <p className="font-mono text-[9px] text-[var(--bo-muted-2)]">
                {detail.node.contentType}
              </p>
            ) : null}
          </div>
          <div className="mt-3">{contentRenderer.render(contentPreview)}</div>
        </div>
      ) : null}

      <dl className="mt-5 grid gap-2 sm:grid-cols-2 xl:grid-cols-3">
        {detail.fields.map((field) => (
          <div
            key={`${field.label}-${field.value}`}
            className="min-w-0 bg-[var(--bo-panel-2)] px-3 py-2.5 shadow-[inset_0_0_0_1px_var(--bo-border)]"
          >
            <dt className="font-mono text-[9px] tracking-[0.18em] text-[var(--bo-muted-2)] uppercase">
              {field.label}
            </dt>
            <dd className="mt-1.5 text-xs break-all text-[var(--bo-muted)]">{field.value}</dd>
          </div>
        ))}
      </dl>

      {Object.keys(displayedMetadata).length > 0 ? (
        <div className="mt-5">
          <p className="font-mono text-[9px] font-semibold tracking-[0.18em] text-[var(--bo-muted-2)] uppercase">
            Metadata
          </p>
          <pre className="backoffice-scroll mt-3 max-h-72 overflow-auto bg-[var(--bo-panel-2)] p-3 font-mono text-[11px] leading-5 text-[var(--bo-muted)] shadow-[inset_0_0_0_1px_var(--bo-border)]">
            {JSON.stringify(displayedMetadata, null, 2)}
          </pre>
        </div>
      ) : null}
    </section>
  );
}

function RootSelectionState({
  detail,
  icon: Icon,
  headingLevel,
}: {
  detail: ExplorerNodeDetail;
  icon: LucideIcon;
  headingLevel: 2 | 3 | 4;
}) {
  const isEmpty = (detail.node.fileCount ?? 0) + (detail.node.folderCount ?? 0) === 0;
  const Heading = getHeadingComponent(headingLevel);

  return (
    <section className="flex min-h-full items-center justify-center bg-[var(--bo-panel)] p-6">
      <div className="max-w-sm text-center">
        <div className="bo-control-surface mx-auto flex size-12 items-center justify-center bg-[var(--bo-panel-2)] text-[var(--bo-accent)]">
          <Icon className="size-5" aria-hidden="true" />
        </div>
        <p className="mt-4 font-mono text-[9px] tracking-[0.18em] text-[var(--bo-muted-2)] uppercase">
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

function FilesTreeNodeRow({
  node,
  selectedPath,
  buildNodeTo,
  onNodeSelect,
  rootIcon: RootIcon,
  collapsedRootPaths,
  expandedDirectoryPaths,
  explicitlyCollapsedPaths,
  onSetCollapsed,
  depth,
}: {
  node: FilesExplorerNode;
  selectedPath: string | null;
  buildNodeTo: (path: string) => To;
  onNodeSelect?: (node: FilesExplorerNode) => void;
  rootIcon: LucideIcon;
  collapsedRootPaths: ReadonlySet<string>;
  expandedDirectoryPaths: ReadonlySet<string>;
  explicitlyCollapsedPaths: ReadonlySet<string>;
  onSetCollapsed: (node: FilesExplorerNode, collapsed: boolean) => void;
  depth: number;
}) {
  const isSelected = selectedPath === node.path;
  const hasChildren = Boolean(node.children?.length);
  const isCollapsedByState =
    node.kind === "root"
      ? collapsedRootPaths.has(node.path)
      : node.kind === "directory"
        ? !expandedDirectoryPaths.has(node.path)
        : false;
  const isCollapsed =
    hasChildren &&
    isCollapsedByState &&
    (explicitlyCollapsedPaths.has(node.path) || !isAncestorPath(node.path, selectedPath));
  const Icon = node.kind === "root" ? RootIcon : node.kind === "directory" ? Folder : FileIcon;

  return (
    <div>
      {node.kind === "root" ? (
        <button
          type="button"
          aria-expanded={hasChildren ? !isCollapsed : undefined}
          aria-label={
            hasChildren ? `${isCollapsed ? "Expand" : "Collapse"} ${node.title}` : node.title
          }
          onClick={() => {
            if (hasChildren) {
              onSetCollapsed(node, !isCollapsed);
            }
          }}
          className={
            isSelected
              ? "flex min-h-10 w-full items-center gap-2 bg-[var(--bo-accent-bg)] px-2 py-1 text-left text-[13px] font-medium text-[var(--bo-fg)] shadow-[inset_0_0_0_1px_var(--bo-accent)] outline-none focus-visible:ring-2 focus-visible:ring-[color:var(--bo-accent)]/30"
              : "flex min-h-10 w-full items-center gap-2 px-2 py-1 text-left text-[13px] text-[var(--bo-muted)] shadow-[inset_0_0_0_1px_transparent] outline-none hover:bg-[var(--bo-panel)] hover:text-[var(--bo-fg)] hover:shadow-[inset_0_0_0_1px_var(--bo-border)] focus-visible:ring-2 focus-visible:ring-[color:var(--bo-accent)]/30"
          }
        >
          <span className="flex size-6 shrink-0 items-center justify-center text-[var(--bo-muted-2)]">
            {hasChildren ? (
              isCollapsed ? (
                <ChevronRight className="size-3.5" aria-hidden="true" />
              ) : (
                <ChevronDown className="size-3.5" aria-hidden="true" />
              )
            ) : null}
          </span>
          <RootIcon
            className={`h-4 w-4 shrink-0 ${isSelected ? "text-[var(--bo-accent)]" : "text-[var(--bo-muted-2)]"}`}
            aria-hidden="true"
          />
          <span className="min-w-0 truncate">{node.title}</span>
        </button>
      ) : (
        <div className="flex min-h-10 items-center" style={{ paddingLeft: `${depth * 0.75}rem` }}>
          {hasChildren ? (
            <button
              type="button"
              aria-expanded={!isCollapsed}
              aria-label={`${isCollapsed ? "Expand" : "Collapse"} ${node.title}`}
              onClick={() => {
                onSetCollapsed(node, !isCollapsed);
              }}
              className="flex size-8 shrink-0 items-center justify-center text-[var(--bo-muted-2)] transition-colors hover:text-[var(--bo-fg)] focus-visible:ring-2 focus-visible:ring-[color:var(--bo-accent)]/30 focus-visible:outline-none"
            >
              {isCollapsed ? (
                <ChevronRight className="size-3.5" aria-hidden="true" />
              ) : (
                <ChevronDown className="size-3.5" aria-hidden="true" />
              )}
            </button>
          ) : (
            <span className="size-8 shrink-0" aria-hidden="true" />
          )}
          <Link
            to={buildNodeTo(node.path)}
            onClick={() => {
              if (node.kind === "directory" && hasChildren) {
                onSetCollapsed(node, false);
              }
              onNodeSelect?.(node);
            }}
            preventScrollReset
            aria-current={isSelected ? "page" : undefined}
            className={
              isSelected
                ? "flex min-h-10 min-w-0 flex-1 items-center gap-2 bg-[var(--bo-accent-bg)] px-2 py-1 text-[13px] font-medium text-[var(--bo-fg)] shadow-[inset_0_0_0_1px_var(--bo-accent)] transition-[scale,background-color,color,box-shadow] duration-150 ease-out outline-none focus-visible:ring-2 focus-visible:ring-[color:var(--bo-accent)]/30 active:scale-[0.96]"
                : "flex min-h-10 min-w-0 flex-1 items-center gap-2 px-2 py-1 text-[13px] text-[var(--bo-muted)] shadow-[inset_0_0_0_1px_transparent] transition-[scale,background-color,color,box-shadow] duration-150 ease-out outline-none hover:bg-[var(--bo-panel)] hover:text-[var(--bo-fg)] hover:shadow-[inset_0_0_0_1px_var(--bo-border)] focus-visible:ring-2 focus-visible:ring-[color:var(--bo-accent)]/30 active:scale-[0.96]"
            }
          >
            <Icon
              className={`h-4 w-4 shrink-0 ${isSelected ? "text-[var(--bo-accent)]" : "text-[var(--bo-muted-2)]"}`}
              aria-hidden="true"
            />
            <span className="min-w-0 truncate">{node.title}</span>
          </Link>
        </div>
      )}

      {!isCollapsed && node.children?.length ? (
        <div className="space-y-0.5">
          {node.children.map((child) => (
            <FilesTreeNodeRow
              key={child.path}
              node={child}
              selectedPath={selectedPath}
              buildNodeTo={buildNodeTo}
              onNodeSelect={onNodeSelect}
              rootIcon={RootIcon}
              collapsedRootPaths={collapsedRootPaths}
              expandedDirectoryPaths={expandedDirectoryPaths}
              explicitlyCollapsedPaths={explicitlyCollapsedPaths}
              onSetCollapsed={onSetCollapsed}
              depth={depth + 1}
            />
          ))}
        </div>
      ) : null}
    </div>
  );
}

function isAncestorPath(path: string, selectedPath: string | null): boolean {
  if (!selectedPath) {
    return false;
  }
  const normalizedPath = path.replace(/\/$/u, "");
  const normalizedSelectedPath = selectedPath.replace(/\/$/u, "");
  return (
    normalizedSelectedPath !== normalizedPath &&
    normalizedSelectedPath.startsWith(`${normalizedPath}/`)
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

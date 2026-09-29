import { useMemo, useState } from "react";
import { Link, type To } from "react-router";

import { cn } from "../cn";
import { IconButton } from "./button";
import { Icon, type IconName } from "./icon";
import { Input } from "./input";

export type FileTreeExplorerNode = {
  kind: "root" | "directory" | "file";
  path: string;
  title: string;
  children: readonly FileTreeExplorerNode[];
};

export type FileTreeExplorerProps = {
  nodes: readonly FileTreeExplorerNode[];
  selectedPath: string | null;
  buildNodeTo: (path: string) => To;
  onNodeSelect?: (node: FileTreeExplorerNode) => void;
  defaultCollapsedRootPaths: readonly string[];
  collapsedRootPaths?: readonly string[];
  onCollapsedRootPathsChange?: (paths: readonly string[]) => void;
  ariaLabel: string;
  rootIcon: IconName;
};

/**
 * A filterable tree of roots, folders, and files. Roots start expanded and folders start
 * collapsed, but any node on the path to the selection stays open until the user explicitly
 * collapses it.
 */
export function FileTreeExplorer({
  nodes,
  selectedPath,
  buildNodeTo,
  onNodeSelect,
  defaultCollapsedRootPaths,
  collapsedRootPaths,
  onCollapsedRootPathsChange,
  ariaLabel,
  rootIcon,
}: FileTreeExplorerProps) {
  const [uncontrolledCollapsedRootPaths, setUncontrolledCollapsedRootPaths] = useState(
    () => new Set(defaultCollapsedRootPaths),
  );
  const [expandedDirectoryPaths, setExpandedDirectoryPaths] = useState<ReadonlySet<string>>(
    () => new Set(),
  );
  const [treeNameQuery, setTreeNameQuery] = useState("");
  const [explicitlyCollapsedPaths, setExplicitlyCollapsedPaths] = useState<ReadonlySet<string>>(
    () => new Set(),
  );
  const effectiveCollapsedRootPaths = useMemo(
    () => new Set(collapsedRootPaths ?? uncontrolledCollapsedRootPaths),
    [collapsedRootPaths, uncontrolledCollapsedRootPaths],
  );
  const setNodeCollapsed = (node: FileTreeExplorerNode, collapsed: boolean) => {
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
  const isFileSelected = useMemo(
    () => findNode(nodes, selectedPath)?.kind === "file",
    [nodes, selectedPath],
  );
  const treeNameSearch = useMemo(
    () => filterTreeByName(nodes, treeNameQuery),
    [nodes, treeNameQuery],
  );
  const isTreeNameSearchActive = treeNameQuery.trim().length > 0;

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="shrink-0 border-b border-[color:var(--bo-border)] p-3">
        <div className="relative">
          <Icon
            name="search"
            strokeWidth={1.75}
            className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-[var(--bo-muted-2)]"
          />
          <Input
            role="searchbox"
            value={treeNameQuery}
            onChange={(event) => {
              setTreeNameQuery(event.currentTarget.value);
            }}
            placeholder="Filter by name"
            aria-label="Filter file or folder names"
            className="min-h-10 w-full pr-11 pl-9"
          />
          {isTreeNameSearchActive ? (
            <IconButton
              label="Clear file name filter"
              onClick={() => {
                setTreeNameQuery("");
              }}
              className="absolute top-1/2 right-0.5 size-8 -translate-y-1/2"
            >
              <Icon name="x" className="size-4" strokeWidth={1.75} />
            </IconButton>
          ) : null}
        </div>
        {isTreeNameSearchActive ? (
          <p className="mt-2 px-1 text-[11px] font-semibold text-[var(--bo-muted-2)] tabular-nums">
            {treeNameSearch.matchCount}{" "}
            {treeNameSearch.matchCount === 1 ? "matching name" : "matching names"}
          </p>
        ) : null}
      </div>

      <div className="backoffice-scroll min-h-0 flex-1 overflow-y-auto p-3">
        {isTreeNameSearchActive && treeNameSearch.matchCount === 0 ? (
          <p className="px-3 py-6 text-center text-sm text-pretty text-[var(--bo-muted)]">
            No file or folder names match “{treeNameQuery.trim()}”.
          </p>
        ) : null}

        <nav aria-label={ariaLabel} className="flex flex-col gap-3">
          {treeNameSearch.tree.map((node) => (
            <FileTreeNodeRow
              key={node.path}
              node={node}
              selectedPath={selectedPath}
              isFileSelected={isFileSelected}
              buildNodeTo={buildNodeTo}
              onNodeSelect={onNodeSelect}
              rootIcon={rootIcon}
              collapsedRootPaths={effectiveCollapsedRootPaths}
              expandedDirectoryPaths={expandedDirectoryPaths}
              explicitlyCollapsedPaths={explicitlyCollapsedPaths}
              onSetCollapsed={setNodeCollapsed}
              forceExpanded={isTreeNameSearchActive}
            />
          ))}
        </nav>
      </div>
    </div>
  );
}

const ROW =
  "flex min-h-9 min-w-0 items-center gap-2.5 rounded-[4px] border px-2 text-left text-sm transition-[background-color,border-color,box-shadow,color] duration-150 ease-out focus-visible:ring-2 focus-visible:ring-[color:var(--bo-accent)]/30 focus-visible:outline-none";
const ROW_SELECTED =
  "border-[color:var(--bo-selected-border)] bg-[var(--bo-selected-bg)] font-semibold text-[var(--bo-fg)] shadow-[var(--bo-selected-shadow)]";
const ROW_RESTING =
  "border-transparent text-[var(--bo-muted)] hover:bg-[var(--bo-panel-2)] hover:text-[var(--bo-fg)]";

function FileTreeNodeRow({
  node,
  selectedPath,
  isFileSelected,
  buildNodeTo,
  onNodeSelect,
  rootIcon,
  collapsedRootPaths,
  expandedDirectoryPaths,
  explicitlyCollapsedPaths,
  onSetCollapsed,
  forceExpanded,
}: {
  node: FileTreeExplorerNode;
  selectedPath: string | null;
  isFileSelected: boolean;
  buildNodeTo: (path: string) => To;
  onNodeSelect?: (node: FileTreeExplorerNode) => void;
  rootIcon: IconName;
  collapsedRootPaths: ReadonlySet<string>;
  expandedDirectoryPaths: ReadonlySet<string>;
  explicitlyCollapsedPaths: ReadonlySet<string>;
  onSetCollapsed: (node: FileTreeExplorerNode, collapsed: boolean) => void;
  forceExpanded: boolean;
}) {
  const isSelected = selectedPath === node.path;
  const hasChildren = node.children.length > 0;
  const isCollapsedByState =
    node.kind === "root"
      ? collapsedRootPaths.has(node.path)
      : node.kind === "directory"
        ? !expandedDirectoryPaths.has(node.path)
        : false;
  const isCollapsed =
    !forceExpanded &&
    hasChildren &&
    isCollapsedByState &&
    (explicitlyCollapsedPaths.has(node.path) ||
      (!isSelected && !isAncestorPath(node.path, selectedPath)));
  const nodeIcon: IconName =
    node.kind === "root" ? rootIcon : node.kind === "directory" ? "folder" : "file";
  const chevron = (
    <Icon
      name={isCollapsed ? "chevron-right" : "chevron-down"}
      className="size-3.5"
      strokeWidth={1.75}
    />
  );

  return (
    <div>
      {node.kind === "root" ? (
        // Roots group the tree like section headings, so they only toggle and never navigate.
        <button
          type="button"
          aria-disabled={forceExpanded}
          aria-expanded={hasChildren ? !isCollapsed : undefined}
          aria-label={
            hasChildren ? `${isCollapsed ? "Expand" : "Collapse"} ${node.title}` : node.title
          }
          onClick={() => {
            if (forceExpanded) {
              return;
            }
            if (hasChildren) {
              onSetCollapsed(node, !isCollapsed);
            }
          }}
          className={cn(
            ROW,
            "w-full gap-3 pl-0 font-semibold",
            isSelected
              ? ROW_SELECTED
              : "border-transparent text-[var(--bo-fg)] hover:bg-[var(--bo-panel-2)]",
          )}
        >
          {/* -ml-px cancels the row border so this chevron lines up with the guide line below. */}
          <span className="-ml-px flex size-8 shrink-0 items-center justify-center text-[var(--bo-muted-2)]">
            {hasChildren ? chevron : null}
          </span>
          <Icon
            name={rootIcon}
            strokeWidth={1.75}
            className="size-4 shrink-0 text-[var(--bo-muted)]"
          />
          <span className="min-w-0 truncate">{node.title}</span>
        </button>
      ) : (
        <div className="flex items-center">
          {hasChildren ? (
            <button
              type="button"
              aria-disabled={forceExpanded}
              aria-expanded={!isCollapsed}
              aria-label={`${isCollapsed ? "Expand" : "Collapse"} ${node.title}`}
              onClick={() => {
                if (forceExpanded) {
                  return;
                }
                onSetCollapsed(node, !isCollapsed);
              }}
              className="flex size-8 shrink-0 items-center justify-center rounded-[4px] text-[var(--bo-muted-2)] transition-colors duration-150 ease-out hover:text-[var(--bo-fg)] focus-visible:ring-2 focus-visible:ring-[color:var(--bo-accent)]/30 focus-visible:outline-none"
            >
              {chevron}
            </button>
          ) : (
            <span className="size-8 shrink-0" aria-hidden="true" />
          )}
          <Link
            to={buildNodeTo(node.path)}
            onClick={(event) => {
              const containsSelectedFile =
                node.kind === "directory" &&
                isFileSelected &&
                isAncestorPath(node.path, selectedPath);

              if (containsSelectedFile) {
                onSetCollapsed(node, !isCollapsed);
                event.preventDefault();
                return;
              }
              if (node.kind === "directory") {
                onSetCollapsed(node, false);
              }
              onNodeSelect?.(node);
            }}
            preventScrollReset
            aria-current={isSelected ? "page" : undefined}
            className={cn(ROW, "flex-1", isSelected ? ROW_SELECTED : ROW_RESTING)}
          >
            <Icon
              name={nodeIcon}
              strokeWidth={1.75}
              className={cn(
                "size-4 shrink-0",
                isSelected ? "text-[var(--bo-fg)]" : "text-[var(--bo-muted-2)]",
              )}
            />
            <span className="min-w-0 truncate">{node.title}</span>
          </Link>
        </div>
      )}

      {!isCollapsed && hasChildren ? (
        // The guide line sits under the parent's chevron, so each level indents by half a
        // chevron slot and the nesting stays readable without depth bookkeeping.
        <div className="mt-0.5 ml-4 flex flex-col gap-0.5 border-l border-[color:var(--bo-border)]">
          {node.children.map((child) => (
            <FileTreeNodeRow
              key={child.path}
              node={child}
              selectedPath={selectedPath}
              isFileSelected={isFileSelected}
              buildNodeTo={buildNodeTo}
              onNodeSelect={onNodeSelect}
              rootIcon={rootIcon}
              collapsedRootPaths={collapsedRootPaths}
              expandedDirectoryPaths={expandedDirectoryPaths}
              explicitlyCollapsedPaths={explicitlyCollapsedPaths}
              onSetCollapsed={onSetCollapsed}
              forceExpanded={forceExpanded}
            />
          ))}
        </div>
      ) : null}
    </div>
  );
}

function findNode(
  nodes: readonly FileTreeExplorerNode[],
  path: string | null,
): FileTreeExplorerNode | null {
  if (!path) {
    return null;
  }
  for (const node of nodes) {
    if (node.path === path) {
      return node;
    }
    const descendant = findNode(node.children, path);
    if (descendant) {
      return descendant;
    }
  }
  return null;
}

function filterTreeByName(
  tree: readonly FileTreeExplorerNode[],
  query: string,
): { tree: readonly FileTreeExplorerNode[]; matchCount: number } {
  const normalizedQuery = query.trim().toLocaleLowerCase();
  if (!normalizedQuery) {
    return { tree, matchCount: 0 };
  }

  const filterNode = (
    node: FileTreeExplorerNode,
  ): { node: FileTreeExplorerNode | null; matchCount: number } => {
    const filteredChildren = node.children.map(filterNode);
    const children = filteredChildren.flatMap((result) => (result.node ? [result.node] : []));
    const descendantMatchCount = filteredChildren.reduce(
      (count, result) => count + result.matchCount,
      0,
    );
    const nameMatches =
      node.kind !== "root" && node.title.toLocaleLowerCase().includes(normalizedQuery);

    if (!nameMatches && children.length === 0) {
      return { node: null, matchCount: 0 };
    }

    return {
      node: { ...node, children },
      matchCount: descendantMatchCount + (nameMatches ? 1 : 0),
    };
  };

  const filteredRoots = tree.map(filterNode);
  return {
    tree: filteredRoots.flatMap((result) => (result.node ? [result.node] : [])),
    matchCount: filteredRoots.reduce((count, result) => count + result.matchCount, 0),
  };
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

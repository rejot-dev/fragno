import type { RouterContextProvider } from "react-router";

import { CloudflareContext } from "@/cloudflare/cloudflare-context";
import {
  createOrgFileSystem,
  getFilesNodeDetail,
  listFilesChildren,
  listFilesTree,
  performFilesAction,
  resolveFilesTarget,
  type FilesActionResult,
  type FilesExplorerTreeNode,
  type FilesNodeDetail,
  type MasterFileSystem,
} from "@/files";

export type FilesExplorerLoaderData = {
  tree: FilesExplorerTreeNode[];
  selectedPath: string | null;
  selectedDetail: FilesNodeDetail | null;
  loadError: string | null;
};

export type FilesExplorerActionResult =
  | FilesActionResult
  | {
      ok: false;
      intent: string | null;
      message: string;
    };

export async function createBackofficeFilesFileSystem({
  context,
  orgId,
}: {
  request?: Request;
  context: Readonly<RouterContextProvider>;
  orgId: string;
}): Promise<MasterFileSystem> {
  const { env } = context.get(CloudflareContext);
  return createOrgFileSystem({ orgId, env });
}

export async function loadFilesExplorerData({
  request,
  context,
  orgId,
}: {
  request: Request;
  context: Readonly<RouterContextProvider>;
  orgId: string;
}): Promise<FilesExplorerLoaderData> {
  const fileSystem = await createBackofficeFilesFileSystem({ request, context, orgId });
  const initialTree = await listFilesTree(fileSystem);

  if (initialTree.length === 0) {
    return {
      tree: initialTree,
      selectedPath: null,
      selectedDetail: null,
      loadError: null,
    };
  }

  const requestUrl = new URL(request.url);
  const requestedPath = requestUrl.searchParams.get("path")?.trim() ?? null;
  let selectedPath = requestedPath || initialTree[0]?.path || null;
  let selectedDetail = selectedPath ? await getFilesNodeDetail(fileSystem, selectedPath) : null;
  let loadError: string | null = null;

  if (selectedPath && !selectedDetail) {
    loadError = `Path '${selectedPath}' could not be found.`;
    selectedPath = initialTree[0]?.path || null;
    selectedDetail = selectedPath ? await getFilesNodeDetail(fileSystem, selectedPath) : null;
  }

  const tree = selectedPath
    ? await expandTreeAlongSelection(fileSystem, initialTree, selectedPath)
    : initialTree;

  return {
    tree,
    selectedPath,
    selectedDetail,
    loadError,
  };
}

export async function handleFilesExplorerAction({
  request,
  context,
  orgId,
}: {
  request: Request;
  context: Readonly<RouterContextProvider>;
  orgId: string;
}): Promise<FilesExplorerActionResult> {
  const formData = await request.formData();
  const intentValue = formData.get("intent");
  const pathValue = formData.get("path");
  const folderNameValue = formData.get("folderName");
  const contentValue = formData.get("content");

  const intent = typeof intentValue === "string" ? intentValue.trim() : "";
  const path = typeof pathValue === "string" ? pathValue.trim() : "";
  const folderName = typeof folderNameValue === "string" ? folderNameValue : undefined;
  const content = typeof contentValue === "string" ? contentValue : undefined;

  if (intent !== "create-folder" && intent !== "delete" && intent !== "write-text") {
    return {
      ok: false,
      intent,
      message: "Unknown file action.",
    };
  }

  if (!path) {
    return {
      ok: false,
      intent,
      message: "Path is required.",
    };
  }

  const fileSystem = await createBackofficeFilesFileSystem({ request, context, orgId });

  return performFilesAction(fileSystem, {
    intent,
    path,
    folderName,
    content,
  });
}

async function expandTreeAlongSelection(
  fileSystem: MasterFileSystem,
  tree: FilesExplorerTreeNode[],
  selectedPath: string,
): Promise<FilesExplorerTreeNode[]> {
  const target = await resolveFilesTarget(fileSystem, selectedPath);
  if (!target) {
    return tree;
  }

  const expandedFolders = new Set(
    getExpandedFolderPaths(target.mount.mountPoint, target.normalizedPath),
  );

  return Promise.all(
    tree.map(async (node) => {
      if (node.path !== target.mount.mountPoint) {
        return node;
      }

      return {
        ...node,
        children: await buildExpandedChildren(
          fileSystem,
          node.path,
          expandedFolders,
          node.children,
        ),
      } satisfies FilesExplorerTreeNode;
    }),
  );
}

async function buildExpandedChildren(
  fileSystem: MasterFileSystem,
  parentPath: string,
  expandedFolders: ReadonlySet<string>,
  existingChildren: readonly FilesExplorerTreeNode[] | undefined,
): Promise<FilesExplorerTreeNode[]> {
  const children = await listFilesChildren(fileSystem, parentPath);
  const existingChildrenByPath = new Map(
    existingChildren?.map((child) => [child.path, child]) ?? [],
  );

  return Promise.all(
    children.map(async (child) => {
      const existingChild = existingChildrenByPath.get(child.path);

      return {
        ...child,
        children:
          child.kind === "file"
            ? undefined
            : expandedFolders.has(child.path)
              ? await buildExpandedChildren(
                  fileSystem,
                  child.path,
                  expandedFolders,
                  existingChild?.children,
                )
              : existingChild?.children,
      } satisfies FilesExplorerTreeNode;
    }),
  );
}

function getExpandedFolderPaths(mountPoint: string, normalizedPath: string): string[] {
  const expanded = [mountPoint];
  const pathWithoutTrailingSlash = stripTrailingSlash(normalizedPath);

  if (pathWithoutTrailingSlash === mountPoint) {
    if (normalizedPath.endsWith("/")) {
      expanded.push(ensureFolderPath(pathWithoutTrailingSlash));
    }
    return expanded;
  }

  const remainder = pathWithoutTrailingSlash.slice(mountPoint.length).replace(/^\/+/, "");
  if (!remainder) {
    return expanded;
  }

  const segments = remainder.split("/").filter(Boolean);
  const lastFolderIndex = normalizedPath.endsWith("/") ? segments.length : segments.length - 1;

  for (let index = 1; index <= lastFolderIndex; index += 1) {
    expanded.push(`${mountPoint}/${segments.slice(0, index).join("/")}/`);
  }

  return expanded;
}

function stripTrailingSlash(path: string) {
  if (path === "/") {
    return path;
  }

  return path.replace(/\/+$/, "");
}

function ensureFolderPath(path: string) {
  if (path === "/") {
    return path;
  }

  return path.endsWith("/") ? path : `${path}/`;
}

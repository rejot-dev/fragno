import type { RouterContextProvider } from "react-router";

import { BackofficeKernel } from "@/backoffice-runtime/kernel";
import {
  createBackofficeFileSystem,
  ensureFolderPath,
  getFilesNodeDetail,
  listFilesChildren,
  listFilesTree,
  performFilesAction,
  resolveFilesTarget,
  stripTrailingSlash,
  type FilesActionResult,
  type FilesExplorerTreeNode,
  MasterFileSystem,
  type FilesNodeDetail,
} from "@/files";
import { requireBackofficeContext } from "@/fragno/auth/backoffice-principal.server";
import { BackofficeWorkerContext } from "@/worker-runtime/router-context";

type FilesExplorerLoaderData = {
  tree: FilesExplorerTreeNode[];
  selectedPath: string | null;
  selectedDetail: FilesNodeDetail | null;
  selectedUploadTextContent: string | null;
  loadError: string | null;
};

type FilesExplorerActionResult =
  | FilesActionResult
  | {
      ok: false;
      intent: string | null;
      message: string;
    };

export async function createBackofficeFilesFileSystem({
  request,
  context,
  orgId,
}: {
  request: Request;
  context: Readonly<RouterContextProvider>;
  orgId: string;
}): Promise<MasterFileSystem> {
  const { runtime } = context.get(BackofficeWorkerContext);
  const kernel = new BackofficeKernel({ objects: runtime.objects });
  const execution = await requireBackofficeContext(request, context, { kind: "org", orgId });
  return createBackofficeFileSystem({
    objects: runtime.objects,
    kernel,
    execution,
    config: runtime.config,
  });
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
  const serverMetadataFileSystem = new MasterFileSystem({
    mounts: fileSystem.mounts.filter((mount) => mount.kind !== "upload"),
  });
  const initialTree = await listFilesTree(serverMetadataFileSystem);
  const requestUrl = new URL(request.url);
  const requestedPath = requestUrl.searchParams.get("path")?.trim() ?? null;
  let selectedPath = requestedPath || fileSystem.mounts[0]?.mountPoint || null;
  const selectedTarget = selectedPath ? await resolveFilesTarget(fileSystem, selectedPath) : null;

  if (selectedTarget?.mount.kind === "upload") {
    return {
      tree: initialTree,
      selectedPath,
      selectedDetail: null,
      selectedUploadTextContent: await readSelectedUploadTextContent(
        fileSystem,
        selectedTarget.normalizedPath,
      ),
      loadError: null,
    };
  }

  let selectedDetail = selectedPath
    ? await getFilesNodeDetail(serverMetadataFileSystem, selectedPath)
    : null;
  let loadError: string | null = null;

  if (selectedPath && !selectedDetail) {
    loadError = `Path '${selectedPath}' could not be found.`;
    selectedPath = initialTree[0]?.path || null;
    selectedDetail = selectedPath
      ? await getFilesNodeDetail(serverMetadataFileSystem, selectedPath)
      : null;
  }

  const tree = selectedPath
    ? await expandTreeAlongSelection(serverMetadataFileSystem, initialTree, selectedPath)
    : initialTree;

  return {
    tree,
    selectedPath,
    selectedDetail,
    selectedUploadTextContent: null,
    loadError,
  };
}

const TEXT_FILE_EXTENSION =
  /\.(md|mdx|txt|log|json|js|jsx|ts|tsx|css|html|xml|yml|yaml|toml|ini|sh)$/i;

const readSelectedUploadTextContent = async (
  fileSystem: MasterFileSystem,
  path: string,
): Promise<string | null> => {
  if (!TEXT_FILE_EXTENSION.test(path)) {
    return null;
  }

  return await fileSystem.readFile(path, { encoding: "utf-8" });
};

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

import type { FilesNodeDetail } from "./explorer-types";
import type { MasterFileSystem } from "./master-file-system";
import { getFilesNodeDetail, getTextArtifactSize, resolveFilesTarget } from "./service";

const containsControlCharacters = (value: string): boolean => {
  return Array.from(value).some((char) => {
    const code = char.charCodeAt(0);
    return code < 32 || code === 127;
  });
};

export const FILES_ACTION_INTENTS = ["create-folder", "delete", "write-text"] as const;
export type FilesActionIntent = (typeof FILES_ACTION_INTENTS)[number];

export type FilesActionResult = {
  ok: boolean;
  intent: FilesActionIntent;
  message: string;
  path?: string;
  detail?: FilesNodeDetail | null;
};

export async function performFilesAction(
  master: MasterFileSystem,
  input: {
    intent: FilesActionIntent;
    path: string;
    folderName?: string;
    content?: string;
  },
): Promise<FilesActionResult> {
  const target = await resolveFilesTarget(master, input.path);
  if (!target) {
    return {
      ok: false,
      intent: input.intent,
      message: `Path '${input.path}' could not be found.`,
    };
  }

  if (input.intent === "create-folder") {
    return performCreateFolderAction(master, target, input.folderName);
  }

  if (input.intent === "write-text") {
    return performWriteTextAction(master, target, input.content ?? "");
  }

  return performDeleteAction(target);
}

const performCreateFolderAction = async (
  master: MasterFileSystem,
  target: NonNullable<Awaited<ReturnType<typeof resolveFilesTarget>>>,
  folderName?: string,
): Promise<FilesActionResult> => {
  if (target.isRoot === false && !target.isFolderPath) {
    return unsupportedAction("create-folder", "Select a root or folder to create a child folder.");
  }

  if (target.mount.readOnly) {
    return readOnlyAction("create-folder", target.normalizedPath);
  }

  if (!target.mount.fs.capabilities.mkdir) {
    return unsupportedAction("create-folder", "Folder creation is unavailable for this mount.");
  }

  const resolved = resolveChildFolderPath(target.normalizedPath, folderName);
  if (resolved.error !== null) {
    return unsupportedAction("create-folder", resolved.error);
  }

  await target.mount.fs.mkdir(resolved.path, { recursive: true });

  return {
    ok: true,
    intent: "create-folder",
    message: `Created folder ${resolved.path}.`,
    path: resolved.path,
    detail: await getFilesNodeDetail(master, resolved.path),
  };
};

const performWriteTextAction = async (
  master: MasterFileSystem,
  target: NonNullable<Awaited<ReturnType<typeof resolveFilesTarget>>>,
  content: string,
): Promise<FilesActionResult> => {
  if (target.isRoot || target.isFolderPath) {
    return unsupportedAction("write-text", "Select a file to update its contents.");
  }

  if (target.mount.readOnly) {
    return readOnlyAction("write-text", target.normalizedPath);
  }

  if (!target.mount.fs.capabilities.writeFile) {
    return unsupportedAction("write-text", "Text editing is unavailable for this mount.");
  }

  const previousDetail = await getFilesNodeDetail(master, target.normalizedPath);

  await target.mount.fs.writeFile(target.normalizedPath, content, {
    encoding: "utf-8",
  });

  const refreshedDetail = await getFilesNodeDetail(master, target.normalizedPath);

  return {
    ok: true,
    intent: "write-text",
    message: `Saved ${target.normalizedPath}.`,
    path: target.normalizedPath,
    detail: refreshedDetail ?? createUpdatedDetail(previousDetail, content, target.normalizedPath),
  };
};

const performDeleteAction = async (
  target: NonNullable<Awaited<ReturnType<typeof resolveFilesTarget>>>,
): Promise<FilesActionResult> => {
  if (target.mount.readOnly) {
    return readOnlyAction("delete", target.normalizedPath);
  }

  if (target.isRoot) {
    return unsupportedAction("delete", "Roots cannot be deleted.");
  }

  if (!target.mount.fs.capabilities.rm) {
    return unsupportedAction("delete", "Delete is unavailable for this mount.");
  }

  await target.mount.fs.rm(target.normalizedPath, {
    recursive: target.isFolderPath,
    force: true,
  });

  return {
    ok: true,
    intent: "delete",
    message: `Deleted ${target.normalizedPath}.`,
    path: getParentExplorerPath(target.normalizedPath, target.mount.mountPoint),
    detail: null,
  };
};

const createUpdatedDetail = (
  detail: FilesNodeDetail | null,
  content: string,
  path: string,
): FilesNodeDetail | null => {
  if (!detail) {
    return null;
  }

  const size = getTextArtifactSize(content);
  return {
    ...detail,
    textContent: content,
    node: {
      ...detail.node,
      sizeBytes: size,
      contentType: detail.node.contentType ?? "text/plain",
      path,
    },
    fields: detail.fields.map((field) =>
      field.label === "Size" ? { ...field, value: formatBytesValue(size) } : field,
    ),
  };
};

const resolveChildFolderPath = (
  parentPath: string,
  folderName?: string,
): { path: string; error: null } | { path: null; error: string } => {
  const trimmed = folderName?.trim() ?? "";
  if (!trimmed) {
    return { path: null, error: "Folder name is required." };
  }

  if (containsControlCharacters(trimmed)) {
    return { path: null, error: "Folder paths cannot contain control characters." };
  }

  const segments = trimmed.split("/").map((segment) => segment.trim());
  if (segments.some((segment) => !segment || segment === "." || segment === "..")) {
    return { path: null, error: "Folder paths cannot contain empty, '.' or '..' segments." };
  }

  return {
    path: ensureFolderPath(
      `${stripTrailingSlash(ensureFolderPath(parentPath))}/${segments.join("/")}`,
    ),
    error: null,
  };
};

const getParentExplorerPath = (path: string, mountPoint: string): string => {
  const normalized = stripTrailingSlash(path);
  if (normalized === mountPoint) {
    return mountPoint;
  }

  const segments = normalized.split("/").filter(Boolean);
  if (segments.length <= 1) {
    return mountPoint;
  }

  const parent = `/${segments.slice(0, -1).join("/")}`;
  return parent === mountPoint ? mountPoint : ensureFolderPath(parent);
};

const readOnlyAction = (intent: FilesActionIntent, path: string): FilesActionResult => ({
  ok: false,
  intent,
  message: `${path} is read-only and does not support ${intent}.`,
});

const unsupportedAction = (intent: FilesActionIntent, message: string): FilesActionResult => ({
  ok: false,
  intent,
  message,
});

const stripTrailingSlash = (value: string): string => {
  if (value === "/") {
    return value;
  }

  return value.replace(/\/+$/, "");
};

const ensureFolderPath = (value: string): string => {
  if (value === "/") {
    return value;
  }

  return value.endsWith("/") ? value : `${value}/`;
};

const formatBytesValue = (value: number): string => {
  if (value === 0) {
    return "0 B";
  }

  const units = ["B", "KB", "MB", "GB", "TB"];
  const exponent = Math.min(Math.floor(Math.log(value) / Math.log(1024)), units.length - 1);
  const size = value / 1024 ** exponent;
  return `${size >= 10 || exponent === 0 ? size.toFixed(0) : size.toFixed(1)} ${units[exponent]}`;
};

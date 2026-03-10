import { Collapsible, Progress } from "@base-ui/react";
import {
  ChevronRight,
  Download,
  File as FileIcon,
  Folder,
  FolderOpen,
  RefreshCcw,
  Trash2,
  Upload,
} from "lucide-react";
import {
  Form,
  Link,
  redirect,
  useActionData,
  useLoaderData,
  useNavigation,
  useNavigate,
  useOutletContext,
  useRevalidator,
  type ActionFunctionArgs,
  type LoaderFunctionArgs,
} from "react-router";
import {
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type ChangeEvent,
  type DragEvent,
} from "react";
import { formatBytes } from "@/components/backoffice";
import { createUploadClient } from "@/fragno/upload-client";
import {
  deleteUploadFile,
  fetchUploadConfig,
  fetchUploadDownloadUrl,
  fetchUploadFile,
  fetchUploadFiles,
  type UploadFileRecord,
} from "./data";
import { formatTimestamp, type UploadLayoutContext } from "./shared";

type ExplorerSelectionKind = "root" | "folder" | "file";

type FilesLoaderData = {
  configError: string | null;
  filesError: string | null;
  files: UploadFileRecord[];
  selectedFile: UploadFileRecord | null;
  selectedFileError: string | null;
  selectedFileProvider: string | null;
  selectedFileKey: string | null;
  selectedNodeKind: ExplorerSelectionKind;
  selectedPrefix: string;
};

type FilesActionData = {
  ok: boolean;
  message: string;
  selectedFile?: UploadFileRecord | null;
  downloadUrl?: {
    url: string;
    expiresAt: string | Date;
    headers?: Record<string, string>;
  } | null;
};

type UploadQueueStatus = "queued" | "uploading" | "completed" | "failed";

type UploadQueueItem = {
  id: string;
  file: File;
  filename: string;
  sizeBytes: number;
  bytesUploaded: number;
  totalBytes: number;
  status: UploadQueueStatus;
  targetPrefix: string;
  errorMessage?: string;
};

type UploadTreeFolderNode = {
  name: string;
  prefix: string;
  folders: UploadTreeFolderNode[];
  files: UploadFileRecord[];
  fileCount: number;
  folderCount: number;
  totalSizeBytes: number;
  providers: string[];
};

type MutableUploadTreeFolderNode = {
  name: string;
  prefix: string;
  folders: MutableUploadTreeFolderNode[];
  folderMap: Map<string, MutableUploadTreeFolderNode>;
  files: UploadFileRecord[];
};

const FILE_PAGE_SIZE = 200;
const SORT_COLLATOR = new Intl.Collator("en", { numeric: true, sensitivity: "base" });
const hasControlCharacters = (value: string): boolean => {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code <= 0x1f || code === 0x7f) {
      return true;
    }
  }

  return false;
};

const createQueueItemId = () => {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }

  return `${Date.now()}-${Math.random().toString(16).slice(2)}`;
};

const toSafeFileSegment = (value: string) => {
  const sanitized = value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-+|-+$/g, "");

  return sanitized || "file";
};

const splitFilename = (filename: string) => {
  const lastDot = filename.lastIndexOf(".");
  if (lastDot <= 0 || lastDot === filename.length - 1) {
    return {
      base: filename,
      extension: "",
    };
  }

  return {
    base: filename.slice(0, lastDot),
    extension: filename
      .slice(lastDot)
      .toLowerCase()
      .replace(/[^a-z0-9.]+/g, ""),
  };
};

const stripTrailingSlash = (value: string) => value.replace(/\/+$/, "");

const normalizeFolderPrefix = (value?: string | null) => {
  const trimmed = value?.trim().replace(/^\/+|\/+$/g, "") ?? "";
  return trimmed ? `${trimmed}/` : "";
};

const getPathSegments = (value: string) => value.split("/").filter((segment) => segment.length > 0);

const getParentPrefix = (fileKey: string) => {
  const parts = getPathSegments(fileKey);
  if (parts.length <= 1) {
    return "";
  }

  return `${parts.slice(0, -1).join("/")}/`;
};

const getAncestorPrefixes = (prefix: string) => {
  const segments = getPathSegments(stripTrailingSlash(prefix));
  const ancestors: string[] = [];

  for (let index = 0; index < segments.length; index += 1) {
    ancestors.push(`${segments.slice(0, index + 1).join("/")}/`);
  }

  return ancestors;
};

const getLeafLabel = (value: string) => {
  const parts = getPathSegments(value);
  return parts[parts.length - 1] ?? value;
};

const formatPrefixLabel = (prefix: string) => {
  if (!prefix) {
    return "/";
  }

  return `/${stripTrailingSlash(prefix)}`;
};

const createReadableUploadKey = (targetPrefix: string, filename: string) => {
  const { base, extension } = splitFilename(filename);
  const suffix = createQueueItemId().replace(/-/g, "").slice(0, 8);
  const safeBase = toSafeFileSegment(base || filename);
  return `${targetPrefix}${safeBase}-${suffix}${extension}`;
};

const toFolderErrorMessage = (reason: string) => {
  if (reason === "EMPTY") {
    return "Folder name is required.";
  }

  if (reason === "EMPTY_SEGMENT") {
    return "Folder paths cannot contain empty segments.";
  }

  if (reason === "DOT_SEGMENT") {
    return "Folder paths cannot use '.' or '..' segments.";
  }

  if (reason === "CONTROL_CHARACTERS") {
    return "Folder paths cannot contain control characters.";
  }

  if (reason === "TOO_LONG") {
    return "Folder path is too long.";
  }

  return "Folder path is invalid.";
};

const validateFolderPath = (value: string) => {
  if (value.length === 0) {
    return { valid: false as const, reason: "EMPTY" };
  }

  if (hasControlCharacters(value)) {
    return { valid: false as const, reason: "CONTROL_CHARACTERS" };
  }

  for (const segment of value.split("/")) {
    if (segment.length === 0) {
      return { valid: false as const, reason: "EMPTY_SEGMENT" };
    }

    if (segment === "." || segment === "..") {
      return { valid: false as const, reason: "DOT_SEGMENT" };
    }
  }

  return { valid: true as const };
};

const resolveFolderPrefix = (parentPrefix: string, input: string) => {
  const relativePrefix = normalizeFolderPrefix(input);
  if (!relativePrefix) {
    return { prefix: null, error: "Folder name is required." };
  }

  const fullPrefix = `${parentPrefix}${relativePrefix}`;
  const validation = validateFolderPath(stripTrailingSlash(fullPrefix));
  if (!validation.valid) {
    return {
      prefix: null,
      error: toFolderErrorMessage(validation.reason),
    };
  }

  return {
    prefix: fullPrefix,
    error: null,
  };
};

const toStatusLabel = (status: UploadQueueStatus) => {
  if (status === "queued") {
    return "Queued";
  }

  if (status === "uploading") {
    return "Uploading";
  }

  if (status === "completed") {
    return "Uploaded";
  }

  return "Failed";
};

const toProgressPercent = (item: UploadQueueItem) => {
  if (item.totalBytes <= 0) {
    return item.status === "completed" ? 100 : 0;
  }

  return Math.max(0, Math.min(100, Math.round((item.bytesUploaded / item.totalBytes) * 100)));
};

const downloadBlob = (blob: Blob, filename: string) => {
  if (typeof document === "undefined" || typeof URL === "undefined") {
    throw new Error("Downloading is only supported in the browser.");
  }

  const objectUrl = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = objectUrl;
  link.download = filename || "download";
  link.rel = "noopener";
  link.style.display = "none";
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(objectUrl);
};

const parseSelectedNodeKind = (value?: string | null): ExplorerSelectionKind => {
  if (value === "file" || value === "folder" || value === "root") {
    return value;
  }

  return "root";
};

const buildSelectionHref = (
  orgId: string,
  selection:
    | {
        kind: "root";
      }
    | {
        kind: "folder";
        prefix: string;
      }
    | {
        kind: "file";
        provider: string;
        fileKey: string;
      },
) => {
  const searchParams = new URLSearchParams();

  if (selection.kind === "root") {
    searchParams.set("node", "root");
  } else if (selection.kind === "folder") {
    searchParams.set("node", "folder");
    if (selection.prefix) {
      searchParams.set("prefix", stripTrailingSlash(selection.prefix));
    }
  } else {
    searchParams.set("node", "file");
    searchParams.set("provider", selection.provider);
    searchParams.set("fileKey", selection.fileKey);
  }

  const query = searchParams.toString();
  return `/backoffice/connections/upload/${orgId}/files${query ? `?${query}` : ""}`;
};

const createMutableFolderNode = (name: string, prefix: string): MutableUploadTreeFolderNode => ({
  name,
  prefix,
  folders: [],
  folderMap: new Map<string, MutableUploadTreeFolderNode>(),
  files: [],
});

const ensureFolderPath = (root: MutableUploadTreeFolderNode, prefix: string) => {
  let current = root;
  const pathSegments = getPathSegments(stripTrailingSlash(prefix));

  for (const segment of pathSegments) {
    const nextPrefix = current.prefix ? `${current.prefix}${segment}/` : `${segment}/`;
    let next = current.folderMap.get(segment);

    if (!next) {
      next = createMutableFolderNode(segment, nextPrefix);
      current.folderMap.set(segment, next);
      current.folders.push(next);
    }

    current = next;
  }
};

const buildUploadFileTree = (files: UploadFileRecord[], extraPrefixes: string[] = []) => {
  const root = createMutableFolderNode("Root", "");
  const allFolderPrefixes: string[] = [];

  for (const file of files) {
    const fileSegments = getPathSegments(file.fileKey);
    let current = root;

    for (const folderSegment of fileSegments.slice(0, -1)) {
      const nextPrefix = current.prefix
        ? `${current.prefix}${folderSegment}/`
        : `${folderSegment}/`;
      let next = current.folderMap.get(folderSegment);

      if (!next) {
        next = createMutableFolderNode(folderSegment, nextPrefix);
        current.folderMap.set(folderSegment, next);
        current.folders.push(next);
      }

      current = next;
    }

    current.files.push(file);
  }

  for (const prefix of extraPrefixes) {
    if (prefix) {
      ensureFolderPath(root, prefix);
    }
  }

  const foldersByPrefix = new Map<string, UploadTreeFolderNode>();

  const finalizeNode = (node: MutableUploadTreeFolderNode): UploadTreeFolderNode => {
    const folders = [...node.folders]
      .sort((left, right) => SORT_COLLATOR.compare(left.name, right.name))
      .map(finalizeNode);
    const filesForNode = [...node.files].sort((left, right) =>
      SORT_COLLATOR.compare(left.fileKey, right.fileKey),
    );
    const providers = new Set(filesForNode.map((file) => file.provider));
    let fileCount = filesForNode.length;
    let folderCount = folders.length;
    let totalSizeBytes = filesForNode.reduce((sum, file) => sum + file.sizeBytes, 0);

    for (const folder of folders) {
      fileCount += folder.fileCount;
      folderCount += folder.folderCount;
      totalSizeBytes += folder.totalSizeBytes;

      for (const provider of folder.providers) {
        providers.add(provider);
      }
    }

    const finalizedNode: UploadTreeFolderNode = {
      name: node.name,
      prefix: node.prefix,
      folders,
      files: filesForNode,
      fileCount,
      folderCount,
      totalSizeBytes,
      providers: [...providers].sort(SORT_COLLATOR.compare),
    };

    foldersByPrefix.set(finalizedNode.prefix, finalizedNode);
    if (finalizedNode.prefix) {
      allFolderPrefixes.push(finalizedNode.prefix);
    }
    return finalizedNode;
  };

  return {
    root: finalizeNode(root),
    foldersByPrefix,
    allFolderPrefixes,
  };
};

const createSyntheticFolderNode = (prefix: string): UploadTreeFolderNode => ({
  name: getLeafLabel(stripTrailingSlash(prefix)),
  prefix,
  folders: [],
  files: [],
  fileCount: 0,
  folderCount: 0,
  totalSizeBytes: 0,
  providers: [],
});

export async function loader({ request, params, context }: LoaderFunctionArgs) {
  if (!params.orgId) {
    throw new Response("Not Found", { status: 404 });
  }

  const { configState, configError } = await fetchUploadConfig(context, params.orgId);
  if (configError) {
    return {
      configError,
      filesError: null,
      files: [],
      selectedFile: null,
      selectedFileError: null,
      selectedFileProvider: null,
      selectedFileKey: null,
      selectedNodeKind: "root",
      selectedPrefix: "",
    } satisfies FilesLoaderData;
  }

  if (!configState?.configured) {
    return redirect(`/backoffice/connections/upload/${params.orgId}/configuration`);
  }

  const url = new URL(request.url);
  let selectedNodeKind = parseSelectedNodeKind(url.searchParams.get("node"));
  let selectedPrefix = normalizeFolderPrefix(url.searchParams.get("prefix"));
  const requestedFileKey = url.searchParams.get("fileKey")?.trim() || null;
  const requestedProvider = url.searchParams.get("provider")?.trim() || null;

  if (selectedNodeKind === "folder" && !selectedPrefix) {
    selectedNodeKind = "root";
  }

  if (selectedNodeKind === "file" && !requestedFileKey) {
    selectedNodeKind = selectedPrefix ? "folder" : "root";
  }

  const filesResult = await fetchUploadFiles(request, context, params.orgId, {
    pageSize: FILE_PAGE_SIZE,
  });

  if (selectedNodeKind !== "file" || !requestedFileKey) {
    return {
      configError: null,
      filesError: filesResult.filesError,
      files: filesResult.files,
      selectedFile: null,
      selectedFileError: null,
      selectedFileProvider: null,
      selectedFileKey: null,
      selectedNodeKind,
      selectedPrefix,
    } satisfies FilesLoaderData;
  }

  const providerForSelection =
    requestedProvider ??
    filesResult.files.find((file) => file.fileKey === requestedFileKey)?.provider ??
    null;

  if (!providerForSelection) {
    return {
      configError: null,
      filesError: filesResult.filesError,
      files: filesResult.files,
      selectedFile: null,
      selectedFileError: "Provider is required to inspect a file by key.",
      selectedFileProvider: null,
      selectedFileKey: requestedFileKey,
      selectedNodeKind: "file",
      selectedPrefix: getParentPrefix(requestedFileKey),
    } satisfies FilesLoaderData;
  }

  const selected = await fetchUploadFile(
    request,
    context,
    params.orgId,
    providerForSelection,
    requestedFileKey,
  );

  return {
    configError: null,
    filesError: filesResult.filesError,
    files: filesResult.files,
    selectedFile: selected.file,
    selectedFileError: selected.error,
    selectedFileProvider: providerForSelection,
    selectedFileKey: requestedFileKey,
    selectedNodeKind: "file",
    selectedPrefix: getParentPrefix(requestedFileKey),
  } satisfies FilesLoaderData;
}

export async function action({ request, params, context }: ActionFunctionArgs) {
  if (!params.orgId) {
    throw new Response("Not Found", { status: 404 });
  }

  const formData = await request.formData();
  const intent = formData.get("intent");
  const providerValue = formData.get("provider");
  const provider = typeof providerValue === "string" ? providerValue.trim() : "";
  const fileKeyValue = formData.get("fileKey");
  const fileKey = typeof fileKeyValue === "string" ? fileKeyValue.trim() : "";

  if (!provider) {
    return {
      ok: false,
      message: "Provider is required.",
    } satisfies FilesActionData;
  }

  if (!fileKey) {
    return {
      ok: false,
      message: "File key is required.",
    } satisfies FilesActionData;
  }

  if (intent === "inspect-file") {
    const result = await fetchUploadFile(request, context, params.orgId, provider, fileKey);
    if (result.error || !result.file) {
      return {
        ok: false,
        message: result.error ?? "Unable to load file.",
      } satisfies FilesActionData;
    }

    return {
      ok: true,
      message: "Loaded file details.",
      selectedFile: result.file,
    } satisfies FilesActionData;
  }

  if (intent === "download-url") {
    const result = await fetchUploadDownloadUrl(request, context, params.orgId, provider, fileKey);
    if (result.error || !result.result) {
      return {
        ok: false,
        message: result.error ?? "Unable to fetch download URL.",
      } satisfies FilesActionData;
    }

    const selected = await fetchUploadFile(request, context, params.orgId, provider, fileKey);

    return {
      ok: true,
      message: "Download URL generated.",
      selectedFile: selected.file,
      downloadUrl: result.result,
    } satisfies FilesActionData;
  }

  if (intent === "delete-file") {
    const deleted = await deleteUploadFile(request, context, params.orgId, provider, fileKey);
    if (!deleted.ok) {
      return {
        ok: false,
        message: deleted.error ?? "Unable to delete file.",
      } satisfies FilesActionData;
    }

    return {
      ok: true,
      message: "File deleted.",
      selectedFile: null,
      downloadUrl: null,
    } satisfies FilesActionData;
  }

  return {
    ok: false,
    message: "Unknown file action.",
  } satisfies FilesActionData;
}

export default function BackofficeOrganisationUploadFiles() {
  const {
    configError,
    filesError,
    files,
    selectedFile: loaderSelectedFile,
    selectedFileError,
    selectedFileProvider,
    selectedFileKey,
    selectedNodeKind,
    selectedPrefix,
  } = useLoaderData<typeof loader>();
  const actionData = useActionData<typeof action>();
  const navigation = useNavigation();
  const navigate = useNavigate();
  const revalidator = useRevalidator();
  const { orgId, configState } = useOutletContext<UploadLayoutContext>();
  const uploadClient = useMemo(() => createUploadClient(orgId), [orgId]);
  const uploadHelpers = uploadClient.useUploadHelpers();
  const [uploadQueue, setUploadQueue] = useState<UploadQueueItem[]>([]);
  const [uploadingFiles, setUploadingFiles] = useState(false);
  const [activeUploadPrefix, setActiveUploadPrefix] = useState<string | null>(null);
  const [uploadError, setUploadError] = useState<string | null>(null);
  const [downloadError, setDownloadError] = useState<string | null>(null);
  const [downloadingFile, setDownloadingFile] = useState(false);
  const [dragDepth, setDragDepth] = useState(0);
  const [virtualFolders, setVirtualFolders] = useState<Set<string>>(() => new Set());
  const [pendingFolderName, setPendingFolderName] = useState("");
  const [folderCreateError, setFolderCreateError] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const fileInputId = useId();

  const actionError = actionData && !actionData.ok ? actionData.message : null;
  const actionSuccess = actionData && actionData.ok ? actionData.message : null;
  const actionSelectedFile =
    actionData && Object.prototype.hasOwnProperty.call(actionData, "selectedFile")
      ? (actionData.selectedFile ?? null)
      : undefined;
  const selectedFile = actionSelectedFile === undefined ? loaderSelectedFile : actionSelectedFile;
  const selectedProvider = selectedFile?.provider ?? selectedFileProvider ?? null;
  const supportsSignedDownload = selectedProvider === "r2";
  const defaultProvider = configState?.defaultProvider;
  const actionBusy = navigation.state === "submitting";
  const refreshing = revalidator.state === "loading";
  const selectedExplorerPrefix =
    selectedNodeKind === "file"
      ? getParentPrefix(selectedFile?.fileKey ?? selectedFileKey ?? "")
      : selectedPrefix;
  const extraFolderPrefixes = useMemo(() => {
    const prefixes = new Set(virtualFolders);
    if (selectedExplorerPrefix) {
      prefixes.add(selectedExplorerPrefix);
    }

    return [...prefixes].sort(SORT_COLLATOR.compare);
  }, [selectedExplorerPrefix, virtualFolders]);
  const {
    root: fileTree,
    foldersByPrefix,
    allFolderPrefixes,
  } = useMemo(() => buildUploadFileTree(files, extraFolderPrefixes), [extraFolderPrefixes, files]);
  const [openFolders, setOpenFolders] = useState<Set<string>>(() => new Set(allFolderPrefixes));
  const knownFolderPrefixesRef = useRef<Set<string>>(new Set(allFolderPrefixes));
  const selectedNodeKey =
    selectedNodeKind === "file" && selectedFileKey
      ? `file:${selectedFileProvider ?? "unknown"}:${selectedFileKey}`
      : selectedNodeKind === "folder"
        ? `folder:${selectedPrefix}`
        : "root";
  const selectedFolderNode =
    selectedNodeKind === "root"
      ? fileTree
      : selectedNodeKind === "folder"
        ? (foldersByPrefix.get(selectedPrefix) ?? createSyntheticFolderNode(selectedPrefix))
        : null;
  const uploadTargetPrefix =
    selectedNodeKind === "root" ? "" : selectedNodeKind === "folder" ? selectedPrefix : null;
  const folderQueue =
    uploadTargetPrefix === null
      ? []
      : uploadQueue.filter((item) => item.targetPrefix === uploadTargetPrefix);
  const hasFailedUploads = folderQueue.some((item) => item.status === "failed");
  const hasFinishedUploads = folderQueue.some(
    (item) => item.status === "completed" || item.status === "failed",
  );
  const nextQueuedUploadPrefix =
    uploadQueue.find((item) => item.status === "queued")?.targetPrefix ?? null;
  const pendingUploadsElsewhere =
    uploadTargetPrefix === null
      ? 0
      : uploadQueue.filter(
          (item) =>
            item.targetPrefix !== uploadTargetPrefix &&
            (item.status === "queued" || item.status === "uploading" || item.status === "failed"),
        ).length;
  const downloadUrl =
    actionData?.downloadUrl &&
    selectedFile &&
    actionData.selectedFile?.fileKey === selectedFile.fileKey &&
    actionData.selectedFile?.provider === selectedFile.provider
      ? actionData.downloadUrl
      : null;
  const missingFileParentHref = buildSelectionHref(
    orgId,
    selectedPrefix ? { kind: "folder", prefix: selectedPrefix } : { kind: "root" },
  );
  const isDragActive = dragDepth > 0;

  const startUploads = useCallback(
    async (targetPrefix: string, options: { includeFailed?: boolean } = {}) => {
      if (uploadingFiles) {
        return;
      }

      const includeFailed = options.includeFailed ?? true;
      const candidates = uploadQueue.filter(
        (item) =>
          item.targetPrefix === targetPrefix &&
          (item.status === "queued" || (includeFailed && item.status === "failed")),
      );
      if (candidates.length === 0) {
        return;
      }

      if (!defaultProvider) {
        setUploadError("Select and configure a default provider before uploading files.");
        return;
      }

      setUploadError(null);
      setUploadingFiles(true);
      setActiveUploadPrefix(targetPrefix);

      try {
        for (const item of candidates) {
          setUploadQueue((previous) =>
            previous.map((entry) =>
              entry.id === item.id
                ? {
                    ...entry,
                    status: "uploading",
                    bytesUploaded: 0,
                    totalBytes: entry.sizeBytes,
                    errorMessage: undefined,
                  }
                : entry,
            ),
          );

          try {
            await uploadHelpers.createUploadAndTransfer(item.file, {
              provider: defaultProvider,
              fileKey: createReadableUploadKey(item.targetPrefix, item.filename),
              filename: item.filename,
              contentType: item.file.type || "application/octet-stream",
              onProgress: (progress) => {
                setUploadQueue((previous) =>
                  previous.map((entry) =>
                    entry.id === item.id
                      ? {
                          ...entry,
                          status: "uploading",
                          bytesUploaded: progress.bytesUploaded,
                          totalBytes:
                            progress.totalBytes > 0 ? progress.totalBytes : entry.totalBytes,
                        }
                      : entry,
                  ),
                );
              },
            });

            setUploadQueue((previous) =>
              previous.map((entry) =>
                entry.id === item.id
                  ? {
                      ...entry,
                      status: "completed",
                      bytesUploaded: entry.totalBytes,
                      errorMessage: undefined,
                    }
                  : entry,
              ),
            );
          } catch (error) {
            setUploadQueue((previous) =>
              previous.map((entry) =>
                entry.id === item.id
                  ? {
                      ...entry,
                      status: "failed",
                      errorMessage:
                        error instanceof Error ? error.message : "Upload failed for this file.",
                    }
                  : entry,
              ),
            );
          }
        }
      } catch (error) {
        setUploadError(error instanceof Error ? error.message : "Unable to run uploads.");
      } finally {
        setUploadingFiles(false);
        setActiveUploadPrefix(null);
        revalidator.revalidate();
      }
    },
    [defaultProvider, revalidator, uploadHelpers, uploadingFiles, uploadQueue],
  );

  useEffect(() => {
    setOpenFolders((previous) => {
      const next = new Set(previous);

      for (const prefix of getAncestorPrefixes(selectedPrefix)) {
        next.add(prefix);
      }

      return next;
    });
  }, [selectedPrefix]);

  useEffect(() => {
    setOpenFolders((previous) => {
      const next = new Set(previous);
      let changed = false;

      for (const prefix of allFolderPrefixes) {
        if (!knownFolderPrefixesRef.current.has(prefix)) {
          next.add(prefix);
          changed = true;
        }
      }

      return changed ? next : previous;
    });
    knownFolderPrefixesRef.current = new Set(allFolderPrefixes);
  }, [allFolderPrefixes]);

  useEffect(() => {
    setPendingFolderName("");
    setFolderCreateError(null);
  }, [uploadTargetPrefix]);

  useEffect(() => {
    setDragDepth(0);
  }, [selectedNodeKind, selectedPrefix, selectedFileKey, selectedFileProvider]);

  useEffect(() => {
    if (uploadingFiles || !defaultProvider || !nextQueuedUploadPrefix) {
      return;
    }

    void startUploads(nextQueuedUploadPrefix, { includeFailed: false });
  }, [defaultProvider, nextQueuedUploadPrefix, startUploads, uploadingFiles]);

  if (configError) {
    return (
      <div className="border border-red-200 bg-red-50 p-4 text-sm text-red-600">{configError}</div>
    );
  }

  const queueFilesForPrefix = (incomingFiles: File[], targetPrefix: string) => {
    if (incomingFiles.length === 0) {
      return;
    }

    if (!defaultProvider) {
      setUploadError("Select and configure a default provider before uploading files.");
      return;
    }

    setUploadError(null);
    setUploadQueue((previous) => [
      ...previous,
      ...incomingFiles.map((file) => ({
        id: createQueueItemId(),
        file,
        filename: file.name || "upload",
        sizeBytes: file.size,
        bytesUploaded: 0,
        totalBytes: file.size,
        status: "queued" as const,
        targetPrefix,
      })),
    ]);
  };

  const handleBrowseSelection = (event: ChangeEvent<HTMLInputElement>) => {
    if (uploadTargetPrefix === null) {
      return;
    }

    queueFilesForPrefix(Array.from(event.target.files ?? []), uploadTargetPrefix);
    event.target.value = "";
  };

  const handleDropFiles = (event: DragEvent<HTMLDivElement>) => {
    if (uploadTargetPrefix === null) {
      return;
    }

    event.preventDefault();
    setDragDepth(0);
    queueFilesForPrefix(Array.from(event.dataTransfer.files ?? []), uploadTargetPrefix);
  };

  const handleDragEnter = (event: DragEvent<HTMLDivElement>) => {
    if (!event.dataTransfer.types.includes("Files")) {
      return;
    }

    event.preventDefault();
    setDragDepth((current) => current + 1);
  };

  const handleDragOver = (event: DragEvent<HTMLDivElement>) => {
    if (!event.dataTransfer.types.includes("Files")) {
      return;
    }

    event.preventDefault();
    event.dataTransfer.dropEffect = "copy";
  };

  const handleDragLeave = (event: DragEvent<HTMLDivElement>) => {
    if (!event.dataTransfer.types.includes("Files")) {
      return;
    }

    event.preventDefault();
    setDragDepth((current) => Math.max(0, current - 1));
  };

  const clearFinishedUploads = (targetPrefix: string) => {
    setUploadQueue((previous) =>
      previous.filter(
        (item) =>
          item.targetPrefix !== targetPrefix ||
          (item.status !== "completed" && item.status !== "failed"),
      ),
    );
  };

  const createFolder = () => {
    if (uploadTargetPrefix === null) {
      return;
    }

    const result = resolveFolderPrefix(uploadTargetPrefix, pendingFolderName);
    if (!result.prefix) {
      setFolderCreateError(result.error);
      return;
    }
    const nextPrefix = result.prefix;

    setFolderCreateError(null);
    setPendingFolderName("");

    if (!foldersByPrefix.has(nextPrefix)) {
      setVirtualFolders((previous) => {
        if (previous.has(nextPrefix)) {
          return previous;
        }

        const next = new Set(previous);
        next.add(nextPrefix);
        return next;
      });
    }

    navigate(buildSelectionHref(orgId, { kind: "folder", prefix: nextPrefix }));
  };

  const setFolderOpen = (prefix: string, open: boolean) => {
    setOpenFolders((previous) => {
      const next = new Set(previous);

      if (open) {
        next.add(prefix);
      } else {
        next.delete(prefix);
      }

      return next;
    });
  };

  const handleDownloadFile = async () => {
    if (!selectedFile || downloadingFile) {
      return;
    }

    setDownloadError(null);
    setDownloadingFile(true);

    try {
      const response = await uploadHelpers.downloadFile(selectedFile.fileKey, {
        provider: selectedFile.provider,
        method: supportsSignedDownload ? "signed-url" : "content",
      });
      const blob = await response.blob();
      downloadBlob(blob, selectedFile.filename || "download");
    } catch (error) {
      setDownloadError(error instanceof Error ? error.message : "Unable to download file.");
    } finally {
      setDownloadingFile(false);
    }
  };

  return (
    <div className="space-y-4">
      {filesError ? <p className="text-xs text-red-500">{filesError}</p> : null}
      {selectedFileError ? <p className="text-xs text-red-500">{selectedFileError}</p> : null}
      {actionError ? <p className="text-xs text-red-500">{actionError}</p> : null}
      {actionSuccess ? <p className="text-xs text-green-500">{actionSuccess}</p> : null}
      {uploadError ? <p className="text-xs text-red-500">{uploadError}</p> : null}
      {downloadError ? <p className="text-xs text-red-500">{downloadError}</p> : null}

      <section className="grid gap-4 lg:grid-cols-[minmax(18rem,0.92fr)_minmax(24rem,1.08fr)]">
        <div className="border border-[color:var(--bo-border)] bg-[var(--bo-panel)] p-4">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div>
              <p className="text-[10px] uppercase tracking-[0.24em] text-[var(--bo-muted-2)]">
                Explorer
              </p>
              <p className="mt-2 text-sm text-[var(--bo-muted)]">
                Browse the stored key hierarchy. Select a folder to upload into it or a file to
                inspect it.
              </p>
            </div>

            <span className="border border-[color:var(--bo-border)] bg-[var(--bo-panel-2)] px-2 py-1 text-[10px] uppercase tracking-[0.22em] text-[var(--bo-muted)]">
              {files.length} loaded
            </span>
          </div>

          <nav
            aria-label="Upload file explorer"
            className="mt-4 rounded-sm border border-[color:var(--bo-border)] bg-[var(--bo-panel-2)] p-3"
          >
            <Link
              to={buildSelectionHref(orgId, { kind: "root" })}
              aria-current={selectedNodeKey === "root" ? "page" : undefined}
              className={
                selectedNodeKey === "root"
                  ? "flex items-center justify-between gap-3 rounded-sm border border-[color:var(--bo-border)] bg-[var(--bo-panel)] px-3 py-3 text-[var(--bo-fg)]"
                  : "flex items-center justify-between gap-3 rounded-sm border border-transparent bg-transparent px-3 py-3 text-[var(--bo-muted)] transition-colors hover:border-[color:var(--bo-border)] hover:bg-[var(--bo-panel)] hover:text-[var(--bo-fg)]"
              }
            >
              <span className="flex min-w-0 items-center gap-2">
                <FolderOpen className="h-4 w-4 shrink-0" />
                <span className="truncate text-sm font-semibold">Root</span>
              </span>
              <span className="text-current/70 shrink-0 text-[11px] uppercase tracking-[0.22em]">
                {fileTree.fileCount} files
              </span>
            </Link>

            {fileTree.folders.length === 0 && fileTree.files.length === 0 ? (
              <p className="mt-4 text-sm text-[var(--bo-muted)]">
                No files found yet. Select root and drop files to start populating the tree.
              </p>
            ) : (
              <div className="mt-3 space-y-1">
                {fileTree.folders.map((folder) => (
                  <UploadFolderTreeNode
                    key={folder.prefix}
                    folder={folder}
                    orgId={orgId}
                    selectedNodeKey={selectedNodeKey}
                    openPrefixes={openFolders}
                    onOpenChange={setFolderOpen}
                  />
                ))}
                {fileTree.files.map((file) => (
                  <UploadFileTreeLeaf
                    key={`${file.provider}:${file.fileKey}`}
                    file={file}
                    orgId={orgId}
                    selectedNodeKey={selectedNodeKey}
                  />
                ))}
              </div>
            )}
          </nav>
        </div>

        <div className="border border-[color:var(--bo-border)] bg-[var(--bo-panel)] p-4">
          {selectedNodeKind === "file" ? (
            selectedFile ? (
              <div className="space-y-4">
                <div className="border border-[color:var(--bo-border)] bg-[var(--bo-panel-2)] p-4">
                  <div className="flex flex-wrap items-start justify-between gap-3">
                    <div>
                      <p className="text-[10px] uppercase tracking-[0.24em] text-[var(--bo-muted-2)]">
                        File detail
                      </p>
                      <p className="mt-2 text-lg font-semibold text-[var(--bo-fg)]">
                        {selectedFile.filename}
                      </p>
                      <p className="mt-1 break-all text-xs text-[var(--bo-muted)]">
                        {selectedFile.fileKey}
                      </p>
                    </div>

                    <Link
                      to={missingFileParentHref}
                      className="border border-[color:var(--bo-border)] bg-[var(--bo-panel)] px-3 py-2 text-[10px] font-semibold uppercase tracking-[0.22em] text-[var(--bo-muted)] transition-colors hover:border-[color:var(--bo-border-strong)] hover:text-[var(--bo-fg)]"
                    >
                      Open folder
                    </Link>
                  </div>

                  <div className="mt-4 grid gap-3 sm:grid-cols-2">
                    <DetailStat label="Provider" value={selectedFile.provider} />
                    <DetailStat label="Status" value={selectedFile.status} />
                    <DetailStat label="Size" value={formatBytes(selectedFile.sizeBytes)} />
                    <DetailStat label="Content type" value={selectedFile.contentType} />
                    <DetailStat
                      label="Created"
                      value={formatTimestamp(selectedFile.createdAt) || "Unknown"}
                    />
                    <DetailStat
                      label="Updated"
                      value={formatTimestamp(selectedFile.updatedAt) || "Unknown"}
                    />
                  </div>
                </div>

                {downloadUrl ? (
                  <div className="border border-[color:var(--bo-border)] bg-[var(--bo-panel-2)] p-3 text-sm text-[var(--bo-muted)]">
                    <p className="text-[10px] uppercase tracking-[0.22em] text-[var(--bo-muted-2)]">
                      Download URL
                    </p>
                    <p className="mt-2 break-all text-[var(--bo-fg)]">{downloadUrl.url}</p>
                    <p className="mt-1 text-xs text-[var(--bo-muted-2)]">
                      Expires: {formatTimestamp(downloadUrl.expiresAt)}
                    </p>
                  </div>
                ) : null}

                <div className="grid gap-2">
                  <button
                    type="button"
                    onClick={() => revalidator.revalidate()}
                    disabled={refreshing}
                    className="inline-flex w-full items-center justify-center gap-2 border border-[color:var(--bo-border)] bg-[var(--bo-panel-2)] px-3 py-2 text-[11px] font-semibold uppercase tracking-[0.22em] text-[var(--bo-muted)] transition-colors hover:border-[color:var(--bo-border-strong)] hover:text-[var(--bo-fg)] disabled:opacity-60"
                  >
                    <RefreshCcw className={`h-3.5 w-3.5 ${refreshing ? "animate-spin" : ""}`} />
                    {refreshing ? "Refreshing…" : "Refresh detail"}
                  </button>

                  {supportsSignedDownload ? (
                    <Form method="post">
                      <input type="hidden" name="intent" value="download-url" />
                      <input type="hidden" name="provider" value={selectedFile.provider} />
                      <input type="hidden" name="fileKey" value={selectedFile.fileKey} />
                      <button
                        type="submit"
                        disabled={actionBusy}
                        className="inline-flex w-full items-center justify-center gap-2 border border-[color:var(--bo-border)] bg-[var(--bo-panel-2)] px-3 py-2 text-[11px] font-semibold uppercase tracking-[0.22em] text-[var(--bo-muted)] transition-colors hover:border-[color:var(--bo-border-strong)] hover:text-[var(--bo-fg)] disabled:opacity-60"
                      >
                        <Download className="h-3.5 w-3.5" />
                        Generate download URL
                      </button>
                    </Form>
                  ) : (
                    <button
                      type="button"
                      onClick={() => void handleDownloadFile()}
                      disabled={actionBusy || downloadingFile}
                      className="inline-flex w-full items-center justify-center gap-2 border border-[color:var(--bo-border)] bg-[var(--bo-panel-2)] px-3 py-2 text-[11px] font-semibold uppercase tracking-[0.22em] text-[var(--bo-muted)] transition-colors hover:border-[color:var(--bo-border-strong)] hover:text-[var(--bo-fg)] disabled:opacity-60"
                    >
                      <Download className="h-3.5 w-3.5" />
                      {downloadingFile ? "Downloading…" : "Download file"}
                    </button>
                  )}

                  <Form method="post">
                    <input type="hidden" name="intent" value="delete-file" />
                    <input type="hidden" name="provider" value={selectedFile.provider} />
                    <input type="hidden" name="fileKey" value={selectedFile.fileKey} />
                    <button
                      type="submit"
                      disabled={actionBusy}
                      className="inline-flex w-full items-center justify-center gap-2 border border-red-300 bg-red-50 px-3 py-2 text-[11px] font-semibold uppercase tracking-[0.22em] text-red-600 transition-colors hover:border-red-400 disabled:opacity-60"
                    >
                      <Trash2 className="h-3.5 w-3.5" />
                      Delete file
                    </button>
                  </Form>
                </div>
              </div>
            ) : (
              <div className="space-y-4">
                <div className="border border-[color:var(--bo-border)] bg-[var(--bo-panel-2)] p-4">
                  <p className="text-[10px] uppercase tracking-[0.24em] text-[var(--bo-muted-2)]">
                    File detail
                  </p>
                  <p className="mt-2 text-sm text-[var(--bo-muted)]">
                    The selected file is no longer available. Open its containing folder to upload a
                    replacement or inspect nearby files.
                  </p>
                  <div className="mt-4">
                    <Link
                      to={missingFileParentHref}
                      className="inline-flex items-center gap-2 border border-[color:var(--bo-border)] bg-[var(--bo-panel)] px-3 py-2 text-[10px] font-semibold uppercase tracking-[0.22em] text-[var(--bo-muted)] transition-colors hover:border-[color:var(--bo-border-strong)] hover:text-[var(--bo-fg)]"
                    >
                      <FolderOpen className="h-3.5 w-3.5" />
                      Open containing folder
                    </Link>
                  </div>
                </div>
              </div>
            )
          ) : (
            <div className="space-y-4">
              <div className="border border-[color:var(--bo-border)] bg-[var(--bo-panel-2)] p-4">
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div>
                    <p className="text-[10px] uppercase tracking-[0.24em] text-[var(--bo-muted-2)]">
                      Upload target
                    </p>
                    <p className="mt-2 text-lg font-semibold text-[var(--bo-fg)]">
                      {selectedNodeKind === "root"
                        ? "Root"
                        : (selectedFolderNode?.name ??
                          getLeafLabel(stripTrailingSlash(selectedPrefix)))}
                    </p>
                    <p className="mt-1 text-xs text-[var(--bo-muted)]">
                      Uploads land under{" "}
                      <span className="font-semibold text-[var(--bo-fg)]">
                        {formatPrefixLabel(uploadTargetPrefix ?? "")}
                      </span>{" "}
                      using readable collision-safe keys.
                    </p>
                  </div>

                  <span className="border border-[color:var(--bo-border)] bg-[var(--bo-panel)] px-2 py-1 text-[10px] uppercase tracking-[0.22em] text-[var(--bo-muted)]">
                    Uploads via: {defaultProvider ?? "not set"}
                  </span>
                </div>

                <div className="mt-4 grid gap-3 sm:grid-cols-3">
                  <DetailStat label="Files" value={String(selectedFolderNode?.fileCount ?? 0)} />
                  <DetailStat
                    label="Nested folders"
                    value={String(selectedFolderNode?.folderCount ?? 0)}
                  />
                  <DetailStat
                    label="Stored size"
                    value={formatBytes(selectedFolderNode?.totalSizeBytes ?? 0)}
                  />
                </div>

                {selectedFolderNode?.providers.length ? (
                  <div className="mt-4 flex flex-wrap gap-2">
                    {selectedFolderNode.providers.map((provider) => (
                      <span
                        key={provider}
                        className="border border-[color:var(--bo-border)] bg-[var(--bo-panel)] px-2 py-1 text-[10px] uppercase tracking-[0.22em] text-[var(--bo-muted)]"
                      >
                        {provider}
                      </span>
                    ))}
                  </div>
                ) : null}
              </div>

              <form
                onSubmit={(event) => {
                  event.preventDefault();
                  createFolder();
                }}
                className="border border-[color:var(--bo-border)] bg-[var(--bo-panel-2)] p-4"
              >
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div>
                    <p className="text-[10px] uppercase tracking-[0.24em] text-[var(--bo-muted-2)]">
                      Create folder
                    </p>
                    <p className="mt-2 text-sm text-[var(--bo-muted)]">
                      Add a child folder under{" "}
                      <span className="font-semibold text-[var(--bo-fg)]">
                        {formatPrefixLabel(uploadTargetPrefix ?? "")}
                      </span>
                      . It stays local until a file is uploaded into it.
                    </p>
                  </div>
                </div>

                <div className="mt-4 flex flex-col gap-3 sm:flex-row">
                  <input
                    type="text"
                    value={pendingFolderName}
                    onChange={(event) => {
                      setPendingFolderName(event.target.value);
                      if (folderCreateError) {
                        setFolderCreateError(null);
                      }
                    }}
                    placeholder={uploadTargetPrefix ? "nested/reports" : "assets/images"}
                    className="min-w-0 flex-1 rounded-sm border border-[color:var(--bo-border)] bg-[var(--bo-panel)] px-3 py-2 text-sm text-[var(--bo-fg)] outline-none transition-colors placeholder:text-[var(--bo-muted-2)] focus:border-[color:var(--bo-accent)]"
                  />
                  <button
                    type="submit"
                    disabled={!pendingFolderName.trim()}
                    className="inline-flex items-center justify-center gap-2 rounded-sm border border-[color:var(--bo-border)] bg-[var(--bo-panel)] px-3 py-2 text-[10px] font-semibold uppercase tracking-[0.22em] text-[var(--bo-muted)] transition-colors hover:border-[color:var(--bo-border-strong)] hover:text-[var(--bo-fg)] disabled:opacity-60"
                  >
                    <Folder className="h-3.5 w-3.5" />
                    Create folder
                  </button>
                </div>

                {folderCreateError ? (
                  <p className="mt-3 text-xs text-red-500">{folderCreateError}</p>
                ) : (
                  <p className="mt-3 text-xs text-[var(--bo-muted-2)]">
                    Use slash-delimited names like `reports/2026/march`.
                  </p>
                )}
              </form>

              <div
                className={
                  isDragActive
                    ? "border border-[color:var(--bo-accent)] bg-[var(--bo-accent-bg)] p-4"
                    : "border border-dashed border-[color:var(--bo-border-strong)] bg-[var(--bo-panel-2)] p-4"
                }
                onDrop={handleDropFiles}
                onDragEnter={handleDragEnter}
                onDragOver={handleDragOver}
                onDragLeave={handleDragLeave}
              >
                <input
                  id={fileInputId}
                  ref={fileInputRef}
                  type="file"
                  multiple
                  onChange={handleBrowseSelection}
                  className="sr-only"
                />

                <div className="flex flex-col gap-4 lg:flex-row lg:items-end lg:justify-between">
                  <div>
                    <p className="text-[10px] uppercase tracking-[0.24em] text-[var(--bo-muted-2)]">
                      Drop zone
                    </p>
                    <p className="mt-2 text-sm text-[var(--bo-muted)]">
                      Drag files here or choose them manually. New files upload straight into{" "}
                      <span className="font-semibold text-[var(--bo-fg)]">
                        {formatPrefixLabel(uploadTargetPrefix ?? "")}
                      </span>
                      .
                    </p>
                  </div>

                  <div className="flex flex-wrap gap-2">
                    <button
                      type="button"
                      onClick={() => fileInputRef.current?.click()}
                      className="inline-flex items-center gap-2 border border-[color:var(--bo-border)] bg-[var(--bo-panel)] px-3 py-2 text-[10px] font-semibold uppercase tracking-[0.22em] text-[var(--bo-muted)] transition-colors hover:border-[color:var(--bo-border-strong)] hover:text-[var(--bo-fg)]"
                    >
                      <Upload className="h-3.5 w-3.5" />
                      Choose files
                    </button>
                    {hasFailedUploads ? (
                      <button
                        type="button"
                        onClick={() =>
                          uploadTargetPrefix !== null && void startUploads(uploadTargetPrefix)
                        }
                        disabled={uploadingFiles || uploadTargetPrefix === null}
                        className="inline-flex items-center gap-2 border border-[color:var(--bo-accent)] bg-[var(--bo-accent-bg)] px-3 py-2 text-[10px] font-semibold uppercase tracking-[0.22em] text-[var(--bo-accent-fg)] transition-colors hover:border-[color:var(--bo-accent-strong)] disabled:opacity-60"
                      >
                        <RefreshCcw className="h-3.5 w-3.5" />
                        {uploadingFiles && activeUploadPrefix === uploadTargetPrefix
                          ? "Uploading…"
                          : "Retry failed"}
                      </button>
                    ) : null}
                    <button
                      type="button"
                      onClick={() =>
                        uploadTargetPrefix !== null && clearFinishedUploads(uploadTargetPrefix)
                      }
                      disabled={
                        !hasFinishedUploads || uploadingFiles || uploadTargetPrefix === null
                      }
                      className="inline-flex items-center gap-2 border border-[color:var(--bo-border)] bg-[var(--bo-panel)] px-3 py-2 text-[10px] font-semibold uppercase tracking-[0.22em] text-[var(--bo-muted)] transition-colors hover:border-[color:var(--bo-border-strong)] hover:text-[var(--bo-fg)] disabled:opacity-60"
                    >
                      <Trash2 className="h-3.5 w-3.5" />
                      Clear finished
                    </button>
                  </div>
                </div>

                {pendingUploadsElsewhere > 0 ? (
                  <p className="mt-3 text-xs text-[var(--bo-muted-2)]">
                    {pendingUploadsElsewhere} queued, active, or failed upload
                    {pendingUploadsElsewhere === 1 ? "" : "s"} in another folder.
                  </p>
                ) : null}
              </div>

              {folderQueue.length > 0 ? (
                <div className="space-y-2">
                  {folderQueue.map((item) => (
                    <UploadQueueCard key={item.id} item={item} />
                  ))}
                </div>
              ) : (
                <div className="border border-[color:var(--bo-border)] bg-[var(--bo-panel-2)] p-4 text-sm text-[var(--bo-muted)]">
                  No files queued for {formatPrefixLabel(uploadTargetPrefix ?? "")} yet.
                </div>
              )}
            </div>
          )}
        </div>
      </section>
    </div>
  );
}

function DetailStat({ label, value }: { label: string; value: string }) {
  return (
    <div className="border border-[color:var(--bo-border)] bg-[var(--bo-panel)] p-3">
      <p className="text-[10px] uppercase tracking-[0.22em] text-[var(--bo-muted-2)]">{label}</p>
      <p className="mt-2 text-sm font-semibold text-[var(--bo-fg)]">{value}</p>
    </div>
  );
}

function UploadQueueCard({ item }: { item: UploadQueueItem }) {
  const progressPercent = toProgressPercent(item);
  const statusTone =
    item.status === "failed"
      ? "text-red-500"
      : item.status === "completed"
        ? "text-green-500"
        : "text-[var(--bo-muted)]";

  return (
    <Progress.Root
      value={progressPercent}
      className="border border-[color:var(--bo-border)] bg-[var(--bo-panel-2)] px-3 py-3"
      aria-valuetext={`${progressPercent}% uploaded`}
    >
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <Progress.Label className="block truncate text-sm font-semibold text-[var(--bo-fg)]">
            {item.filename}
          </Progress.Label>
          <p className="mt-1 text-[11px] text-[var(--bo-muted-2)]">
            Target {formatPrefixLabel(item.targetPrefix)}
          </p>
        </div>
        <div className="shrink-0 text-right">
          <span className={`text-xs ${statusTone}`}>{toStatusLabel(item.status)}</span>
          <p className="mt-1 text-[11px] text-[var(--bo-muted-2)]">
            {formatBytes(item.bytesUploaded)} / {formatBytes(item.totalBytes)}
          </p>
        </div>
      </div>

      <Progress.Track className="mt-3 h-1.5 w-full overflow-hidden border border-[color:var(--bo-border)] bg-[var(--bo-panel)]">
        <Progress.Indicator
          className="h-full bg-[var(--bo-accent)] transition-[width]"
          style={{ width: `${progressPercent}%` }}
        />
      </Progress.Track>

      {item.errorMessage ? <p className="mt-2 text-xs text-red-500">{item.errorMessage}</p> : null}
    </Progress.Root>
  );
}

function UploadFolderTreeNode({
  folder,
  orgId,
  selectedNodeKey,
  openPrefixes,
  onOpenChange,
}: {
  folder: UploadTreeFolderNode;
  orgId: string;
  selectedNodeKey: string;
  openPrefixes: ReadonlySet<string>;
  onOpenChange: (prefix: string, open: boolean) => void;
}) {
  const isOpen = openPrefixes.has(folder.prefix);
  const isSelected = selectedNodeKey === `folder:${folder.prefix}`;
  const hasChildren = folder.folders.length > 0 || folder.files.length > 0;

  return (
    <Collapsible.Root open={isOpen} onOpenChange={(open) => onOpenChange(folder.prefix, open)}>
      <div className="space-y-1">
        <div className="flex items-center gap-2">
          {hasChildren ? (
            <Collapsible.Trigger
              aria-label={`${isOpen ? "Collapse" : "Expand"} ${folder.name}`}
              className="inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-sm border border-transparent bg-transparent text-[var(--bo-muted-2)] transition-colors hover:border-[color:var(--bo-border)] hover:bg-[var(--bo-panel)] hover:text-[var(--bo-fg)]"
            >
              <ChevronRight
                className={`h-3.5 w-3.5 transition-transform ${isOpen ? "rotate-90" : ""}`}
              />
            </Collapsible.Trigger>
          ) : (
            <span className="inline-flex h-7 w-7 shrink-0 items-center justify-center border border-transparent" />
          )}

          <Link
            to={buildSelectionHref(orgId, { kind: "folder", prefix: folder.prefix })}
            aria-current={isSelected ? "page" : undefined}
            className={
              isSelected
                ? "flex min-w-0 flex-1 items-center justify-between gap-3 rounded-sm border border-[color:var(--bo-border)] bg-[var(--bo-panel)] px-3 py-2 text-[var(--bo-fg)]"
                : "flex min-w-0 flex-1 items-center justify-between gap-3 rounded-sm border border-transparent bg-transparent px-3 py-2 text-[var(--bo-muted)] transition-colors hover:border-[color:var(--bo-border)] hover:bg-[var(--bo-panel)] hover:text-[var(--bo-fg)]"
            }
          >
            <span className="flex min-w-0 items-center gap-2">
              {isOpen ? (
                <FolderOpen className="h-4 w-4 shrink-0" />
              ) : (
                <Folder className="h-4 w-4 shrink-0" />
              )}
              <span className="truncate text-sm font-medium">{folder.name}</span>
            </span>

            <span className="text-current/70 shrink-0 text-[11px] uppercase tracking-[0.22em]">
              {folder.fileCount} files
            </span>
          </Link>
        </div>

        {hasChildren ? (
          <Collapsible.Panel keepMounted className="pl-5">
            <div className="space-y-1 border-l border-[color:var(--bo-border)] pl-4">
              {folder.folders.map((childFolder) => (
                <UploadFolderTreeNode
                  key={childFolder.prefix}
                  folder={childFolder}
                  orgId={orgId}
                  selectedNodeKey={selectedNodeKey}
                  openPrefixes={openPrefixes}
                  onOpenChange={onOpenChange}
                />
              ))}
              {folder.files.map((file) => (
                <UploadFileTreeLeaf
                  key={`${file.provider}:${file.fileKey}`}
                  file={file}
                  orgId={orgId}
                  selectedNodeKey={selectedNodeKey}
                />
              ))}
            </div>
          </Collapsible.Panel>
        ) : null}
      </div>
    </Collapsible.Root>
  );
}

function UploadFileTreeLeaf({
  file,
  orgId,
  selectedNodeKey,
}: {
  file: UploadFileRecord;
  orgId: string;
  selectedNodeKey: string;
}) {
  const isSelected = selectedNodeKey === `file:${file.provider}:${file.fileKey}`;
  const keyLeaf = getLeafLabel(file.fileKey);
  const showOriginalName = file.filename !== keyLeaf;

  return (
    <Link
      to={buildSelectionHref(orgId, {
        kind: "file",
        provider: file.provider,
        fileKey: file.fileKey,
      })}
      aria-current={isSelected ? "page" : undefined}
      className={
        isSelected
          ? "flex items-start justify-between gap-3 rounded-sm border border-[color:var(--bo-border)] bg-[var(--bo-panel)] px-3 py-2 text-[var(--bo-fg)]"
          : "flex items-start justify-between gap-3 rounded-sm border border-transparent bg-transparent px-3 py-2 text-[var(--bo-muted)] transition-colors hover:border-[color:var(--bo-border)] hover:bg-[var(--bo-panel)] hover:text-[var(--bo-fg)]"
      }
    >
      <span className="min-w-0">
        <span className="flex items-center gap-2">
          <FileIcon className="text-current/70 h-4 w-4 shrink-0" />
          <span className="truncate text-sm font-medium">{keyLeaf}</span>
        </span>
        <span className="text-current/70 mt-1 flex flex-wrap gap-2 text-[11px]">
          <span>{formatBytes(file.sizeBytes)}</span>
          {showOriginalName ? <span className="truncate">{file.filename}</span> : null}
        </span>
      </span>

      <span className="border-current/10 text-current/60 shrink-0 rounded-sm border bg-[var(--bo-panel-2)] px-2 py-1 text-[10px] uppercase tracking-[0.22em]">
        {file.provider}
      </span>
    </Link>
  );
}

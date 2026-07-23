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
  Suspense,
  use,
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type ChangeEvent,
  type DragEvent,
} from "react";
import {
  Form,
  Link,
  redirect,
  useActionData,
  useLoaderData,
  useNavigation,
  useNavigate,
  useOutletContext,
  type ActionFunctionArgs,
  type LoaderFunctionArgs,
} from "react-router";

import { Collapsible, Progress } from "@base-ui/react";
import { eq, useLiveQuery } from "@tanstack/react-db";

import { formatBytes } from "@/components/backoffice";
import { ClientOnly } from "@/components/client-only";
import { isUploadDirectoryMarker } from "@/files/contributors/upload-markers";
import {
  UPLOAD_PROVIDER_DATABASE,
  UPLOAD_PROVIDER_R2,
  UPLOAD_PROVIDER_R2_BINDING,
  type UploadAdminConfigResponse,
  type UploadProvider,
} from "@/fragno/upload";
import { createUploadClient } from "@/fragno/upload-client";
import { toUploadFileRecord, type UploadFileRecord } from "@/fragno/upload/file-record";
import {
  describeUploadCollectionSource,
  getUploadBrowserDatabase,
  type UploadCollectionSource,
} from "@/fragno/upload/tanstack/browser-database";

import { deleteUploadFile, fetchUploadConfig, fetchUploadDownloadUrl } from "./data";
import { formatUploadTimestamp } from "./formatting";
import type { UploadLayoutContext } from "./layout-context";
import { shouldAutoStartUploads } from "./upload-queue";

type ExplorerSelectionKind = "root" | "folder" | "file";

type FilesLoaderData = {
  configState: UploadAdminConfigResponse | null;
  configError: string | null;
  selectedFileProvider: string | null;
  selectedFileKey: string | null;
  selectedNodeKind: ExplorerSelectionKind;
  selectedPrefix: string;
};

type FilesActionIntent = "download-url" | "delete-file";

type FilesActionData = {
  ok: boolean;
  message: string;
  intent?: FilesActionIntent;
  provider?: string;
  fileKey?: string;
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
  targetProvider: string;
  targetPrefix: string;
  errorMessage?: string;
};

type UploadProviderTree = {
  provider: UploadProvider;
  label: string;
  root: UploadTreeFolderNode;
  foldersByPrefix: Map<string, UploadTreeFolderNode>;
  allFolderPrefixes: string[];
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

const SORT_COLLATOR = new Intl.Collator("en", { numeric: true, sensitivity: "base" });
const UPLOAD_PROVIDER_ORDER: readonly UploadProvider[] = [
  UPLOAD_PROVIDER_DATABASE,
  UPLOAD_PROVIDER_R2_BINDING,
  UPLOAD_PROVIDER_R2,
];

const toProviderLabel = (provider: string) => {
  if (provider === UPLOAD_PROVIDER_DATABASE) {
    return "Workspace";
  }
  if (provider === UPLOAD_PROVIDER_R2_BINDING) {
    return "R2";
  }
  if (provider === UPLOAD_PROVIDER_R2) {
    return "R2 remote";
  }
  return provider;
};

const getConfiguredUploadProviders = (
  configState: UploadAdminConfigResponse | null | undefined,
): UploadProvider[] =>
  UPLOAD_PROVIDER_ORDER.filter((provider) => configState?.providers[provider]?.configured);

const isConfiguredUploadProvider = (
  configState: UploadAdminConfigResponse | null | undefined,
  provider: string | null,
): provider is UploadProvider =>
  Boolean(provider && UPLOAD_PROVIDER_ORDER.includes(provider as UploadProvider)) &&
  Boolean(configState?.providers[provider as UploadProvider]?.configured);

const composeVirtualFolderKey = (provider: string, prefix: string) => `${provider}\u0000${prefix}`;
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

const handleDragOver = (event: DragEvent<HTMLDivElement>) => {
  if (!event.dataTransfer.types.includes("Files")) {
    return;
  }

  event.preventDefault();
  event.dataTransfer.dropEffect = "copy";
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
        provider?: string | null;
      }
    | {
        kind: "folder";
        provider: string;
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
    if (selection.provider) {
      searchParams.set("provider", selection.provider);
    }
  } else if (selection.kind === "folder") {
    searchParams.set("node", "folder");
    searchParams.set("provider", selection.provider);
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
      providers: [...providers].sort((left, right) => SORT_COLLATOR.compare(left, right)),
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

export async function loader({ params, context, url }: LoaderFunctionArgs) {
  if (!params.orgId) {
    throw new Response("Not Found", { status: 404 });
  }

  const { configState, configError } = await fetchUploadConfig(context, params.orgId);
  if (configError) {
    return {
      configState,
      configError,
      selectedFileProvider: null,
      selectedFileKey: null,
      selectedNodeKind: "root",
      selectedPrefix: "",
    } satisfies FilesLoaderData;
  }

  if (!configState?.configured) {
    return redirect(`/backoffice/connections/upload/${params.orgId}/configuration`);
  }

  let selectedNodeKind = parseSelectedNodeKind(url.searchParams.get("node"));
  let selectedPrefix = normalizeFolderPrefix(url.searchParams.get("prefix"));
  const requestedFileKey = url.searchParams.get("fileKey")?.trim() || null;
  const requestedProvider = url.searchParams.get("provider")?.trim() || null;
  const selectedProvider = isConfiguredUploadProvider(configState, requestedProvider)
    ? requestedProvider
    : null;

  if (selectedNodeKind === "folder" && (!selectedPrefix || !selectedProvider)) {
    selectedNodeKind = "root";
    selectedPrefix = "";
  }

  if (selectedNodeKind === "file" && !requestedFileKey) {
    selectedNodeKind = selectedProvider && selectedPrefix ? "folder" : "root";
  }

  return {
    configState,
    configError: null,
    selectedFileProvider: selectedProvider,
    selectedFileKey: selectedNodeKind === "file" ? requestedFileKey : null,
    selectedNodeKind,
    selectedPrefix:
      selectedNodeKind === "file" && requestedFileKey
        ? getParentPrefix(requestedFileKey)
        : selectedPrefix,
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

  if (intent === "download-url") {
    const result = await fetchUploadDownloadUrl(request, context, params.orgId, provider, fileKey);
    if (result.error || !result.result) {
      return {
        ok: false,
        message: result.error ?? "Unable to fetch download URL.",
      } satisfies FilesActionData;
    }

    return {
      ok: true,
      message: "Download URL generated.",
      intent: "download-url",
      provider,
      fileKey,
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
      intent: "delete-file",
      provider,
      fileKey,
      downloadUrl: null,
    } satisfies FilesActionData;
  }

  return {
    ok: false,
    message: "Unknown file action.",
  } satisfies FilesActionData;
}

const UPLOAD_FILES_LOADING = <UploadFilesLoading />;

export default function BackofficeOrganisationUploadFiles() {
  const layoutContext = useOutletContext<UploadLayoutContext>();

  if (!layoutContext.persistenceSource) {
    const message =
      layoutContext.configError ??
      layoutContext.persistenceError ??
      (layoutContext.configState?.configured
        ? "Local Upload file persistence is unavailable."
        : "Configure Upload before opening files.");

    return (
      <div className="border border-[color:var(--bo-border)] bg-[var(--bo-panel)] p-4 text-sm text-[var(--bo-muted)]">
        {message}
      </div>
    );
  }

  return (
    <ClientOnly fallback={UPLOAD_FILES_LOADING}>
      <Suspense fallback={UPLOAD_FILES_LOADING}>
        <SynchronizedUploadFiles
          key={describeUploadCollectionSource(layoutContext.persistenceSource).resourceKey}
          source={layoutContext.persistenceSource}
        />
      </Suspense>
    </ClientOnly>
  );
}

function UploadFilesLoading() {
  return (
    <div className="border border-[color:var(--bo-border)] bg-[var(--bo-panel)] p-4 text-sm text-[var(--bo-muted)]">
      Loading local Upload file metadata…
      <noscript>
        <span className="mt-2 block text-red-700 dark:text-red-200">
          JavaScript is required to open Upload files.
        </span>
      </noscript>
    </div>
  );
}

function SynchronizedUploadFiles({ source }: { source: UploadCollectionSource }) {
  const database = use(getUploadBrowserDatabase());
  const collections = database.collectionsFor(source);
  const filesQuery = useLiveQuery(
    (query) =>
      query.from({ file: collections.files }).where(({ file }) => eq(file.status, "ready")),
    [collections.files],
  );
  const files = useMemo<UploadFileRecord[]>(() => {
    const synchronizedFiles: UploadFileRecord[] = [];

    for (const file of filesQuery.data ?? []) {
      const synchronizedFile = toUploadFileRecord(file);
      if (!isUploadDirectoryMarker(synchronizedFile)) {
        synchronizedFiles.push(synchronizedFile);
      }
    }

    return synchronizedFiles;
  }, [filesQuery.data]);
  const sourceError = filesQuery.isError ? collections.files.utils.getLastError() : undefined;
  const filesError =
    sourceError instanceof Error
      ? sourceError.message
      : filesQuery.isError
        ? "Upload file metadata synchronization failed."
        : null;
  if (!filesQuery.isReady && files.length === 0) {
    return <UploadFilesLoading />;
  }

  return <UploadFilesView files={files} filesError={filesError} />;
}

function CreateFolderForm({
  parentPrefix,
  enabled,
  onCreate,
}: {
  parentPrefix: string;
  enabled: boolean;
  onCreate: (folderName: string) => string | null;
}) {
  const [folderName, setFolderName] = useState("");
  const [error, setError] = useState<string | null>(null);

  return (
    <form
      onSubmit={(event) => {
        event.preventDefault();
        const createError = onCreate(folderName);
        setError(createError);
        if (!createError) {
          setFolderName("");
        }
      }}
      className="border border-[color:var(--bo-border)] bg-[var(--bo-panel-2)] p-4"
    >
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <p className="text-[10px] tracking-[0.24em] text-[var(--bo-muted-2)] uppercase">
            Create folder
          </p>
          <p className="mt-2 text-sm text-[var(--bo-muted)]">
            Add a child folder under{" "}
            <span className="font-semibold text-[var(--bo-fg)]">
              {formatPrefixLabel(parentPrefix)}
            </span>
            . It stays local until a file is uploaded into it.
          </p>
        </div>
      </div>

      <div className="mt-4 flex flex-col gap-3 sm:flex-row">
        <input
          type="text"
          value={folderName}
          onChange={(event) => {
            setFolderName(event.target.value);
            setError(null);
          }}
          placeholder={parentPrefix ? "nested/reports" : "assets/images"}
          className="min-w-0 flex-1 rounded-sm border border-[color:var(--bo-border)] bg-[var(--bo-panel)] px-3 py-2 text-sm text-[var(--bo-fg)] transition-colors outline-none placeholder:text-[var(--bo-muted-2)] focus:border-[color:var(--bo-accent)]"
        />
        <button
          type="submit"
          disabled={!enabled || !folderName.trim()}
          className="inline-flex items-center justify-center gap-2 rounded-sm border border-[color:var(--bo-border)] bg-[var(--bo-panel)] px-3 py-2 text-[10px] font-semibold tracking-[0.22em] text-[var(--bo-muted)] uppercase transition-colors hover:border-[color:var(--bo-border-strong)] hover:text-[var(--bo-fg)] disabled:opacity-60"
        >
          <Folder className="h-3.5 w-3.5" />
          Create folder
        </button>
      </div>

      {error ? (
        <p className="mt-3 text-xs text-red-500">{error}</p>
      ) : (
        <p className="mt-3 text-xs text-[var(--bo-muted-2)]">
          Use slash-delimited names like `reports/2026/march`.
        </p>
      )}
    </form>
  );
}

function UploadFilesView({
  files,
  filesError,
}: {
  files: UploadFileRecord[];
  filesError: string | null;
}) {
  const {
    configState,
    configError,
    selectedFileProvider,
    selectedFileKey,
    selectedNodeKind,
    selectedPrefix,
  } = useLoaderData<typeof loader>();
  const actionData = useActionData<typeof action>();
  const navigation = useNavigation();
  const navigate = useNavigate();
  const { orgId } = useOutletContext<UploadLayoutContext>();
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
  const fileInputRef = useRef<HTMLInputElement>(null);
  const fileInputId = useId();

  const actionError = actionData && !actionData.ok ? actionData.message : null;
  const actionSuccess = actionData?.ok ? actionData.message : null;
  const deletedByAction =
    actionData?.ok === true &&
    actionData.intent === "delete-file" &&
    actionData.fileKey === selectedFileKey &&
    (!selectedFileProvider || actionData.provider === selectedFileProvider);
  const selectedFile = deletedByAction
    ? null
    : (files.find(
        (file) =>
          file.fileKey === selectedFileKey &&
          (!selectedFileProvider || file.provider === selectedFileProvider),
      ) ?? null);
  const selectedProvider = selectedFile?.provider ?? selectedFileProvider ?? null;
  const supportsSignedDownload = selectedProvider === UPLOAD_PROVIDER_R2;
  const configuredProviders = useMemo(
    () => getConfiguredUploadProviders(configState),
    [configState],
  );
  const actionBusy = navigation.state === "submitting";
  const selectedExplorerPrefix =
    selectedNodeKind === "file"
      ? getParentPrefix(selectedFile?.fileKey ?? selectedFileKey ?? "")
      : selectedPrefix;
  const extraFolderPrefixes = useMemo(() => {
    if (!selectedProvider) {
      return [];
    }

    const prefixes = new Set<string>();
    for (const key of virtualFolders) {
      const [provider, prefix] = key.split("\u0000", 2);
      if (provider === selectedProvider && prefix) {
        prefixes.add(prefix);
      }
    }
    if (selectedExplorerPrefix) {
      prefixes.add(selectedExplorerPrefix);
    }

    return [...prefixes].sort((left, right) => SORT_COLLATOR.compare(left, right));
  }, [selectedExplorerPrefix, selectedProvider, virtualFolders]);
  const providerTrees = useMemo<UploadProviderTree[]>(
    () =>
      configuredProviders.map((provider) => {
        const tree = buildUploadFileTree(
          files.filter((file) => file.provider === provider),
          provider === selectedProvider ? extraFolderPrefixes : [],
        );
        return {
          provider,
          label: toProviderLabel(provider),
          ...tree,
        };
      }),
    [configuredProviders, extraFolderPrefixes, files, selectedProvider],
  );
  const selectedProviderTree = providerTrees.find((tree) => tree.provider === selectedProvider);
  const allFolderPrefixes = providerTrees.flatMap((tree) =>
    tree.allFolderPrefixes.map((prefix) => composeVirtualFolderKey(tree.provider, prefix)),
  );
  const [openFolders, setOpenFolders] = useState<Set<string>>(() => new Set(allFolderPrefixes));
  const knownFolderPrefixesRef = useRef<Set<string>>(new Set(allFolderPrefixes));
  const selectedNodeKey =
    selectedNodeKind === "file" && selectedFileKey
      ? `file:${selectedProvider ?? "unknown"}:${selectedFileKey}`
      : selectedNodeKind === "folder" && selectedProvider
        ? `folder:${selectedProvider}:${selectedPrefix}`
        : selectedNodeKind === "root" && selectedProvider
          ? `root:${selectedProvider}`
          : "root";
  const selectedFolderNode =
    selectedNodeKind === "root" && selectedProvider
      ? (selectedProviderTree?.root ?? null)
      : selectedNodeKind === "folder" && selectedProvider
        ? (selectedProviderTree?.foldersByPrefix.get(selectedPrefix) ??
          createSyntheticFolderNode(selectedPrefix))
        : null;
  const uploadTargetProvider = selectedNodeKind === "file" ? null : selectedProvider;
  const uploadTargetPrefix =
    uploadTargetProvider && selectedNodeKind === "root"
      ? ""
      : uploadTargetProvider && selectedNodeKind === "folder"
        ? selectedPrefix
        : null;
  const folderQueue =
    uploadTargetProvider === null || uploadTargetPrefix === null
      ? []
      : uploadQueue.filter(
          (item) =>
            item.targetProvider === uploadTargetProvider &&
            item.targetPrefix === uploadTargetPrefix,
        );
  const hasFailedUploads = folderQueue.some((item) => item.status === "failed");
  const hasFinishedUploads = folderQueue.some(
    (item) => item.status === "completed" || item.status === "failed",
  );
  const nextQueuedUpload = uploadQueue.find((item) => item.status === "queued") ?? null;
  const pendingUploadsElsewhere =
    uploadTargetProvider === null || uploadTargetPrefix === null
      ? 0
      : uploadQueue.filter(
          (item) =>
            (item.targetProvider !== uploadTargetProvider ||
              item.targetPrefix !== uploadTargetPrefix) &&
            (item.status === "queued" || item.status === "uploading" || item.status === "failed"),
        ).length;
  const downloadUrl =
    actionData?.downloadUrl &&
    selectedFile &&
    actionData.fileKey === selectedFile.fileKey &&
    actionData.provider === selectedFile.provider
      ? actionData.downloadUrl
      : null;
  const missingFileParentHref = buildSelectionHref(
    orgId,
    selectedProvider && selectedPrefix
      ? { kind: "folder", provider: selectedProvider, prefix: selectedPrefix }
      : { kind: "root", provider: selectedProvider },
  );
  const isDragActive = dragDepth > 0;

  const startUploads = useCallback(
    async (
      targetProvider: string,
      targetPrefix: string,
      options: { includeFailed?: boolean } = {},
    ) => {
      if (uploadingFiles) {
        return;
      }

      const includeFailed = options.includeFailed ?? true;
      const candidates = uploadQueue.filter(
        (item) =>
          item.targetProvider === targetProvider &&
          item.targetPrefix === targetPrefix &&
          (item.status === "queued" || (includeFailed && item.status === "failed")),
      );
      if (candidates.length === 0) {
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
              provider: item.targetProvider,
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
      }
    },
    [uploadHelpers, uploadingFiles, uploadQueue],
  );

  useEffect(() => {
    setOpenFolders((previous) => {
      const next = new Set(previous);

      if (selectedProvider) {
        for (const prefix of getAncestorPrefixes(selectedPrefix)) {
          next.add(composeVirtualFolderKey(selectedProvider, prefix));
        }
      }

      return next;
    });
  }, [selectedPrefix, selectedProvider]);

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
    setDragDepth(0);
  }, [selectedNodeKind, selectedPrefix, selectedFileKey, selectedFileProvider]);

  useEffect(() => {
    if (
      !shouldAutoStartUploads({
        uploadingFiles,
        defaultProvider: nextQueuedUpload?.targetProvider,
        nextQueuedUploadPrefix: nextQueuedUpload?.targetPrefix ?? null,
      }) ||
      !nextQueuedUpload
    ) {
      return;
    }

    void startUploads(nextQueuedUpload.targetProvider, nextQueuedUpload.targetPrefix, {
      includeFailed: false,
    });
  }, [nextQueuedUpload, startUploads, uploadingFiles]);

  if (configError) {
    return (
      <div className="border border-red-200 bg-red-50 p-4 text-sm text-red-600">{configError}</div>
    );
  }

  const queueFilesForPrefix = (
    incomingFiles: File[],
    targetProvider: string,
    targetPrefix: string,
  ) => {
    if (incomingFiles.length === 0) {
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
        targetProvider,
        targetPrefix,
      })),
    ]);
  };

  const handleBrowseSelection = (event: ChangeEvent<HTMLInputElement>) => {
    if (!uploadTargetProvider || uploadTargetPrefix === null) {
      return;
    }

    queueFilesForPrefix(
      Array.from(event.target.files ?? []),
      uploadTargetProvider,
      uploadTargetPrefix,
    );
    event.target.value = "";
  };

  const handleDropFiles = (event: DragEvent<HTMLDivElement>) => {
    if (!uploadTargetProvider || uploadTargetPrefix === null) {
      return;
    }

    event.preventDefault();
    setDragDepth(0);
    queueFilesForPrefix(
      Array.from(event.dataTransfer.files ?? []),
      uploadTargetProvider,
      uploadTargetPrefix,
    );
  };

  const handleDragEnter = (event: DragEvent<HTMLDivElement>) => {
    if (!event.dataTransfer.types.includes("Files")) {
      return;
    }

    event.preventDefault();
    setDragDepth((current) => current + 1);
  };

  const handleDragLeave = (event: DragEvent<HTMLDivElement>) => {
    if (!event.dataTransfer.types.includes("Files")) {
      return;
    }

    event.preventDefault();
    setDragDepth((current) => Math.max(0, current - 1));
  };

  const clearFinishedUploads = (targetProvider: string, targetPrefix: string) => {
    setUploadQueue((previous) =>
      previous.filter(
        (item) =>
          item.targetProvider !== targetProvider ||
          item.targetPrefix !== targetPrefix ||
          (item.status !== "completed" && item.status !== "failed"),
      ),
    );
  };

  const createFolder = (folderName: string): string | null => {
    if (!uploadTargetProvider || uploadTargetPrefix === null) {
      return "Select a writable folder before creating a child folder.";
    }

    const result = resolveFolderPrefix(uploadTargetPrefix, folderName);
    if (!result.prefix) {
      return result.error;
    }
    const nextPrefix = result.prefix;

    if (!selectedProviderTree?.foldersByPrefix.has(nextPrefix)) {
      setVirtualFolders((previous) => {
        const virtualFolderKey = composeVirtualFolderKey(uploadTargetProvider, nextPrefix);
        if (previous.has(virtualFolderKey)) {
          return previous;
        }

        const next = new Set(previous);
        next.add(virtualFolderKey);
        return next;
      });
    }

    void navigate(
      buildSelectionHref(orgId, {
        kind: "folder",
        provider: uploadTargetProvider,
        prefix: nextPrefix,
      }),
    );
    return null;
  };

  const setFolderOpen = (provider: string, prefix: string, open: boolean) => {
    setOpenFolders((previous) => {
      const next = new Set(previous);
      const key = composeVirtualFolderKey(provider, prefix);

      if (open) {
        next.add(key);
      } else {
        next.delete(key);
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
      {actionError ? <p className="text-xs text-red-500">{actionError}</p> : null}
      {actionSuccess ? <p className="text-xs text-green-500">{actionSuccess}</p> : null}
      {uploadError ? <p className="text-xs text-red-500">{uploadError}</p> : null}
      {downloadError ? <p className="text-xs text-red-500">{downloadError}</p> : null}

      <section className="grid gap-4 lg:grid-cols-[minmax(18rem,0.92fr)_minmax(24rem,1.08fr)]">
        <div className="border border-[color:var(--bo-border)] bg-[var(--bo-panel)] p-4">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div>
              <p className="text-[10px] tracking-[0.24em] text-[var(--bo-muted-2)] uppercase">
                Explorer
              </p>
              <p className="mt-2 text-sm text-[var(--bo-muted)]">
                Browse the stored key hierarchy. Select a folder to upload into it or a file to
                inspect it.
              </p>
            </div>

            <span className="border border-[color:var(--bo-border)] bg-[var(--bo-panel-2)] px-2 py-1 text-[10px] tracking-[0.22em] text-[var(--bo-muted)] uppercase">
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
                <span className="truncate text-sm font-semibold">Upload roots</span>
              </span>
              <span className="shrink-0 text-[11px] tracking-[0.22em] text-current/70 uppercase">
                {files.length} files
              </span>
            </Link>

            {providerTrees.length === 0 ? (
              <p className="mt-4 text-sm text-[var(--bo-muted)]">
                No upload providers are configured yet.
              </p>
            ) : (
              <div className="mt-3 space-y-2">
                {providerTrees.map((providerTree) => (
                  <UploadProviderRootTree
                    key={providerTree.provider}
                    providerTree={providerTree}
                    orgId={orgId}
                    selectedNodeKey={selectedNodeKey}
                    openPrefixes={openFolders}
                    onOpenChange={setFolderOpen}
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
                      <p className="text-[10px] tracking-[0.24em] text-[var(--bo-muted-2)] uppercase">
                        File detail
                      </p>
                      <p className="mt-2 text-lg font-semibold text-[var(--bo-fg)]">
                        {selectedFile.filename}
                      </p>
                      <p className="mt-1 text-xs break-all text-[var(--bo-muted)]">
                        {selectedFile.fileKey}
                      </p>
                    </div>

                    <Link
                      to={missingFileParentHref}
                      className="border border-[color:var(--bo-border)] bg-[var(--bo-panel)] px-3 py-2 text-[10px] font-semibold tracking-[0.22em] text-[var(--bo-muted)] uppercase transition-colors hover:border-[color:var(--bo-border-strong)] hover:text-[var(--bo-fg)]"
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
                      value={formatUploadTimestamp(selectedFile.createdAt) || "Unknown"}
                    />
                    <DetailStat
                      label="Updated"
                      value={formatUploadTimestamp(selectedFile.updatedAt) || "Unknown"}
                    />
                  </div>
                </div>

                {downloadUrl ? (
                  <div className="border border-[color:var(--bo-border)] bg-[var(--bo-panel-2)] p-3 text-sm text-[var(--bo-muted)]">
                    <p className="text-[10px] tracking-[0.22em] text-[var(--bo-muted-2)] uppercase">
                      Download URL
                    </p>
                    <p className="mt-2 break-all text-[var(--bo-fg)]">{downloadUrl.url}</p>
                    <p className="mt-1 text-xs text-[var(--bo-muted-2)]">
                      Expires: {formatUploadTimestamp(downloadUrl.expiresAt)}
                    </p>
                  </div>
                ) : null}

                <div className="grid gap-2">
                  {supportsSignedDownload ? (
                    <Form method="post">
                      <input type="hidden" name="intent" value="download-url" />
                      <input type="hidden" name="provider" value={selectedFile.provider} />
                      <input type="hidden" name="fileKey" value={selectedFile.fileKey} />
                      <button
                        type="submit"
                        disabled={actionBusy}
                        className="inline-flex w-full items-center justify-center gap-2 border border-[color:var(--bo-border)] bg-[var(--bo-panel-2)] px-3 py-2 text-[11px] font-semibold tracking-[0.22em] text-[var(--bo-muted)] uppercase transition-colors hover:border-[color:var(--bo-border-strong)] hover:text-[var(--bo-fg)] disabled:opacity-60"
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
                      className="inline-flex w-full items-center justify-center gap-2 border border-[color:var(--bo-border)] bg-[var(--bo-panel-2)] px-3 py-2 text-[11px] font-semibold tracking-[0.22em] text-[var(--bo-muted)] uppercase transition-colors hover:border-[color:var(--bo-border-strong)] hover:text-[var(--bo-fg)] disabled:opacity-60"
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
                      className="inline-flex w-full items-center justify-center gap-2 border border-red-300 bg-red-50 px-3 py-2 text-[11px] font-semibold tracking-[0.22em] text-red-600 uppercase transition-colors hover:border-red-400 disabled:opacity-60"
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
                  <p className="text-[10px] tracking-[0.24em] text-[var(--bo-muted-2)] uppercase">
                    File detail
                  </p>
                  <p className="mt-2 text-sm text-[var(--bo-muted)]">
                    The selected file is no longer available. Open its containing folder to upload a
                    replacement or inspect nearby files.
                  </p>
                  <div className="mt-4">
                    <Link
                      to={missingFileParentHref}
                      className="inline-flex items-center gap-2 border border-[color:var(--bo-border)] bg-[var(--bo-panel)] px-3 py-2 text-[10px] font-semibold tracking-[0.22em] text-[var(--bo-muted)] uppercase transition-colors hover:border-[color:var(--bo-border-strong)] hover:text-[var(--bo-fg)]"
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
                    <p className="text-[10px] tracking-[0.24em] text-[var(--bo-muted-2)] uppercase">
                      Upload target
                    </p>
                    <p className="mt-2 text-lg font-semibold text-[var(--bo-fg)]">
                      {selectedNodeKind === "root"
                        ? "Root"
                        : (selectedFolderNode?.name ??
                          getLeafLabel(stripTrailingSlash(selectedPrefix)))}
                    </p>
                    <p className="mt-1 text-xs text-[var(--bo-muted)]">
                      {uploadTargetProvider ? (
                        <>
                          Uploads land under{" "}
                          <span className="font-semibold text-[var(--bo-fg)]">
                            {formatPrefixLabel(uploadTargetPrefix ?? "")}
                          </span>{" "}
                          using readable collision-safe keys.
                        </>
                      ) : (
                        "Select a configured upload root to browse, create folders, or upload files."
                      )}
                    </p>
                  </div>

                  <span className="border border-[color:var(--bo-border)] bg-[var(--bo-panel)] px-2 py-1 text-[10px] tracking-[0.22em] text-[var(--bo-muted)] uppercase">
                    Uploads via:{" "}
                    {selectedProvider ? toProviderLabel(selectedProvider) : "select a root"}
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
                        className="border border-[color:var(--bo-border)] bg-[var(--bo-panel)] px-2 py-1 text-[10px] tracking-[0.22em] text-[var(--bo-muted)] uppercase"
                      >
                        {provider}
                      </span>
                    ))}
                  </div>
                ) : null}
              </div>

              <CreateFolderForm
                key={`${uploadTargetProvider ?? "none"}:${uploadTargetPrefix ?? "none"}`}
                parentPrefix={uploadTargetPrefix ?? ""}
                enabled={Boolean(uploadTargetProvider)}
                onCreate={createFolder}
              />

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
                    <p className="text-[10px] tracking-[0.24em] text-[var(--bo-muted-2)] uppercase">
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
                      disabled={!uploadTargetProvider}
                      className="inline-flex items-center gap-2 border border-[color:var(--bo-border)] bg-[var(--bo-panel)] px-3 py-2 text-[10px] font-semibold tracking-[0.22em] text-[var(--bo-muted)] uppercase transition-colors hover:border-[color:var(--bo-border-strong)] hover:text-[var(--bo-fg)]"
                    >
                      <Upload className="h-3.5 w-3.5" />
                      Choose files
                    </button>
                    {hasFailedUploads ? (
                      <button
                        type="button"
                        onClick={() => {
                          if (uploadTargetProvider && uploadTargetPrefix !== null) {
                            void startUploads(uploadTargetProvider, uploadTargetPrefix);
                          }
                        }}
                        disabled={
                          uploadingFiles || !uploadTargetProvider || uploadTargetPrefix === null
                        }
                        className="inline-flex items-center gap-2 border border-[color:var(--bo-accent)] bg-[var(--bo-accent-bg)] px-3 py-2 text-[10px] font-semibold tracking-[0.22em] text-[var(--bo-accent-fg)] uppercase transition-colors hover:border-[color:var(--bo-accent-strong)] disabled:opacity-60"
                      >
                        <RefreshCcw className="h-3.5 w-3.5" />
                        {uploadingFiles && activeUploadPrefix === uploadTargetPrefix
                          ? "Uploading…"
                          : "Retry failed"}
                      </button>
                    ) : null}
                    <button
                      type="button"
                      onClick={() => {
                        if (uploadTargetProvider && uploadTargetPrefix !== null) {
                          clearFinishedUploads(uploadTargetProvider, uploadTargetPrefix);
                        }
                      }}
                      disabled={
                        !hasFinishedUploads ||
                        uploadingFiles ||
                        !uploadTargetProvider ||
                        uploadTargetPrefix === null
                      }
                      className="inline-flex items-center gap-2 border border-[color:var(--bo-border)] bg-[var(--bo-panel)] px-3 py-2 text-[10px] font-semibold tracking-[0.22em] text-[var(--bo-muted)] uppercase transition-colors hover:border-[color:var(--bo-border-strong)] hover:text-[var(--bo-fg)] disabled:opacity-60"
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
      <p className="text-[10px] tracking-[0.22em] text-[var(--bo-muted-2)] uppercase">{label}</p>
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

function UploadProviderRootTree({
  providerTree,
  orgId,
  selectedNodeKey,
  openPrefixes,
  onOpenChange,
}: {
  providerTree: UploadProviderTree;
  orgId: string;
  selectedNodeKey: string;
  openPrefixes: ReadonlySet<string>;
  onOpenChange: (provider: string, prefix: string, open: boolean) => void;
}) {
  const root = providerTree.root;
  const isSelected = selectedNodeKey === `root:${providerTree.provider}`;

  return (
    <div className="space-y-1">
      <Link
        to={buildSelectionHref(orgId, { kind: "root", provider: providerTree.provider })}
        aria-current={isSelected ? "page" : undefined}
        className={
          isSelected
            ? "flex min-w-0 items-center justify-between gap-3 rounded-sm border border-[color:var(--bo-border)] bg-[var(--bo-panel)] px-3 py-2 text-[var(--bo-fg)]"
            : "flex min-w-0 items-center justify-between gap-3 rounded-sm border border-transparent bg-transparent px-3 py-2 text-[var(--bo-muted)] transition-colors hover:border-[color:var(--bo-border)] hover:bg-[var(--bo-panel)] hover:text-[var(--bo-fg)]"
        }
      >
        <span className="flex min-w-0 items-center gap-2">
          <FolderOpen className="h-4 w-4 shrink-0" />
          <span className="truncate text-sm font-semibold">{providerTree.label}</span>
        </span>
        <span className="shrink-0 text-[11px] tracking-[0.22em] text-current/70 uppercase">
          {root.fileCount} files
        </span>
      </Link>

      {root.folders.length === 0 && root.files.length === 0 ? (
        <p className="px-3 py-2 text-xs text-[var(--bo-muted-2)]">No files in this root yet.</p>
      ) : (
        <div className="space-y-1 border-l border-[color:var(--bo-border)] pl-4">
          {root.folders.map((folder) => (
            <UploadFolderTreeNode
              key={`${providerTree.provider}:${folder.prefix}`}
              provider={providerTree.provider}
              folder={folder}
              orgId={orgId}
              selectedNodeKey={selectedNodeKey}
              openPrefixes={openPrefixes}
              onOpenChange={onOpenChange}
            />
          ))}
          {root.files.map((file) => (
            <UploadFileTreeLeaf
              key={`${file.provider}:${file.fileKey}`}
              file={file}
              orgId={orgId}
              selectedNodeKey={selectedNodeKey}
            />
          ))}
        </div>
      )}
    </div>
  );
}

function UploadFolderTreeNode({
  provider,
  folder,
  orgId,
  selectedNodeKey,
  openPrefixes,
  onOpenChange,
}: {
  provider: string;
  folder: UploadTreeFolderNode;
  orgId: string;
  selectedNodeKey: string;
  openPrefixes: ReadonlySet<string>;
  onOpenChange: (provider: string, prefix: string, open: boolean) => void;
}) {
  const isOpen = openPrefixes.has(composeVirtualFolderKey(provider, folder.prefix));
  const isSelected = selectedNodeKey === `folder:${provider}:${folder.prefix}`;
  const hasChildren = folder.folders.length > 0 || folder.files.length > 0;

  return (
    <Collapsible.Root
      open={isOpen}
      onOpenChange={(open) => {
        onOpenChange(provider, folder.prefix, open);
      }}
    >
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
            to={buildSelectionHref(orgId, { kind: "folder", provider, prefix: folder.prefix })}
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

            <span className="shrink-0 text-[11px] tracking-[0.22em] text-current/70 uppercase">
              {folder.fileCount} files
            </span>
          </Link>
        </div>

        {hasChildren ? (
          <Collapsible.Panel keepMounted className="pl-5">
            <div className="space-y-1 border-l border-[color:var(--bo-border)] pl-4">
              {folder.folders.map((childFolder) => (
                <UploadFolderTreeNode
                  key={`${provider}:${childFolder.prefix}`}
                  provider={provider}
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
          <FileIcon className="h-4 w-4 shrink-0 text-current/70" />
          <span className="truncate text-sm font-medium">{keyLeaf}</span>
        </span>
        <span className="mt-1 flex flex-wrap gap-2 text-[11px] text-current/70">
          <span>{formatBytes(file.sizeBytes)}</span>
          {showOriginalName ? <span className="truncate">{file.filename}</span> : null}
        </span>
      </span>

      <span className="shrink-0 rounded-sm border border-current/10 bg-[var(--bo-panel-2)] px-2 py-1 text-[10px] tracking-[0.22em] text-current/60 uppercase">
        {file.provider}
      </span>
    </Link>
  );
}

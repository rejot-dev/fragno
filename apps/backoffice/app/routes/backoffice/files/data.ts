import type { RouterContextProvider } from "react-router";

import type { BackofficeContextScope } from "@/backoffice-runtime/context";
import { isBackofficeRoutableScope } from "@/backoffice-runtime/scope-codec";
import type {
  FilesExplorerSelectedContent,
  FilesExplorerSource,
} from "@/components/backoffice/files-explorer";
import type { FilesExplorerSearchGroup } from "@/components/backoffice/files-explorer/view";
import type { FileTreeEntry } from "@/file-collection/file-collection";
import { getAuthMe } from "@/fragno/auth/auth-server";
import type { UploadCollectionSource } from "@/fragno/upload/tanstack/browser-database";
import { fetchUploadAdapterIdentity } from "@/fragno/upload/tanstack/server";

import { buildBackofficeLoginPath } from "../auth-navigation";
import { fetchAutomationProjects } from "../automations/data.server";
import {
  automationScopeFromRouteParams,
  resolveAutomationUiScope,
  toBackofficeScope,
} from "../automations/scope";
import {
  createFilesOverviewCollections,
  type FilesOverviewCollection,
} from "./file-collections.server";

const FILES_EXPLORER_ROOT_ORDER = ["/workspace", "/static", "/system"] as const;
const FILES_EXPLORER_DEFAULT_PATH = "/workspace";
const FILES_EXPLORER_MAX_TEXT_PREVIEW_BYTES = 1024 * 1024;

export type FilesExplorerSourceSnapshot = FilesExplorerSource & {
  synchronization?: {
    kind: "upload";
    provider: string;
    source: UploadCollectionSource;
  };
};

type FilesExplorerLoaderData = {
  sources: FilesExplorerSourceSnapshot[];
  selectedPath: string | null;
  selectedContent: FilesExplorerSelectedContent | null;
  loadError: string | null;
  searchQuery: string;
  searchGroups: FilesExplorerSearchGroup[];
};

export async function resolveAuthorizedFilesRouteScope({
  request,
  context,
  params,
  url,
}: {
  request: Request;
  context: Readonly<RouterContextProvider>;
  params: { scopeKind?: string; scopeId?: string };
  url: URL;
}): Promise<BackofficeContextScope | Response> {
  const returnTo = `${url.pathname}${url.search}`;
  const me = await getAuthMe(request, context);
  if (!me?.user) {
    return Response.redirect(new URL(buildBackofficeLoginPath(returnTo), request.url), 302);
  }

  const parsedScope = automationScopeFromRouteParams(params);
  const projectsResult =
    parsedScope.kind === "project"
      ? await fetchAutomationProjects(context, parsedScope.orgId)
      : { projects: [], projectsError: null };
  if (projectsResult.projectsError) {
    throw new Response(projectsResult.projectsError, { status: 502 });
  }

  return toBackofficeScope(
    resolveAutomationUiScope({
      params,
      organisations: me.organizations.map((entry) => entry.organization),
      projects: projectsResult.projects,
      user: me.user,
    }),
  );
}

export async function loadFilesExplorerData({
  request,
  context,
  scope,
  requestedPath: routeRequestedPath,
}: {
  request: Request;
  context: Readonly<RouterContextProvider>;
  scope: BackofficeContextScope;
  requestedPath?: string | null;
}): Promise<FilesExplorerLoaderData> {
  const registrations = await createFilesOverviewCollections({ request, context, scope });
  const loadedCollections = await loadCollectionSources(registrations);
  const requestedPath = routeRequestedPath?.trim() || null;
  const searchQuery = new URL(request.url).searchParams.get("q")?.trim() ?? "";
  const defaultPath =
    loadedCollections.collections.find(
      ({ source }) => source.rootPath === FILES_EXPLORER_DEFAULT_PATH,
    )?.source.rootPath ??
    loadedCollections.collections[0]?.source.rootPath ??
    null;
  let selectedPath = requestedPath ?? defaultPath;
  let loadError = loadedCollections.errors.length > 0 ? loadedCollections.errors.join(" ") : null;
  const synchronizedSources = await attachClientSynchronization({
    request,
    context,
    scope,
    collections: loadedCollections.collections,
  });
  loadError = appendOptionalLoadError(loadError, synchronizedSources.error);
  let selection = selectedPath
    ? findCollectionSelection(loadedCollections.collections, selectedPath)
    : null;
  if (selection) {
    selectedPath = canonicalSelectionPath(selection);
  }

  if (
    selectedPath &&
    !selection &&
    !findSynchronizedSourceForPath(synchronizedSources.sources, selectedPath)
  ) {
    loadError = appendLoadError(loadError, `Path '${selectedPath}' could not be found.`);
    selectedPath = defaultPath;
    selection = selectedPath
      ? findCollectionSelection(loadedCollections.collections, selectedPath)
      : null;
  }

  const search = searchQuery
    ? await searchCollectionSources(loadedCollections.collections, searchQuery)
    : { groups: [], errors: [] };
  if (search.errors.length > 0) {
    loadError = appendLoadError(loadError, search.errors.join(" "));
  }

  return {
    sources: orderExplorerSources(synchronizedSources.sources),
    selectedPath,
    selectedContent: selection ? await readSelectedTextContent(selection) : null,
    loadError,
    searchQuery,
    searchGroups: search.groups,
  };
}

async function searchCollectionSources(
  collections: readonly LoadedCollection[],
  query: string,
): Promise<{ groups: FilesExplorerSearchGroup[]; errors: string[] }> {
  const results = await Promise.allSettled(
    collections.map(
      async ({ registration, source }): Promise<FilesExplorerSearchGroup> => ({
        rootPath: source.rootPath,
        rootTitle: source.rootTitle,
        matches: (
          await registration.collection.search(query, {
            contextBefore: 1,
            contextAfter: 1,
            maxMatches: 50,
          })
        ).map((match) => ({
          ...match,
          path: `${source.rootPath}/${match.path}`,
        })),
      }),
    ),
  );
  const groups: FilesExplorerSearchGroup[] = [];
  const errors: string[] = [];

  results.forEach((result, index) => {
    if (result.status === "fulfilled") {
      groups.push(result.value);
      return;
    }

    const title = collections[index]?.source.rootTitle ?? "File collection";
    const message = result.reason instanceof Error ? result.reason.message : "Unknown error.";
    errors.push(`${title} could not be searched: ${message}`);
  });

  return { groups, errors };
}

type LoadedCollection = {
  registration: FilesOverviewCollection;
  source: FilesExplorerSource;
};

async function loadCollectionSources(registrations: readonly FilesOverviewCollection[]): Promise<{
  collections: LoadedCollection[];
  errors: string[];
}> {
  const results = await Promise.allSettled(
    registrations.map(async (registration): Promise<LoadedCollection> => {
      const tree = await registration.collection.getTree();
      return {
        registration,
        source: createExplorerSource(registration, tree),
      };
    }),
  );
  const collections: LoadedCollection[] = [];
  const errors: string[] = [];

  results.forEach((result, index) => {
    if (result.status === "fulfilled") {
      collections.push(result.value);
      return;
    }

    const registration = registrations[index];
    const title = registration?.rootTitle ?? "File collection";
    const message = result.reason instanceof Error ? result.reason.message : "Unknown error.";
    errors.push(`${title} could not be loaded: ${message}`);

    if (registration?.clientSynchronization) {
      collections.push({
        registration,
        source: createExplorerSource(registration, { entries: [] }),
      });
    }
  });

  return { collections, errors };
}

function createExplorerSource(
  registration: FilesOverviewCollection,
  tree: FilesExplorerSource["tree"],
): FilesExplorerSource {
  return {
    tree,
    rootPath: registration.rootPath,
    rootTitle: registration.rootTitle,
    ...(registration.rootDescription ? { rootDescription: registration.rootDescription } : {}),
    ...(registration.rootKind ? { rootKind: registration.rootKind } : {}),
    ...(registration.readOnly !== undefined ? { readOnly: registration.readOnly } : {}),
    ...(registration.persistence ? { persistence: registration.persistence } : {}),
    ...(registration.detailFields ? { detailFields: registration.detailFields } : {}),
  };
}

async function attachClientSynchronization({
  request,
  context,
  scope,
  collections,
}: {
  request: Request;
  context: Readonly<RouterContextProvider>;
  scope: BackofficeContextScope;
  collections: readonly LoadedCollection[];
}): Promise<{ sources: FilesExplorerSourceSnapshot[]; error: string | null }> {
  const hasUploadSynchronization = collections.some(
    ({ registration }) => registration.clientSynchronization?.kind === "upload",
  );
  if (!hasUploadSynchronization || !isBackofficeRoutableScope(scope)) {
    return { sources: collections.map(({ source }) => source), error: null };
  }

  try {
    const source = {
      scope,
      adapterIdentity: await fetchUploadAdapterIdentity(request, context, scope),
    } satisfies UploadCollectionSource;

    return {
      sources: collections.map(({ registration, source: fileSource }) => {
        const synchronization = registration.clientSynchronization;
        return synchronization?.kind === "upload"
          ? {
              ...fileSource,
              synchronization: {
                kind: "upload" as const,
                provider: synchronization.provider,
                source,
              },
            }
          : fileSource;
      }),
      error: null,
    };
  } catch (error) {
    return {
      sources: collections.map(({ source }) => source),
      error:
        error instanceof Error
          ? `Workspace local synchronization is unavailable: ${error.message}`
          : "Workspace local synchronization is unavailable.",
    };
  }
}

function findSynchronizedSourceForPath(
  sources: readonly FilesExplorerSourceSnapshot[],
  path: string,
): FilesExplorerSourceSnapshot | null {
  return (
    sources.find(
      (source) =>
        source.synchronization !== undefined &&
        (path === source.rootPath || path.startsWith(`${source.rootPath}/`)),
    ) ?? null
  );
}

type CollectionSelection = LoadedCollection & {
  relativePath: string;
  entry: FileTreeEntry | null;
};

function findCollectionSelection(
  collections: readonly LoadedCollection[],
  selectedPath: string,
): CollectionSelection | null {
  for (const collection of collections) {
    const rootPath = collection.source.rootPath;
    if (selectedPath === rootPath) {
      return { ...collection, relativePath: "", entry: null };
    }
    if (!selectedPath.startsWith(`${rootPath}/`)) {
      continue;
    }

    const relativePath = selectedPath.slice(rootPath.length + 1).replace(/\/$/u, "");
    const entry = collection.source.tree.entries.find(
      (candidate) => candidate.path === relativePath,
    );
    if (!entry) {
      return null;
    }
    return { ...collection, relativePath, entry };
  }

  return null;
}

function canonicalSelectionPath(selection: CollectionSelection): string {
  if (!selection.entry) {
    return selection.source.rootPath;
  }

  const path = `${selection.source.rootPath}/${selection.relativePath}`;
  return selection.entry.kind === "directory" ? `${path}/` : path;
}

async function readSelectedTextContent(
  selection: CollectionSelection,
): Promise<FilesExplorerSelectedContent | null> {
  if (
    selection.entry?.kind !== "file" ||
    !isTextFile(selection.entry) ||
    (selection.entry.sizeBytes ?? 0) > FILES_EXPLORER_MAX_TEXT_PREVIEW_BYTES
  ) {
    return null;
  }

  const content = await selection.registration.collection.getFile(selection.relativePath);
  if (!content) {
    return null;
  }

  return {
    path: `${selection.source.rootPath}/${selection.relativePath}`,
    text: await new Response(content.body).text(),
  };
}

function isTextFile(entry: Extract<FileTreeEntry, { kind: "file" }>): boolean {
  if (entry.contentType?.startsWith("text/")) {
    return true;
  }
  if (
    entry.contentType &&
    /(?:json|javascript|typescript|xml|yaml|toml|shellscript)/iu.test(entry.contentType)
  ) {
    return true;
  }
  return /\.(?:md|mdx|txt|log|json|js|jsx|ts|tsx|css|html|xml|yml|yaml|toml|ini|sh)$/iu.test(
    entry.path,
  );
}

function orderExplorerSources(
  sources: readonly FilesExplorerSourceSnapshot[],
): FilesExplorerSourceSnapshot[] {
  const rankByRootPath = new Map<string, number>(
    FILES_EXPLORER_ROOT_ORDER.map((rootPath, index) => [rootPath, index]),
  );
  return [...sources].sort(
    (left, right) =>
      (rankByRootPath.get(left.rootPath) ?? Number.MAX_SAFE_INTEGER) -
      (rankByRootPath.get(right.rootPath) ?? Number.MAX_SAFE_INTEGER),
  );
}

function appendLoadError(current: string | null, next: string): string {
  return current ? `${current} ${next}` : next;
}

function appendOptionalLoadError(current: string | null, next: string | null): string | null {
  return next ? appendLoadError(current, next) : current;
}

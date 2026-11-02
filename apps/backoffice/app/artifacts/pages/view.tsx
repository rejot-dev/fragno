import type {
  LofiSqliteClient,
  LofiSqliteGuardedResult,
  LofiSqliteViewResult,
} from "@fragno-dev/lofi/sqlite";
import type { BackofficeUiLinkTarget } from "@fragno-private/backoffice-ui/link";
import type { PageDefinition, PageFile } from "@fragno-private/backoffice-ui/pages/definition";
import { pageQueryParams, PageRowsError } from "@fragno-private/backoffice-ui/pages/rows";
import {
  PageView,
  type PageFileState,
  type PageQueryState,
} from "@fragno-private/backoffice-ui/pages/view";
import {
  useMinuteClock,
  type BackofficeUiHostWidgets,
} from "@fragno-private/backoffice-ui/render-context";
import { PaneSpinner } from "@fragno-private/design-system/feedback/pane-message";
import { Suspense, use, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";

import {
  backofficeRouteScopeFromResolvedScope,
  type BackofficeResolvedScope,
} from "@/backoffice-runtime/resolved-scope";
import { useCurrentBackofficeContext } from "@/components/backoffice/current-context";
import { backofficeFetch } from "@/fragno/auth/browser-auth.client";
import { AUTOMATION_PAGE_VIEWS } from "@/fragno/automation/lofi/replica-schemas";
import { LofiReplicaGate } from "@/fragno/lofi/replica-gate";
import type { UploadFileRecord } from "@/fragno/upload/file-record";
import { useReadyUploadFiles, workspaceUploadKey } from "@/fragno/upload/lofi/replica";
import { piAgentsPath } from "@/routes/backoffice/agents/path";
import {
  ScopeOrchestration,
  type OrchestrationLoaderData,
} from "@/routes/backoffice/dashboard/orchestration-panel";
import { dashboardRunPath, dashboardSelectionPath } from "@/routes/backoffice/dashboard/path";
import { WorkflowRunResponse } from "@/routes/backoffice/dashboard/workflow-run-response";
import { filesDownloadPath, filesScopeBasePath } from "@/routes/backoffice/files/scope";
import {
  integrationConnectionPath,
  integrationsScopeBasePath,
} from "@/routes/backoffice/integrations/connection-paths";
import type { PageUploadSource } from "@/routes/backoffice/pages/load.server";

import { pageFileData, PageFileError } from "./page-files";
import { openPageUpload } from "./page-upload";

type BackofficePageViewProps = {
  definition: PageDefinition;
  replica: LofiSqliteClient;
  orchestration: OrchestrationLoaderData;
};

const NO_FILES: Readonly<Record<string, PageFileState>> = {};

/**
 * Renders a page over the current scope's Automations replica, with links into that scope, and
 * draws its host widgets: the orchestration graph from the route's loader data, and the forms runs
 * ask. A page that reads files reads them as the scope's Upload replica says they change.
 */
export function BackofficePageView({
  upload,
  ...props
}: BackofficePageViewProps & { upload: Promise<PageUploadSource> }) {
  // Pages without files never wait for where files are read.
  if (Object.keys(props.definition.files).length === 0) {
    return <ScopePageView {...props} files={NO_FILES} />;
  }
  return (
    <Suspense fallback={<PaneSpinner label="Opening workspace files" />}>
      <FilesSourcePageView {...props} upload={upload} />
    </Suspense>
  );
}

function FilesSourcePageView({
  upload,
  ...props
}: BackofficePageViewProps & { upload: Promise<PageUploadSource> }) {
  const files = use(openPageUpload(upload));
  switch (files.kind) {
    case "none":
      return <ScopePageView {...props} files={NO_FILES} />;
    case "unavailable":
      return (
        <ScopePageView
          {...props}
          files={Object.fromEntries(
            Object.keys(props.definition.files).map((name) => [
              name,
              { status: "error", message: files.message },
            ]),
          )}
        />
      );
    case "open":
      return (
        <LofiReplicaGate replica={files.replica} title="Downloading workspace files…">
          <FilesPageView {...props} uploadReplica={files.replica} />
        </LofiReplicaGate>
      );
    default:
      throw new Error("Unsupported Upload replica.", { cause: files satisfies never });
  }
}

function FilesPageView({
  uploadReplica,
  ...props
}: BackofficePageViewProps & { uploadReplica: LofiSqliteClient }) {
  const { resolvedScope } = useCurrentBackofficeContext();
  const records = useReadyUploadFiles(uploadReplica);
  const files = usePageFiles(props.definition, records, resolvedScope);
  return <ScopePageView {...props} files={files} />;
}

function ScopePageView({
  definition,
  replica,
  orchestration,
  files,
}: BackofficePageViewProps & { files: Readonly<Record<string, PageFileState>> }) {
  const { resolvedScope } = useCurrentBackofficeContext();
  const now = useMinuteClock();
  const results = usePageResults(replica, definition, now);
  const links = useMemo(() => pageLinks(resolvedScope), [resolvedScope]);
  const widgets = useMemo(
    (): BackofficeUiHostWidgets => ({
      orchestration: () => <ScopeOrchestration replica={replica} loaderData={orchestration} />,
      workflowResponse: (run) => (
        <WorkflowRunResponse replica={replica} resolvedScope={resolvedScope} run={run} />
      ),
    }),
    [replica, orchestration, resolvedScope],
  );
  return (
    <PageView
      definition={definition}
      results={results}
      files={files}
      now={now}
      links={links}
      widgets={widgets}
    />
  );
}

/** What reading a file waits on: the Upload replica, the file's revision, or why it cannot. */
type PageFileTarget =
  | { kind: "loading" }
  | { kind: "read"; revision: string }
  | { kind: "failed"; message: string };

/**
 * Each of the page's files, read through Files and read again whenever the Upload replica shows it
 * changed. Reads and their results belong to the file, not to the name a page gives it: one file's
 * change neither cancels nor repeats another's read, and a name never shows another file's data,
 * such as the same name's file on the page opened before. A file being read again shows its last
 * data until the new data arrives.
 */
function usePageFiles(
  definition: PageDefinition,
  records: LofiSqliteViewResult<UploadFileRecord[]>,
  scope: BackofficeResolvedScope,
): Readonly<Record<string, PageFileState>> {
  const scopePath = filesScopeBasePath(scope);
  const reads = useMemo(
    () =>
      Object.entries(definition.files).map(([name, file]) => ({
        name,
        file,
        // The same path read with other declarations decodes to other data.
        identity: JSON.stringify([scopePath, file]),
        target: pageFileTarget(file, records),
      })),
    [definition, records, scopePath],
  );
  // Reads start only when a target changed, not whenever the replica lists files again.
  const key = JSON.stringify(reads);
  const [results, setResults] = useState<Readonly<Record<string, PageFileState>>>({});
  const requests = useRef(new Map<string, { revision: string; controller: AbortController }>());
  useEffect(() => {
    const current = JSON.parse(key) as typeof reads;
    const identities = new Set(current.map(({ identity }) => identity));
    for (const [identity, request] of requests.current) {
      if (!identities.has(identity)) {
        request.controller.abort();
        requests.current.delete(identity);
      }
    }
    setResults((previous) =>
      Object.keys(previous).every((identity) => identities.has(identity))
        ? previous
        : Object.fromEntries(
            Object.entries(previous).filter(([identity]) => identities.has(identity)),
          ),
    );
    for (const { file, identity, target } of current) {
      if (target.kind === "loading") {
        continue;
      }
      const request = requests.current.get(identity);
      if (target.kind === "read" && request?.revision === target.revision) {
        continue;
      }
      request?.controller.abort();
      requests.current.delete(identity);
      if (target.kind === "failed") {
        setResults((previous) => ({
          ...previous,
          [identity]: { status: "error", message: target.message },
        }));
        continue;
      }
      const controller = new AbortController();
      requests.current.set(identity, { revision: target.revision, controller });
      void readPageFile(scope, file, controller.signal).then((state) => {
        if (!controller.signal.aborted) {
          setResults((previous) => ({ ...previous, [identity]: state }));
        }
      });
    }
  }, [key, scope]);
  useEffect(() => {
    const pending = requests.current;
    return () => {
      for (const request of pending.values()) {
        request.controller.abort();
      }
      pending.clear();
    };
  }, []);
  return useMemo(
    () =>
      Object.fromEntries(
        reads.flatMap(({ name, identity }) =>
          Object.hasOwn(results, identity) ? [[name, results[identity]]] : [],
        ),
      ),
    [reads, results],
  );
}

function pageFileTarget(
  file: PageFile,
  records: LofiSqliteViewResult<UploadFileRecord[]>,
): PageFileTarget {
  if (records.status === "loading") {
    return { kind: "loading" };
  }
  if (records.status === "error") {
    return {
      kind: "failed",
      message: "Workspace files could not be read from this browser's copy.",
    };
  }
  const record = records.data.find(({ fileKey }) => fileKey === workspaceUploadKey(file.path));
  if (!record) {
    return { kind: "failed", message: `${file.path} does not exist.` };
  }
  return {
    kind: "read",
    revision: JSON.stringify([
      record.revision,
      record.updatedAt,
      record.sizeBytes,
      record.checksum,
    ]),
  };
}

async function readPageFile(
  scope: BackofficeResolvedScope,
  file: PageFile,
  signal: AbortSignal,
): Promise<PageFileState> {
  try {
    const response = await backofficeFetch(filesDownloadPath(scope, file.path, "attachment"), {
      signal,
    });
    if (!response.ok) {
      return {
        status: "error",
        message: `${file.path} could not be read: HTTP ${response.status}.`,
      };
    }
    return { status: "ready", data: pageFileData(file, await response.text()) };
  } catch (error) {
    if (error instanceof PageFileError || error instanceof PageRowsError) {
      return { status: "error", message: `${file.path}: ${error.message}` };
    }
    const reason = error instanceof Error ? error.message : String(error);
    return { status: "error", message: `${file.path} could not be read: ${reason}` };
  }
}

const LOADING: PageQueryState = { status: "loading" };

/**
 * Each of the page's queries as a guarded SQL view of the replica, which its worker runs again
 * after every batch that wrote a relation the query reads. A query whose times move with `now`
 * opens a new view every minute; the page shows its last rows until the new ones arrive.
 */
function usePageResults(
  replica: LofiSqliteClient,
  definition: PageDefinition,
  now: number,
): Readonly<Record<string, PageQueryState>> {
  const queries = useMemo(
    () =>
      Object.entries(definition.queries).map(([name, query]) => ({
        name,
        sql: query.sql,
        params: pageQueryParams(query, now),
      })),
    [definition, now],
  );
  // Views open only when what a query asks for changed, not on every tick of the clock.
  const key = JSON.stringify(queries);
  const store = useMemo(() => {
    const views = (JSON.parse(key) as typeof queries).map(({ name, sql, params }) => ({
      name,
      view: replica.view<LofiSqliteGuardedResult>(AUTOMATION_PAGE_VIEWS, { sql, params }),
    }));
    let snapshot: Record<string, PageQueryState> = {};
    const read = () => {
      snapshot = Object.fromEntries(
        views.map(({ name, view }): [string, PageQueryState] => {
          const result = view.get();
          if (result.status === "loading") {
            return [name, LOADING];
          }
          if (result.status === "error") {
            return [name, { status: "error", message: result.message }];
          }
          const data = result.data;
          return [
            name,
            data.status === "error"
              ? { status: "error", message: data.message }
              : { status: "ready", result: data },
          ];
        }),
      );
    };
    read();
    return {
      subscribe: (onChange: () => void) => {
        const unsubscribes = views.map(({ view }) =>
          view.listen(() => {
            read();
            onChange();
          }),
        );
        read();
        return () => {
          for (const unsubscribe of unsubscribes) {
            unsubscribe();
          }
        };
      },
      get: () => snapshot,
    };
  }, [replica, key]);
  return useSyncExternalStore(store.subscribe, store.get, store.get);
}

/** Runs and routes open on the scope's dashboard, and connections in Integrations. */
function pageLinks(scope: BackofficeResolvedScope) {
  return (target: BackofficeUiLinkTarget) => {
    switch (target.kind) {
      case "run":
        return dashboardRunPath(scope, target);
      case "route":
        return dashboardSelectionPath(scope, { kind: "route", id: target.id });
      case "connection":
        return integrationConnectionPath(scope, target.id);
      case "integrations":
        return integrationsScopeBasePath(scope);
      case "agents":
        return piAgentsPath(backofficeRouteScopeFromResolvedScope(scope));
    }
    throw new Error("Unsupported generated UI link target.");
  };
}

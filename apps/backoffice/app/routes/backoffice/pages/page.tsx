import type { LofiSqliteClient } from "@fragno-dev/lofi/sqlite";
import type { PageDefinition, PageLoad } from "@fragno-private/backoffice-ui/pages/definition";
import { ClientOnly } from "@fragno-private/design-system/client-only";
import { Button } from "@fragno-private/design-system/controls/button";
import { Callout } from "@fragno-private/design-system/feedback/callout";
import { PaneSpinner } from "@fragno-private/design-system/feedback/pane-message";
import { BackofficeSystemState } from "@fragno-private/design-system/feedback/system-state";
import { Suspense, use, useEffect, useRef, useState } from "react";
import { data, useRevalidator, type ShouldRevalidateFunctionArgs } from "react-router";

import { openPageUpload } from "@/artifacts/pages/page-upload";
import { BackofficePageView } from "@/artifacts/pages/view";
import { backofficePageBodyClassName } from "@/components/backoffice/page-body";
import { useCurrentAutomationReplica } from "@/fragno/automation/lofi/replica";
import { LofiReplicaGate } from "@/fragno/lofi/replica-gate";
import { useReadyUploadFiles, workspaceUploadKey } from "@/fragno/upload/lofi/replica";

import { DashboardTabs } from "../dashboard/dashboard-tabs";
import { loadOrchestration } from "../dashboard/orchestration-loader.server";
import type { OrchestrationLoaderData } from "../dashboard/orchestration-panel";
import { shouldRevalidateOrchestration } from "../dashboard/path";
import type { Route } from "./+types/page";
import {
  loadPageRoute,
  loadPageSources,
  loadPageUploadSource,
  type PageBuildVersion,
  type PageUploadSource,
} from "./load.server";

// A missing page is data, not a thrown response, so previews that fetch this loader can show it.
export async function loader({ request, context, params, url }: Route.LoaderArgs) {
  const name = params["*"];
  const [{ result, build }, orchestration] = await Promise.all([
    loadPageRoute({ request, context, name }),
    loadOrchestration({ request, context, url }),
  ]);
  // Started once the route has loaded: when it throws, such as for a scope that does not
  // resolve, nothing would await them. Both stream, so the page responds without them; the
  // Upload source arrives while the browser downloads the Automations replica.
  return data(
    {
      name,
      result,
      build,
      orchestration,
      upload: loadPageUploadSource({ request, context }),
      pageSources: loadPageSources(context),
    },
    { status: result.kind === "missing" ? 404 : 200 },
  );
}

/** A rebuilt page reloads with revalidate(), which asks for the URL the page already shows. */
export function shouldRevalidate(args: ShouldRevalidateFunctionArgs): boolean {
  return args.currentUrl.href === args.nextUrl.href
    ? args.defaultShouldRevalidate
    : shouldRevalidateOrchestration(args);
}

/** A built page names itself; until it builds, its file name stands in. */
function pageTitle(name: string, result: PageLoad): string {
  return result.kind === "ready" ? result.definition.title : (name.split("/").at(-1) ?? name);
}

export function meta({ loaderData }: Route.MetaArgs) {
  const title = loaderData ? pageTitle(loaderData.name, loaderData.result) : "Page";
  return [{ title: `${title} · Pages` }];
}

export default function PageRoute({ loaderData }: Route.ComponentProps) {
  const { name, result, build, orchestration, upload, pageSources } = loaderData;
  const loading = <PaneSpinner label="Synchronizing automation data" />;

  return (
    <>
      <DashboardTabs
        selectedScope={orchestration.selectedScope}
        active={{ kind: "page", name }}
        pageSources={pageSources}
      />
      <div className={`${backofficePageBodyClassName} flex flex-col gap-4`}>
        <h1 className="text-lg font-semibold text-[var(--bo-fg)]">{pageTitle(name, result)}</h1>
        {build === null ? null : (
          <ClientOnly fallback={null}>
            <Suspense fallback={null}>
              <PageBuildWatcher upload={upload} build={build} />
            </Suspense>
          </ClientOnly>
        )}
        {result.kind === "missing" ? (
          <BackofficeSystemState tone="empty" label="Not found" title="This page does not exist." />
        ) : result.kind === "failed" ? (
          <BackofficeSystemState
            tone="error"
            label="Invalid page"
            title="This page could not be built."
            description={result.message}
          />
        ) : (
          <ClientOnly fallback={loading}>
            <PageClient
              definition={result.definition}
              orchestration={orchestration}
              upload={upload}
            />
          </ClientOnly>
        )}
      </div>
    </>
  );
}

/** The page over the scope's replica, once the replica holds the scope's whole history. */
function PageClient({
  definition,
  orchestration,
  upload,
}: {
  definition: PageDefinition;
  orchestration: OrchestrationLoaderData;
  upload: Promise<PageUploadSource>;
}) {
  const { replica, error } = useCurrentAutomationReplica();
  if (replica !== null) {
    // The download, with its progress and any error while it retries, until the replica caught up.
    return (
      <LofiReplicaGate replica={replica} title="Downloading automation activity…">
        <BackofficePageView
          definition={definition}
          replica={replica}
          orchestration={orchestration}
          upload={upload}
        />
      </LofiReplicaGate>
    );
  }
  if (error !== null) {
    return (
      <BackofficeSystemState
        tone="error"
        label="Unavailable"
        title="Automation data could not be synchronized."
        description={error}
      />
    );
  }
  return <PaneSpinner label="Synchronizing automation data" />;
}

/**
 * Reloads the page when its build is written after the version it shows, such as by an agent's
 * artifacts.buildPage, so an open page, a failed one too, shows the new build. Opening the Upload
 * replica here also lets it download while the Automations replica does; the view reads the same
 * connection. A replica that cannot open stays failed until the page reloads, so the page says it
 * no longer follows rebuilds, and offers the reload.
 */
function PageBuildWatcher({
  upload,
  build,
}: {
  upload: Promise<PageUploadSource>;
  build: PageBuildVersion;
}) {
  const opened = use(openPageUpload(upload));
  switch (opened.kind) {
    case "none":
      return null;
    case "open":
      return <ReplicaBuildWatcher replica={opened.replica} build={build} />;
    case "unavailable":
      return (
        <Callout tone="waiting" title="Live updates stopped">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <p>This page no longer updates when it is rebuilt: {opened.message}</p>
            <Button
              variant="secondary"
              onClick={() => {
                window.location.reload();
              }}
            >
              Reload
            </Button>
          </div>
        </Callout>
      );
    default:
      throw new Error("Unsupported Upload replica.", { cause: opened satisfies never });
  }
}

function ReplicaBuildWatcher({
  replica,
  build,
}: {
  replica: LofiSqliteClient;
  build: PageBuildVersion;
}) {
  const files = useReadyUploadFiles(replica);
  const revalidator = useRevalidator();
  const record =
    files.status === "ready"
      ? files.data.find(({ fileKey }) => fileKey === workspaceUploadKey(build.path))
      : undefined;
  const writtenAt = record?.updatedAt === undefined ? null : new Date(record.updatedAt).getTime();
  // The replica may still hold the build from before the loader wrote it, so only a later one
  // counts. Each is reloaded once, whatever the reload returns, but only a reload that lands
  // counts: a navigation the loader skips, such as selecting a run, cancels it and leaves the
  // loader's `build` the object it was.
  const newer =
    writtenAt !== null && (build.updatedAt === null || writtenAt > Date.parse(build.updatedAt));
  const reload = useRef<{ writtenAt: number; from: PageBuildVersion } | null>(null);
  // A reload cancelled before React rendered it loading changes nothing the effect reads, so its
  // end is what checks again.
  const [settledReloads, setSettledReloads] = useState(0);
  useEffect(() => {
    const reloaded = reload.current?.writtenAt === writtenAt && reload.current.from !== build;
    if (newer && !reloaded && revalidator.state === "idle") {
      reload.current = { writtenAt, from: build };
      void revalidator.revalidate().finally(() => {
        setSettledReloads((settled) => settled + 1);
      });
    }
  }, [newer, writtenAt, build, revalidator, settledReloads]);
  return null;
}

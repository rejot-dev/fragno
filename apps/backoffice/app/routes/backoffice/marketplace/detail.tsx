import { ChevronDown } from "lucide-react";
import { Suspense } from "react";
import {
  Form,
  Link,
  Outlet,
  redirect,
  useActionData,
  useLocation,
  useNavigate,
  useNavigation,
  useOutletContext,
  type ShouldRevalidateFunctionArgs,
} from "react-router";

import {
  backofficeScopeSinglePathSegment,
  type BackofficeRoutableScope,
} from "@/backoffice-runtime/scope-codec";
import { BackofficeStatusLight } from "@/components/backoffice";
import { ClientOnly } from "@/components/client-only";
import { findBackofficeMe } from "@/fragno/auth/auth-server";
import { requireBackofficeContext } from "@/fragno/auth/backoffice-principal.server";
import type { BackofficeMeData } from "@/fragno/auth/contracts";
import { buildMarketplaceIngestionWorkflowInstanceId } from "@/fragno/automation/marketplace-ingest-identity";
import { fetchAutomationCollectionSource } from "@/fragno/automation/tanstack/server";
import { marketplaceListingId } from "@/fragno/marketplace/owner";
import {
  decodeMarketplacePublishedVersionCursor,
  MarketplaceListingCursorError,
} from "@/fragno/marketplace/pagination";
import { BackofficeWorkerContext } from "@/worker-runtime/router-context";

import { buildBackofficeLoginPath } from "../auth-navigation";
import type { Route } from "./+types/detail";
import type { MarketplaceArtifactExplorerData } from "./artifact-files-model";
import { loadPublishedMarketplaceArtifactExplorer } from "./artifact-files.server";
import { MarketplaceInstallationWorkflow } from "./installation-workflow.client";
import type { MarketplaceLayoutContext } from "./layout-context";
import {
  buildArtifactVersionPath,
  marketplaceListingManagePath,
  marketplaceListingPath,
  marketplaceListingRefSchema,
} from "./navigation";
import { marketplaceRuntimeScopeFromRouteParams } from "./scope";

const dateFormatter = new Intl.DateTimeFormat("en-US", {
  month: "short",
  day: "numeric",
  year: "numeric",
  timeZone: "UTC",
});

const formatDate = (value: string) => dateFormatter.format(new Date(value));

type MarketplaceVersionOption = {
  version: string;
  publishedAt: string | null;
};

function sortMarketplaceVersionsNewestFirst(
  versions: readonly MarketplaceVersionOption[],
): MarketplaceVersionOption[] {
  return versions
    .map((version, index) => ({ version, index }))
    .sort((left, right) => {
      if (left.version.publishedAt === null) {
        return right.version.publishedAt === null ? left.index - right.index : 1;
      }
      if (right.version.publishedAt === null) {
        return -1;
      }

      const publishedAtOrder = right.version.publishedAt.localeCompare(left.version.publishedAt);
      return publishedAtOrder || left.index - right.index;
    })
    .map(({ version }) => version);
}

type IngestionActionData =
  | { ok: false; message: string }
  | {
      ok: true;
      action: "created" | "restarted" | "unchanged";
      version: string;
      workflowInstanceId: string;
      workflowStatus: "active" | "paused" | "errored" | "terminated" | "complete" | "waiting";
    };

export type MarketplaceArtifactOutletContext = {
  artifactFiles: MarketplaceArtifactExplorerData;
};

type MarketplaceInstallationTarget =
  | {
      state: "ready";
      organizationId: string;
      targetScope: BackofficeRoutableScope;
    }
  | { state: "unavailable" | "forbidden"; message: string };

const resolveMarketplaceInstallationTarget = (
  me: BackofficeMeData,
  targetScope: BackofficeRoutableScope,
): MarketplaceInstallationTarget => {
  if (targetScope.kind === "user") {
    if (targetScope.userId !== me.user.id) {
      return {
        state: "forbidden",
        message: "You can only install into your personal workspace.",
      };
    }

    const activeOrganizationId = me.activeOrganization?.organization.id;
    const installationOrganization =
      me.organizations.find(({ organization }) => organization.id === activeOrganizationId) ??
      me.organizations[0];
    return installationOrganization
      ? {
          state: "ready",
          organizationId: installationOrganization.organization.id,
          targetScope,
        }
      : {
          state: "unavailable",
          message: "Join an organization to install this automation.",
        };
  }

  const organizationId = targetScope.orgId;
  if (!me.organizations.some(({ organization }) => organization.id === organizationId)) {
    return {
      state: "forbidden",
      message: "The selected Marketplace scope is not available.",
    };
  }

  return { state: "ready", organizationId, targetScope };
};

export function shouldRevalidate({
  currentUrl,
  nextUrl,
  formMethod,
  defaultShouldRevalidate,
}: ShouldRevalidateFunctionArgs): boolean {
  if (formMethod || currentUrl.pathname !== nextUrl.pathname) {
    return defaultShouldRevalidate;
  }

  const currentSearch = new URLSearchParams(currentUrl.search);
  const nextSearch = new URLSearchParams(nextUrl.search);
  for (const parameter of ["artifactTab", "artifactPath", "artifactContent"]) {
    currentSearch.delete(parameter);
    nextSearch.delete(parameter);
  }
  return currentSearch.toString() === nextSearch.toString() ? false : defaultShouldRevalidate;
}

export async function loader({ request, params, context, url }: Route.LoaderArgs) {
  const me = await findBackofficeMe(request, context);
  if (!me?.user) {
    return Response.redirect(
      new URL(buildBackofficeLoginPath(`${url.pathname}${url.search}`), request.url),
      302,
    );
  }

  const selectedScope = marketplaceRuntimeScopeFromRouteParams(
    params,
    me.organizations.map(({ organization }) => organization),
  );
  const installationTarget = resolveMarketplaceInstallationTarget(me, selectedScope);
  if (installationTarget.state === "forbidden") {
    throw new Response("Not Found", { status: 404 });
  }

  const listingIdResult = marketplaceListingRefSchema.safeParse(params.listingRef);
  if (!listingIdResult.success) {
    throw new Response("Not Found", { status: 404 });
  }

  const versionCursor = url.searchParams.get("versionCursor")?.trim() || undefined;
  try {
    decodeMarketplacePublishedVersionCursor({
      encodedCursor: versionCursor,
      listingId: listingIdResult.data,
    });
  } catch (error) {
    if (error instanceof MarketplaceListingCursorError) {
      throw new Response(error.message, { status: 400 });
    }
    throw error;
  }

  const runtime = context.get(BackofficeWorkerContext).runtime;
  const marketplace = runtime.objects.marketplace.singleton().commands;
  const [detail, artifactManifest] = await Promise.all([
    marketplace.getPublishedListing({
      listingId: listingIdResult.data,
      versionCursor,
    }),
    marketplace.getArtifactManifest({ listingId: listingIdResult.data }),
  ]);
  if (!detail) {
    throw new Response("Not Found", { status: 404 });
  }

  const manageableOrganization = me.organizations.find(
    ({ organization }) =>
      marketplaceListingId({
        ownerScope: { kind: "org", orgId: organization.id },
        slug: detail.listing.slug,
      }) === detail.listing.listingId,
  );
  const installationOrganization =
    installationTarget.state === "ready"
      ? me.organizations.find(
          ({ organization }) => organization.id === installationTarget.organizationId,
        )?.organization
      : null;
  const selectedTargetScopeKey = backofficeScopeSinglePathSegment(selectedScope);
  const [artifactFiles, ingestions, installationCollectionSource] = await Promise.all([
    loadPublishedMarketplaceArtifactExplorer({
      manifest: artifactManifest,
      objects: runtime.objects,
      request,
      requestedVersion: url.searchParams.get("artifactVersion")?.trim() || undefined,
    }),
    installationOrganization
      ? runtime.objects.automations
          .forOrg(installationOrganization.id)
          .commands.listMarketplaceIngestions({ targetScope: selectedScope })
          .then((records) =>
            records.filter(
              (ingestion) =>
                ingestion.listingId === detail.listing.listingId &&
                ingestion.targetScopeKey === selectedTargetScopeKey,
            ),
          )
      : Promise.resolve([]),
    installationOrganization
      ? fetchAutomationCollectionSource(request, context, {
          kind: "org",
          organization: installationOrganization,
        })
      : Promise.resolve(null),
  ]);
  const selectedInstallationVersion =
    artifactFiles.state === "ready" ? artifactFiles.selectedVersion : detail.listing.latestVersion;
  const installationWorkflowInstanceId = installationOrganization
    ? await buildMarketplaceIngestionWorkflowInstanceId({
        targetScope: selectedScope,
        listingId: detail.listing.listingId,
        version: selectedInstallationVersion,
      })
    : null;

  return {
    ...detail,
    manageOrganizationSlug: manageableOrganization?.organization.slug ?? null,
    installationCollectionSource,
    installationWorkflowInstanceId,
    artifactFiles,
    ingestions: ingestions.map((ingestion) => ({
      ...ingestion,
      organizationName: installationOrganization?.name ?? installationOrganization?.id ?? "",
      latestVersion: detail.listing.latestVersion,
      outOfDate: ingestion.version !== detail.listing.latestVersion,
    })),
  };
}

export async function action({ request, params, context, url }: Route.ActionArgs) {
  const me = await findBackofficeMe(request, context);
  if (!me?.user) {
    throw redirect(buildBackofficeLoginPath(`${url.pathname}${url.search}`));
  }

  const listingIdResult = marketplaceListingRefSchema.safeParse(params.listingRef);
  if (!listingIdResult.success) {
    throw new Response("Not Found", { status: 404 });
  }

  const targetScope = marketplaceRuntimeScopeFromRouteParams(
    params,
    me.organizations.map(({ organization }) => organization),
  );
  const installationTarget = resolveMarketplaceInstallationTarget(me, targetScope);
  if (installationTarget.state !== "ready") {
    return {
      ok: false,
      message: installationTarget.message,
    } satisfies IngestionActionData;
  }

  const formData = await request.formData();
  const automations = context
    .get(BackofficeWorkerContext)
    .runtime.objects.automations.forOrg(installationTarget.organizationId).commands;

  try {
    const execution = await requireBackofficeContext(request, context, {
      kind: "org",
      orgId: installationTarget.organizationId,
    });
    const version = String(formData.get("version") ?? "").trim();
    if (!version) {
      return { ok: false, message: "A Marketplace version is required." };
    }

    const result = await automations.restartMarketplaceIngestion(
      {
        listingId: listingIdResult.data,
        targetScope: installationTarget.targetScope,
        version,
      },
      { execution, propagationContext: null },
    );
    return {
      ok: true,
      action: result.action,
      version: result.version,
      workflowInstanceId: result.workflowInstanceId,
      workflowStatus: result.workflowStatus,
    } satisfies IngestionActionData;
  } catch (error) {
    return {
      ok: false,
      message: error instanceof Error ? error.message : "Marketplace ingestion failed.",
    } satisfies IngestionActionData;
  }
}

export function meta({ loaderData }: Route.MetaArgs) {
  return [{ title: loaderData ? `${loaderData.listing.name} · Marketplace` : "Marketplace" }];
}

export default function BackofficeMarketplaceDetail({ loaderData }: Route.ComponentProps) {
  const { selectedScope } = useOutletContext<MarketplaceLayoutContext>();
  const {
    listing,
    versions,
    manageOrganizationSlug,
    nextVersionCursor,
    hasNextVersionPage,
    installationCollectionSource,
    installationWorkflowInstanceId,
    artifactFiles,
    ingestions,
  } = loaderData;
  const actionData = useActionData<IngestionActionData>();
  const navigation = useNavigation();
  const navigate = useNavigate();
  const location = useLocation();
  const search = new URLSearchParams(location.search);
  const selectedArtifactVersion =
    artifactFiles.state === "ready" ? artifactFiles.selectedVersion : listing.latestVersion;
  const installationVersion = selectedArtifactVersion;
  const installationVersions = sortMarketplaceVersionsNewestFirst(
    versions.some(({ version }) => version === installationVersion)
      ? versions
      : [...versions, { version: installationVersion, publishedAt: null }],
  );
  const publishedVersionParam = search.get("published");
  const publishedVersion = versions.some(({ version }) => version === publishedVersionParam)
    ? publishedVersionParam
    : null;
  const reusedPublication = publishedVersion !== null && search.get("reused") === "1";
  const hasOutdatedIngestion = ingestions.some((ingestion) => ingestion.outOfDate);
  const installationActionLabel = hasOutdatedIngestion
    ? "Update"
    : ingestions.length
      ? "Reinstall"
      : "Install";
  const observedInstallationWorkflowInstanceId =
    actionData?.ok === true ? actionData.workflowInstanceId : installationWorkflowInstanceId;

  const installedRelease = ingestions[0] ?? null;
  const artifactContent = (
    <Outlet context={{ artifactFiles } satisfies MarketplaceArtifactOutletContext} />
  );

  function closeInstallationResult() {
    const overviewSearch = new URLSearchParams(location.search);
    overviewSearch.set("artifactTab", "overview");
    overviewSearch.delete("artifactPath");
    overviewSearch.delete("artifactContent");
    void navigate(`${location.pathname}?${overviewSearch}`, { preventScrollReset: true });
  }

  return (
    <div className="w-full space-y-5">
      <header className="bo-panel-surface bg-[var(--bo-panel)] p-5 md:p-7">
        <div className="flex flex-col gap-6 xl:flex-row xl:items-start xl:justify-between">
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2.5">
              <span className="bo-product-code">PKG</span>
              <p className="font-mono text-[10px] tracking-[0.16em] text-[var(--bo-muted-2)] uppercase">
                {listing.category}
              </p>
            </div>
            <h2 className="mt-3 max-w-4xl text-3xl font-semibold tracking-[-0.035em] text-balance text-[var(--bo-fg)] md:text-4xl">
              {listing.name}
            </h2>
            <p className="mt-3 max-w-3xl text-[15px] leading-7 text-pretty text-[var(--bo-muted)]">
              {listing.summary}
            </p>
            {listing.tags.length ? (
              <div className="mt-5 flex flex-wrap gap-2">
                {listing.tags.map((tag) => (
                  <span
                    key={tag}
                    className="bg-[var(--bo-panel-2)] px-2.5 py-1 font-mono text-[10px] text-[var(--bo-muted)] shadow-[inset_0_0_0_1px_var(--bo-border)]"
                  >
                    #{tag}
                  </span>
                ))}
              </div>
            ) : null}
          </div>

          <div className="flex shrink-0 flex-col gap-3 xl:items-end">
            {manageOrganizationSlug ? (
              <Link
                to={marketplaceListingManagePath({
                  listingId: listing.listingId,
                  organizationSlug: manageOrganizationSlug,
                })}
                className="bo-control-surface inline-flex min-h-10 items-center justify-center self-start bg-[var(--bo-panel)] px-4 text-[10px] font-semibold tracking-[0.18em] text-[var(--bo-muted)] uppercase transition-[scale,background-color,color,box-shadow] duration-150 ease-out hover:bg-[var(--bo-panel-2)] hover:text-[var(--bo-fg)] focus-visible:ring-2 focus-visible:ring-[color:var(--bo-accent)]/30 focus-visible:outline-none active:scale-[0.96] xl:self-end"
              >
                Manage listing
              </Link>
            ) : null}

            <div className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-end">
              <VersionHistoryDropdown
                versions={installationVersions}
                selectedVersion={selectedArtifactVersion}
                latestVersion={listing.latestVersion}
                selectedScope={selectedScope}
                listingId={listing.listingId}
                pathname={location.pathname}
                search={location.search}
                nextVersionCursor={nextVersionCursor}
                hasNextVersionPage={hasNextVersionPage}
              />

              {installationCollectionSource ? (
                <div className="flex min-h-11 items-center justify-between gap-3 sm:justify-end">
                  <div className="min-w-0 text-left sm:max-w-52 sm:text-right">
                    <p className="text-[9px] font-semibold tracking-[0.14em] text-[var(--bo-muted-2)] uppercase">
                      Install into
                    </p>
                    <p className="mt-1 truncate text-sm font-medium text-[var(--bo-fg)]">
                      {selectedScope.label}
                    </p>
                    {installedRelease ? (
                      <p className="mt-1 font-mono text-[9px] text-[var(--bo-muted-2)]">
                        v{installedRelease.version}
                        {installedRelease.outOfDate ? " · update available" : " · current"}
                      </p>
                    ) : null}
                  </div>
                  <Form method="post">
                    <input type="hidden" name="version" value={installationVersion} />
                    <button
                      type="submit"
                      disabled={navigation.state !== "idle"}
                      className="inline-flex min-h-11 shrink-0 items-center justify-center bg-[var(--bo-btn-bg)] px-5 text-[10px] font-semibold tracking-[0.16em] text-[var(--bo-btn-fg)] uppercase shadow-[0_8px_20px_rgba(var(--bo-accent-rgb),0.2)] transition-[scale,background-color,box-shadow,opacity] duration-150 ease-out hover:bg-[var(--bo-btn-bg-hover)] hover:shadow-[0_10px_24px_rgba(var(--bo-accent-rgb),0.26)] focus-visible:ring-2 focus-visible:ring-[color:var(--bo-accent)]/35 focus-visible:ring-offset-2 focus-visible:outline-none active:scale-[0.96] disabled:cursor-not-allowed disabled:opacity-50 disabled:shadow-none disabled:active:scale-100"
                    >
                      {navigation.state === "submitting" ? "Starting…" : installationActionLabel}
                    </button>
                  </Form>
                </div>
              ) : (
                <p className="max-w-xs text-sm leading-6 text-pretty text-[var(--bo-muted)]">
                  Join an organization to install into {selectedScope.label}.
                </p>
              )}
            </div>
          </div>
        </div>

        {publishedVersion ? (
          <div className="mt-4 bg-[var(--bo-live-bg)] px-4 py-3 text-sm text-[var(--bo-live)] shadow-[inset_0_0_0_1px_color-mix(in_srgb,var(--bo-live)_35%,transparent)]">
            <p className="text-pretty">
              {reusedPublication
                ? `Version ${publishedVersion} was already published.`
                : `Version ${publishedVersion} was published successfully.`}
            </p>
          </div>
        ) : null}

        <div className="mt-6">
          <dl className="grid gap-px bg-[var(--bo-border)] shadow-[0_0_0_1px_var(--bo-border)] sm:grid-cols-3">
            <ReleaseFact label="Latest version" value={listing.latestVersion} mono />
            <ReleaseFact label="Published" value={formatDate(listing.publishedAt)} />
            <ReleaseFact label="Publisher" value={listing.publisherName} />
          </dl>
        </div>
      </header>

      <main className="min-w-0">
        {navigation.state === "submitting" ? (
          <InstallationStartingSurface scopeLabel={selectedScope.label} />
        ) : actionData?.ok === false ? (
          <InstallationFailureSurface message={actionData.message} />
        ) : installationCollectionSource && observedInstallationWorkflowInstanceId ? (
          <ClientOnly fallback={artifactContent}>
            {() => (
              <Suspense
                fallback={
                  actionData?.ok ? (
                    <InstallationStartingSurface scopeLabel={selectedScope.label} />
                  ) : (
                    artifactContent
                  )
                }
              >
                <MarketplaceInstallationWorkflow
                  collectionSource={installationCollectionSource}
                  fallback={artifactContent}
                  ingestionWorkflowInstanceId={observedInstallationWorkflowInstanceId}
                  onClose={closeInstallationResult}
                  requested={actionData?.ok === true}
                  targetScope={selectedScope}
                />
              </Suspense>
            )}
          </ClientOnly>
        ) : (
          artifactContent
        )}
      </main>
    </div>
  );
}

function VersionHistoryDropdown({
  versions,
  selectedVersion,
  latestVersion,
  selectedScope,
  listingId,
  pathname,
  search,
  nextVersionCursor,
  hasNextVersionPage,
}: {
  versions: readonly MarketplaceVersionOption[];
  selectedVersion: string;
  latestVersion: string;
  selectedScope: MarketplaceLayoutContext["selectedScope"];
  listingId: string;
  pathname: string;
  search: string;
  nextVersionCursor?: string;
  hasNextVersionPage: boolean;
}) {
  return (
    <details className="group relative">
      <summary className="flex min-h-11 min-w-36 cursor-pointer list-none items-center justify-end gap-2 px-1 text-left transition-[scale,color] duration-150 ease-out hover:text-[var(--bo-accent-fg)] focus-visible:ring-2 focus-visible:ring-[color:var(--bo-accent)]/30 focus-visible:outline-none active:scale-[0.96] sm:text-right [&::-webkit-details-marker]:hidden">
        <span>
          <span className="block text-[9px] font-semibold tracking-[0.14em] text-[var(--bo-muted-2)] uppercase">
            Version history
          </span>
          <span className="mt-1 block font-mono text-sm font-medium text-[var(--bo-fg)]">
            v{selectedVersion}
          </span>
        </span>
        <ChevronDown
          className="size-3.5 text-[var(--bo-muted-2)] transition-transform duration-150 ease-out group-open:rotate-180"
          aria-hidden="true"
        />
      </summary>
      <div className="absolute top-full right-0 z-30 mt-2 w-[min(20rem,calc(100vw-2rem))] bg-[var(--bo-panel)] p-2 shadow-[0_18px_48px_rgba(0,0,0,0.18),0_0_0_1px_var(--bo-border-strong)]">
        <div className="max-h-80 space-y-1 overflow-y-auto">
          {versions.map((version) => {
            const isLatest = version.version === latestVersion;
            const isSelected = version.version === selectedVersion;
            return (
              <Link
                key={version.version}
                to={buildArtifactVersionPath(pathname, search, selectedVersion, version.version)}
                preventScrollReset
                aria-current={isSelected ? "page" : undefined}
                onClick={(event) => {
                  event.currentTarget.closest("details")?.removeAttribute("open");
                }}
                className={
                  isSelected
                    ? "flex min-h-12 items-center justify-between gap-4 bg-[var(--bo-accent-bg)] px-3 py-2.5 text-[var(--bo-fg)] shadow-[inset_0_0_0_1px_var(--bo-accent)] outline-none focus-visible:ring-2 focus-visible:ring-[color:var(--bo-accent)]/30"
                    : "flex min-h-12 items-center justify-between gap-4 px-3 py-2.5 text-[var(--bo-fg)] transition-colors duration-150 ease-out outline-none hover:bg-[var(--bo-panel-2)] focus-visible:ring-2 focus-visible:ring-[color:var(--bo-accent)]/30"
                }
              >
                <span className="min-w-0">
                  <span className="block font-mono text-xs font-semibold">v{version.version}</span>
                  <span className="mt-1 block text-[10px] text-[var(--bo-muted-2)]">
                    {version.publishedAt ? formatDate(version.publishedAt) : "Published release"}
                  </span>
                </span>
                {isLatest ? (
                  <BackofficeStatusLight tone="info">Latest</BackofficeStatusLight>
                ) : null}
              </Link>
            );
          })}
        </div>
        {hasNextVersionPage && nextVersionCursor ? (
          <Link
            to={`${marketplaceListingPath(listingId, selectedScope)}?versionCursor=${encodeURIComponent(nextVersionCursor)}`}
            className="mt-2 flex min-h-10 items-center justify-center border-t border-[color:var(--bo-border)] px-3 pt-2 text-center text-[9px] font-semibold tracking-[0.16em] text-[var(--bo-muted)] uppercase transition-colors duration-150 ease-out hover:text-[var(--bo-fg)] focus-visible:ring-2 focus-visible:ring-[color:var(--bo-accent)]/30 focus-visible:outline-none"
          >
            Browse older versions →
          </Link>
        ) : null}
      </div>
    </details>
  );
}

function InstallationStartingSurface({ scopeLabel }: { scopeLabel: string }) {
  return (
    <section className="bo-panel-surface flex min-h-80 items-center justify-center bg-[var(--bo-panel)] p-6 text-center md:p-10">
      <div className="max-w-md">
        <span className="mx-auto block size-2 animate-pulse rounded-full bg-[var(--bo-accent)] motion-reduce:animate-none" />
        <h3 className="mt-5 text-lg font-semibold tracking-tight text-balance text-[var(--bo-fg)]">
          Starting installation
        </h3>
        <p className="mt-2 text-sm leading-6 text-pretty text-[var(--bo-muted)]">
          Preparing the selected release for {scopeLabel}.
        </p>
      </div>
    </section>
  );
}

function InstallationFailureSurface({ message }: { message: string }) {
  return (
    <section className="bo-panel-surface flex min-h-80 items-center justify-center bg-[var(--bo-panel)] p-6 text-center md:p-10">
      <div className="max-w-md">
        <span className="mx-auto block size-2 rounded-full bg-[var(--bo-failed)]" />
        <h3 className="mt-5 text-lg font-semibold tracking-tight text-balance text-[var(--bo-fg)]">
          Installation could not start
        </h3>
        <p className="mt-2 text-sm leading-6 text-pretty text-[var(--bo-failed)]">{message}</p>
      </div>
    </section>
  );
}

function ReleaseFact({
  label,
  value,
  mono = false,
}: {
  label: string;
  value: string;
  mono?: boolean;
}) {
  return (
    <div className="min-w-0 bg-[var(--bo-panel-2)] px-4 py-3.5">
      <dt className="font-mono text-[9px] tracking-[0.14em] text-[var(--bo-muted-2)] uppercase">
        {label}
      </dt>
      <dd
        className={`mt-1 truncate text-sm text-[var(--bo-fg)] ${mono ? "font-mono font-semibold" : "font-medium"}`}
        title={value}
      >
        {value}
      </dd>
    </div>
  );
}

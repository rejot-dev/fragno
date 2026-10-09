import {
  MARKETPLACE_LOCK_PATH,
  marketplaceInstallationRootSchema,
} from "@fragno-dev/backoffice-api/v0/marketplace";
import type { BackofficeRoutableScope } from "@fragno-dev/backoffice-api/v0/shared/scope";
import { Button, ButtonLink } from "@fragno-private/design-system/button";
import { ClientOnly } from "@fragno-private/design-system/client-only";
import { Icon } from "@fragno-private/design-system/icon";
import { Input } from "@fragno-private/design-system/input";
import { BackofficeStatusLight } from "@fragno-private/design-system/status-light";
import { usePostHog } from "@posthog/react/slim";
import { Suspense, useState } from "react";
import {
  Link,
  Outlet,
  redirect,
  useActionData,
  useFetcher,
  useLocation,
  useNavigate,
  useOutletContext,
  type ShouldRevalidateFunctionArgs,
} from "react-router";

import { findBackofficeMe } from "@/fragno/auth/auth-server";
import { requireBackofficeContext } from "@/fragno/auth/backoffice-principal.server";
import type { BackofficeMeData } from "@/fragno/auth/contracts";
import { buildMarketplacePackageInstallWorkflowInstanceId } from "@/fragno/automation/marketplace-package-install-identity";
import { fetchAutomationCollectionSource } from "@/fragno/automation/tanstack/server";
import { marketplaceListingId } from "@/fragno/marketplace/owner";
import {
  decodeMarketplacePublishedVersionCursor,
  MarketplaceListingCursorError,
} from "@/fragno/marketplace/pagination";
import { captureBackofficeServerEvent } from "@/posthog.server";
import { BackofficeWorkerContext } from "@/worker-runtime/router-context";

import { buildBackofficeLoginPath } from "../auth-navigation";
import { filesExplorerPath } from "../files/scope";
import type { Route } from "./+types/detail";
import type { MarketplaceArtifactExplorerData } from "./artifact-files-model";
import { loadPublishedMarketplaceArtifactExplorer } from "./artifact-files.server";
import {
  buildMarketplaceInstallationPath,
  readMarketplaceInstallationReference,
  type MarketplaceInstallationReference,
} from "./installation-reference";
import { MarketplaceInstallationWorkflow } from "./installation-workflow.client";
import type { MarketplaceLayoutContext } from "./layout-context";
import {
  buildArtifactVersionPath,
  marketplaceListingManagePath,
  marketplaceListingPath,
  marketplaceListingRefSchema,
} from "./navigation";
import {
  buildMarketplacePackageTabPath,
  marketplacePackageTabFromSearch,
  MarketplacePackageTabs,
} from "./package-tabs";
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

type IngestionActionData = { ok: false; message: string };

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
  installationOrganizationId: string | null,
): MarketplaceInstallationTarget => {
  if (targetScope.kind === "user") {
    if (targetScope.userId !== me.user.id) {
      return {
        state: "forbidden",
        message: "You can only install into your personal workspace.",
      };
    }

    const activeOrganizationId = me.activeOrganization?.organization.id;
    const installationOrganization = installationOrganizationId
      ? me.organizations.find(({ organization }) => organization.id === installationOrganizationId)
      : (me.organizations.find(({ organization }) => organization.id === activeOrganizationId) ??
        me.organizations[0]);
    if (installationOrganizationId && !installationOrganization) {
      return { state: "forbidden", message: "The installation organization is not available." };
    }
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
  if (
    (installationOrganizationId !== null && installationOrganizationId !== organizationId) ||
    !me.organizations.some(({ organization }) => organization.id === organizationId)
  ) {
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
  let persistedInstallation: MarketplaceInstallationReference | null;
  try {
    persistedInstallation = readMarketplaceInstallationReference(url.search);
  } catch (error) {
    throw new Response(error instanceof Error ? error.message : "Invalid installation reference.", {
      status: 400,
    });
  }
  const installationTarget = resolveMarketplaceInstallationTarget(
    me,
    selectedScope,
    persistedInstallation?.organizationId ?? null,
  );
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
  const [artifactFiles, installationCollectionSource] = await Promise.all([
    loadPublishedMarketplaceArtifactExplorer({
      manifest: artifactManifest,
      objects: runtime.objects,
      request,
      requestedVersion: url.searchParams.get("artifactVersion")?.trim() || undefined,
    }),
    installationOrganization
      ? fetchAutomationCollectionSource(request, context, {
          kind: "org",
          organization: installationOrganization,
        })
      : Promise.resolve(null),
  ]);

  return {
    ...detail,
    manageOrganizationSlug: manageableOrganization?.organization.slug ?? null,
    installationCollectionSource,
    installationReference: persistedInstallation
      ? {
          ...persistedInstallation,
          workflowInstanceId: await buildMarketplacePackageInstallWorkflowInstanceId({
            targetScope: selectedScope,
            listingId: listingIdResult.data,
            installationRoot: persistedInstallation.installationRoot,
            version: persistedInstallation.version,
          }),
        }
      : null,
    artifactFiles,
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
  const installationTarget = resolveMarketplaceInstallationTarget(me, targetScope, null);
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

    const installationRootResult = marketplaceInstallationRootSchema.safeParse(
      formData.get("installationRoot"),
    );
    if (!installationRootResult.success) {
      return {
        ok: false,
        message: installationRootResult.error.issues[0].message,
      } satisfies IngestionActionData;
    }
    const result = await automations.restartMarketplaceIngestion(
      {
        listingId: listingIdResult.data,
        targetScope: installationTarget.targetScope,
        installationRoot: installationRootResult.data,
        version,
      },
      { execution, propagationContext: null },
    );
    captureBackofficeServerEvent(context, {
      event: "marketplace_ingestion_admitted",
      userId: execution.userAuthority.userId,
      properties: {
        listing_id: listingIdResult.data,
        version: result.version,
        scope_kind: installationTarget.targetScope.kind,
        organization_id: installationTarget.organizationId,
      },
    });
    return redirect(
      buildMarketplaceInstallationPath(url.pathname, url.search, {
        organizationId: installationTarget.organizationId,
        installationRoot: installationRootResult.data,
        version: result.version,
      }),
    );
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

export default function BackofficeMarketplaceDetail(props: Route.ComponentProps) {
  const location = useLocation();
  // Changing sections or releases keeps the installation draft; changing listings starts fresh.
  return <MarketplaceListingDetail key={location.pathname} {...props} />;
}

function MarketplaceListingDetail({ loaderData }: Route.ComponentProps) {
  const posthog = usePostHog();
  const { selectedScope } = useOutletContext<MarketplaceLayoutContext>();
  const {
    listing,
    versions,
    manageOrganizationSlug,
    nextVersionCursor,
    hasNextVersionPage,
    installationCollectionSource,
    installationReference,
    artifactFiles,
  } = loaderData;
  const installation = useFetcher<IngestionActionData>();
  const navigationActionData = useActionData<IngestionActionData>();
  const actionData = installation.data ?? navigationActionData;
  const [installationRoot, setInstallationRoot] = useState(
    installationReference?.installationRoot ?? `/workspace/${listing.slug}`,
  );
  const [installationPathError, setInstallationPathError] = useState<string | null>(null);
  const navigate = useNavigate();
  const location = useLocation();
  const search = new URLSearchParams(location.search);
  const activeTab = marketplacePackageTabFromSearch(location.search);
  const installationTabPath = buildMarketplacePackageTabPath(
    location.pathname,
    location.search,
    "install",
  );
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
  const artifactContent = (
    <Outlet context={{ artifactFiles } satisfies MarketplaceArtifactOutletContext} />
  );

  function closeInstallationResult() {
    if (installationReference) {
      setInstallationRoot(installationReference.installationRoot);
    }
    setInstallationPathError(null);
    void navigate(buildMarketplaceInstallationPath(location.pathname, location.search, null), {
      preventScrollReset: true,
      replace: true,
    });
  }

  return (
    <div className="w-full space-y-5">
      <header className="bo-panel-surface bg-[var(--bo-panel)] p-5 md:p-7">
        <div className="flex flex-col gap-5 sm:flex-row sm:items-start sm:justify-between">
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2.5">
              <span className="bo-product-code">PKG</span>
              <p className="text-[10px] tracking-[0.16em] text-[var(--bo-muted-2)] uppercase">
                {listing.category}
              </p>
            </div>
            <h2 className="mt-3 max-w-3xl text-2xl font-semibold tracking-[-0.025em] text-balance text-[var(--bo-fg)] md:text-3xl">
              {listing.name}
            </h2>
            <p className="mt-2 max-w-2xl text-sm leading-6 text-pretty text-[var(--bo-muted)]">
              {listing.summary}
            </p>
            {listing.tags.length ? (
              <div className="mt-3 flex flex-wrap gap-x-3 gap-y-1">
                {listing.tags.map((tag) => (
                  <span key={tag} className="font-mono text-xs text-[var(--bo-muted-2)]">
                    #{tag}
                  </span>
                ))}
              </div>
            ) : null}
          </div>

          <ButtonLink
            to={installationTabPath}
            variant="solid"
            preventScrollReset
            className="shrink-0 self-start"
          >
            Install
          </ButtonLink>
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

        <div className="mt-4 flex flex-wrap items-center gap-x-4 gap-y-2 text-xs text-[var(--bo-muted)]">
          <span>
            Published by{" "}
            <span className="font-medium text-[var(--bo-fg)]">{listing.publisherName}</span>
          </span>
          <span>Updated {formatDate(listing.updatedAt)}</span>
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
          {manageOrganizationSlug ? (
            <Link
              to={marketplaceListingManagePath({
                listingId: listing.listingId,
                organizationSlug: manageOrganizationSlug,
              })}
              className="font-medium underline-offset-4 hover:text-[var(--bo-fg)] hover:underline"
            >
              Manage listing
            </Link>
          ) : null}
        </div>
      </header>

      <section className="bo-panel-surface min-w-0 bg-[var(--bo-panel)] p-5 md:p-7">
        <MarketplacePackageTabs />
        {activeTab !== "install" ? (
          artifactContent
        ) : (
          <div className="mt-6">
            {installation.state !== "idle" ? (
              <InstallationStartingSurface scopeLabel={selectedScope.label} />
            ) : installationCollectionSource && installationReference ? (
              <ClientOnly
                fallback={<InstallationStartingSurface scopeLabel={selectedScope.label} />}
              >
                {() => (
                  <Suspense
                    fallback={<InstallationStartingSurface scopeLabel={selectedScope.label} />}
                  >
                    <MarketplaceInstallationWorkflow
                      collectionSource={installationCollectionSource}
                      fallback={null}
                      ingestionWorkflowInstanceId={installationReference.workflowInstanceId}
                      onClose={closeInstallationResult}
                      requested={true}
                      installedFolderHref={filesExplorerPath(
                        selectedScope,
                        installationReference.installationRoot,
                      )}
                      targetScope={selectedScope}
                    />
                  </Suspense>
                )}
              </ClientOnly>
            ) : (
              <div className="max-w-2xl">
                <h3 className="text-lg font-semibold tracking-tight text-[var(--bo-fg)]">
                  Install package
                </h3>
                <p className="mt-1 text-sm leading-6 text-pretty text-[var(--bo-muted)]">
                  Choose where to install this release in your workspace.
                </p>
                <dl className="mt-5 grid grid-cols-2 gap-4 border-y border-[color:var(--bo-border)] py-4 text-sm">
                  <div className="min-w-0">
                    <dt className="text-xs text-[var(--bo-muted)]">Workspace</dt>
                    <dd className="mt-1 font-medium break-words text-[var(--bo-fg)]">
                      {selectedScope.label}
                    </dd>
                  </div>
                  <div>
                    <dt className="text-xs text-[var(--bo-muted)]">Version</dt>
                    <dd className="mt-1 font-mono text-[var(--bo-fg)]">v{installationVersion}</dd>
                  </div>
                </dl>
                {installationCollectionSource ? (
                  <installation.Form
                    method="post"
                    action={installationTabPath}
                    className="mt-5"
                    onSubmit={(event) => {
                      const path = marketplaceInstallationRootSchema.safeParse(installationRoot);
                      if (!path.success) {
                        event.preventDefault();
                        setInstallationPathError(path.error.issues[0].message);
                        return;
                      }
                      setInstallationPathError(null);
                      if (posthog) {
                        posthog.capture("marketplace_installation_started", {
                          listing_id: listing.listingId,
                          version: installationVersion,
                          scope_kind: selectedScope.kind,
                        });
                      }
                    }}
                  >
                    <input type="hidden" name="version" value={installationVersion} />
                    <label
                      htmlFor="marketplace-installation-root"
                      className="block text-sm font-medium text-[var(--bo-fg)]"
                    >
                      Install folder
                    </label>
                    <Input
                      id="marketplace-installation-root"
                      name="installationRoot"
                      value={installationRoot}
                      onChange={(event) => {
                        setInstallationRoot(event.currentTarget.value);
                        setInstallationPathError(null);
                      }}
                      autoComplete="off"
                      spellCheck={false}
                      required
                      aria-invalid={installationPathError !== null}
                      aria-describedby="marketplace-installation-path-help marketplace-installation-path-error"
                      className="mt-2 w-full font-mono text-sm"
                    />
                    <p
                      id="marketplace-installation-path-help"
                      className="mt-2 text-xs leading-5 text-pretty text-[var(--bo-muted)]"
                    >
                      Use a folder under <code>/workspace</code>. Successful installs record this
                      release and folder in <code>{MARKETPLACE_LOCK_PATH}</code>. Conflicting files
                      stop installation.
                    </p>
                    <p
                      id="marketplace-installation-path-error"
                      role={installationPathError ? "alert" : undefined}
                      className="mt-2 text-xs text-[var(--bo-failed)]"
                    >
                      {installationPathError}
                    </p>
                    <div className="mt-5 flex items-center gap-3">
                      <Button type="submit" variant="solid">
                        Install
                      </Button>
                      <ButtonLink
                        to={buildMarketplacePackageTabPath(
                          location.pathname,
                          location.search,
                          "overview",
                        )}
                        variant="ghost"
                        preventScrollReset
                      >
                        Cancel
                      </ButtonLink>
                    </div>
                    {actionData?.ok === false ? (
                      <InstallationFailureSurface message={actionData.message} />
                    ) : null}
                  </installation.Form>
                ) : (
                  <p className="mt-5 text-sm text-[var(--bo-muted)]">
                    Join an organization to install into {selectedScope.label}.
                  </p>
                )}
              </div>
            )}
          </div>
        )}
      </section>
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
    <details className="group relative w-full sm:w-auto">
      <summary
        aria-label={`Version history. Selected version v${selectedVersion}`}
        className="flex min-h-10 w-fit cursor-pointer list-none items-center gap-2 rounded-[4px] bg-[var(--bo-panel-2)] px-3 font-mono text-xs font-medium text-[var(--bo-fg)] transition-colors duration-150 hover:bg-[var(--bo-selected-bg)] focus-visible:ring-2 focus-visible:ring-[color:var(--bo-accent)]/30 focus-visible:outline-none [&::-webkit-details-marker]:hidden"
      >
        <span>v{selectedVersion}</span>
        <Icon
          name="chevron-down"
          className="size-3.5 text-[var(--bo-muted-2)] transition-transform duration-150 ease-out group-open:rotate-180"
        />
      </summary>
      <div className="absolute top-full left-0 z-30 mt-2 w-[min(20rem,calc(100vw-4rem))] rounded-[4px] bg-[var(--bo-panel)] p-2 shadow-[0_18px_48px_rgba(0,0,0,0.18),0_0_0_1px_var(--bo-border-strong)] sm:right-0 sm:left-auto">
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
                    ? "flex min-h-12 items-center justify-between gap-4 bg-[var(--bo-selected-bg)] px-3 py-2.5 text-[var(--bo-fg)] shadow-[inset_0_0_0_1px_var(--bo-selected-border),var(--bo-selected-shadow)] outline-none focus-visible:ring-2 focus-visible:ring-[color:var(--bo-accent)]/30"
                    : "flex min-h-12 items-center justify-between gap-4 px-3 py-2.5 text-[var(--bo-fg)] transition-colors duration-150 ease-out outline-none hover:bg-[var(--bo-panel-2)] focus-visible:ring-2 focus-visible:ring-[color:var(--bo-accent)]/30"
                }
              >
                <span className="min-w-0">
                  <span className="block text-xs font-semibold">v{version.version}</span>
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
    <section aria-live="polite">
      <h3 className="text-lg font-semibold tracking-tight text-[var(--bo-fg)]">
        Starting installation
      </h3>
      <p className="mt-1 text-sm leading-6 text-pretty text-[var(--bo-muted)]">
        Preparing the selected release for {scopeLabel}.
      </p>
    </section>
  );
}

function InstallationFailureSurface({ message }: { message: string }) {
  return (
    <div
      role="alert"
      className="mt-4 rounded-[4px] bg-[var(--bo-failed-bg)] p-4 text-sm text-[var(--bo-failed)]"
    >
      <p className="font-medium">Installation could not start</p>
      <p className="mt-1 leading-6 text-pretty">{message}</p>
    </div>
  );
}

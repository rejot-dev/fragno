import {
  Form,
  Link,
  redirect,
  useActionData,
  useLocation,
  useNavigation,
  useOutletContext,
} from "react-router";

import {
  backofficeScopeSinglePathSegment,
  type BackofficeRoutableScope,
} from "@/backoffice-runtime/scope-codec";
import { BackofficeStatusLight } from "@/components/backoffice";
import type { AuthMeData } from "@/fragno/auth/auth-client";
import { getAuthMe } from "@/fragno/auth/auth-server";
import type { MarketplaceIngestionRequestResult } from "@/fragno/automation";
import { marketplaceListingId, marketplaceListingSlug } from "@/fragno/marketplace/owner";
import {
  decodeMarketplacePublishedVersionCursor,
  MarketplaceListingCursorError,
} from "@/fragno/marketplace/pagination";
import { BackofficeWorkerContext } from "@/worker-runtime/router-context";

import { buildBackofficeLoginPath } from "../auth-navigation";
import type { Route } from "./+types/detail";
import { MarketplaceArtifactFiles } from "./artifact-files";
import { loadPublishedMarketplaceArtifactExplorer } from "./artifact-files.server";
import type { MarketplaceLayoutContext } from "./layout-context";
import {
  marketplaceListingManagePath,
  marketplaceListingPath,
  marketplaceListingRefSchema,
} from "./navigation";
import { marketplaceScopeFromRouteParams } from "./scope";

const dateFormatter = new Intl.DateTimeFormat("en-US", {
  month: "short",
  day: "numeric",
  year: "numeric",
  timeZone: "UTC",
});

const formatDate = (value: string) => dateFormatter.format(new Date(value));

type IngestionActionData =
  | { ok: false; message: string }
  | {
      ok: true;
      result: Exclude<MarketplaceIngestionRequestResult, { state: "failed" }>;
    };

type MarketplaceInstallationTarget =
  | {
      state: "ready";
      organizationId: string;
      targetScope: BackofficeRoutableScope;
    }
  | { state: "unavailable" | "forbidden"; message: string };

const resolveMarketplaceInstallationTarget = (
  me: AuthMeData,
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

export async function loader({ request, params, context, url }: Route.LoaderArgs) {
  const me = await getAuthMe(request, context);
  if (!me?.user) {
    return Response.redirect(
      new URL(buildBackofficeLoginPath(`${url.pathname}${url.search}`), request.url),
      302,
    );
  }

  const selectedScope = marketplaceScopeFromRouteParams(params);
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
  const marketplace = runtime.objects.marketplace.singleton();
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
  const [artifactFiles, ingestions] = await Promise.all([
    loadPublishedMarketplaceArtifactExplorer({
      manifest: artifactManifest,
      objects: runtime.objects,
      request,
      requestedPath: url.searchParams.get("artifactPath")?.trim() || undefined,
    }),
    installationOrganization
      ? runtime.objects.automations
          .forOrg(installationOrganization.id)
          .listMarketplaceIngestions({ targetScope: selectedScope })
          .then((records) =>
            records.filter(
              (ingestion) =>
                ingestion.listingId === detail.listing.listingId &&
                ingestion.targetScopeKey === selectedTargetScopeKey,
            ),
          )
      : Promise.resolve([]),
  ]);

  return {
    ...detail,
    manageOrganizationId: manageableOrganization?.organization.id ?? null,
    installationOrganizationId: installationOrganization?.id ?? null,
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
  const me = await getAuthMe(request, context);
  if (!me?.user) {
    throw redirect(buildBackofficeLoginPath(`${url.pathname}${url.search}`));
  }

  const listingIdResult = marketplaceListingRefSchema.safeParse(params.listingRef);
  if (!listingIdResult.success) {
    throw new Response("Not Found", { status: 404 });
  }

  const targetScope = marketplaceScopeFromRouteParams(params);
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
    .runtime.objects.automations.forOrg(installationTarget.organizationId);

  try {
    const result = await automations.requestMarketplaceIngestion({
      listingId: listingIdResult.data,
      targetScope: installationTarget.targetScope,
      version: String(formData.get("version") ?? "").trim() || undefined,
    });
    if (result.state === "failed") {
      return { ok: false, message: result.error.message } satisfies IngestionActionData;
    }
    return { ok: true, result } satisfies IngestionActionData;
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
    manageOrganizationId,
    nextVersionCursor,
    hasNextVersionPage,
    installationOrganizationId,
    artifactFiles,
    ingestions,
  } = loaderData;
  const actionData = useActionData<IngestionActionData>();
  const navigation = useNavigation();
  const location = useLocation();
  const search = new URLSearchParams(location.search);
  const publishedVersionParam = search.get("published");
  const publishedVersion = versions.some(({ version }) => version === publishedVersionParam)
    ? publishedVersionParam
    : null;
  const reusedPublication = publishedVersion !== null && search.get("reused") === "1";
  const hasOutdatedIngestion = ingestions.some((ingestion) => ingestion.outOfDate);
  const installationActionLabel = hasOutdatedIngestion
    ? "Update selected scope"
    : ingestions.length
      ? "Reinstall selected release"
      : "Add to selected scope";

  return (
    <div className="grid w-full gap-5 2xl:grid-cols-[minmax(0,1.35fr)_minmax(20rem,0.85fr)_minmax(20rem,0.65fr)]">
      <header className="bo-panel-surface flex h-full flex-col bg-[var(--bo-panel)] p-5 md:p-7">
        <div className="flex flex-col gap-5 lg:flex-row lg:items-start lg:justify-between">
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

          {manageOrganizationId ? (
            <Link
              to={marketplaceListingManagePath({
                listingId: listing.listingId,
                organizationId: manageOrganizationId,
              })}
              className="bo-control-surface inline-flex min-h-10 shrink-0 items-center justify-center bg-[var(--bo-panel)] px-4 text-[10px] font-semibold tracking-[0.18em] text-[var(--bo-muted)] uppercase transition-[scale,background-color,color,box-shadow] duration-150 ease-out hover:bg-[var(--bo-panel-2)] hover:text-[var(--bo-fg)] focus-visible:ring-2 focus-visible:ring-[color:var(--bo-accent)]/30 focus-visible:outline-none active:scale-[0.96]"
            >
              Manage listing
            </Link>
          ) : null}
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

        <div className="mt-auto pt-6">
          <dl className="grid gap-px bg-[var(--bo-border)] shadow-[0_0_0_1px_var(--bo-border)] sm:grid-cols-3">
            <ReleaseFact label="Latest version" value={listing.latestVersion} mono />
            <ReleaseFact label="Published" value={formatDate(listing.publishedAt)} />
            <ReleaseFact label="Publisher" value={listing.publisherName} />
          </dl>
        </div>
      </header>

      <div className="grid items-start gap-5 xl:grid-cols-[22rem_minmax(0,1fr)] 2xl:contents">
        <aside className="space-y-5 xl:sticky xl:top-[5.5rem] 2xl:contents 2xl:space-y-0">
          <section className="bo-panel-surface bg-[var(--bo-panel)] p-5">
            <PanelHeading
              title="Workspace installation"
              detail={ingestions.length ? `${ingestions.length} installed` : undefined}
            />
            <p className="mt-2 text-sm leading-6 text-pretty text-[var(--bo-muted)]">
              {ingestions.length
                ? "Manage the release installed in the selected Marketplace scope."
                : "Copy an immutable release into the selected Marketplace scope."}
            </p>

            {ingestions.length ? (
              <div className="mt-4 space-y-2">
                {ingestions.map((ingestion) => (
                  <div
                    key={`${ingestion.organizationName}:${ingestion.id}`}
                    className="bg-[var(--bo-panel-2)] p-3 shadow-[inset_0_0_0_1px_var(--bo-border)]"
                  >
                    <div className="flex items-start justify-between gap-3">
                      <p className="min-w-0 text-xs font-medium break-all text-[var(--bo-fg)]">
                        {ingestion.organizationName} · {ingestion.targetScopeKey}
                      </p>
                      <BackofficeStatusLight tone={ingestion.outOfDate ? "waiting" : "live"}>
                        {ingestion.outOfDate ? "Update" : "Current"}
                      </BackofficeStatusLight>
                    </div>
                    <p className="mt-2 font-mono text-[10px] text-[var(--bo-muted)]">
                      v{ingestion.version}
                      {ingestion.outOfDate ? ` → v${ingestion.latestVersion}` : " · latest"}
                    </p>
                  </div>
                ))}
              </div>
            ) : null}

            {hasOutdatedIngestion ? (
              <div className="mt-3 bg-[var(--bo-waiting-bg)] px-3 py-2.5 text-xs leading-5 text-[var(--bo-waiting)] shadow-[inset_0_0_0_1px_color-mix(in_srgb,var(--bo-waiting)_35%,transparent)]">
                Version {listing.latestVersion} is available. Select it below to update this scope.
              </div>
            ) : null}

            <div className="mt-5">
              {installationOrganizationId ? (
                <Form method="post" className="space-y-4">
                  <div>
                    <p className="text-[10px] font-semibold tracking-[0.14em] text-[var(--bo-muted-2)] uppercase">
                      Destination
                    </p>
                    <div className="bo-control-surface mt-2 bg-[var(--bo-panel-2)] px-3 py-3">
                      <p className="text-[9px] font-semibold tracking-[0.14em] text-[var(--bo-muted-2)] uppercase">
                        {selectedScope.kind === "org"
                          ? "Organisation"
                          : selectedScope.kind === "project"
                            ? "Project"
                            : "Personal"}
                      </p>
                      <p className="mt-1.5 truncate text-sm font-medium text-[var(--bo-fg)]">
                        {selectedScope.label}
                      </p>
                    </div>
                  </div>

                  <label className="block">
                    <span className="text-[10px] font-semibold tracking-[0.14em] text-[var(--bo-muted-2)] uppercase">
                      Release
                    </span>
                    <select
                      name="version"
                      defaultValue={listing.latestVersion}
                      className="mt-2 min-h-11 w-full border border-[color:var(--bo-border)] bg-[var(--bo-panel-2)] px-3 font-mono text-sm text-[var(--bo-fg)] transition-[border-color,box-shadow] duration-150 ease-out outline-none focus:border-[color:var(--bo-accent)] focus:ring-2 focus:ring-[color:var(--bo-accent)]/20"
                    >
                      {versions.map((version) => (
                        <option key={version.version} value={version.version}>
                          {version.version}
                        </option>
                      ))}
                    </select>
                  </label>

                  <button
                    type="submit"
                    disabled={navigation.state !== "idle"}
                    className="inline-flex min-h-11 w-full items-center justify-center bg-[var(--bo-accent)] px-4 text-[10px] font-semibold tracking-[0.16em] text-white uppercase shadow-[0_8px_20px_rgba(var(--bo-accent-rgb),0.2)] transition-[scale,background-color,box-shadow,opacity] duration-150 ease-out hover:bg-[var(--bo-accent-strong)] hover:shadow-[0_10px_24px_rgba(var(--bo-accent-rgb),0.26)] focus-visible:ring-2 focus-visible:ring-[color:var(--bo-accent)]/35 focus-visible:ring-offset-2 focus-visible:outline-none active:scale-[0.96] disabled:cursor-not-allowed disabled:opacity-50 disabled:shadow-none disabled:active:scale-100"
                  >
                    {navigation.state === "submitting" ? "Requesting…" : installationActionLabel}
                  </button>
                </Form>
              ) : (
                <p className="text-sm leading-6 text-pretty text-[var(--bo-muted)]">
                  Join an organization to install this automation into the selected scope.
                </p>
              )}

              {actionData ? (
                <div
                  className={`mt-4 px-3 py-2.5 text-xs leading-5 ${actionData.ok ? "bg-[var(--bo-live-bg)] text-[var(--bo-live)]" : "bg-[var(--bo-failed-bg)] text-[var(--bo-failed)]"}`}
                >
                  {actionData.ok
                    ? `Ingestion ${actionData.result.state} for ${marketplaceListingSlug(actionData.result.listingId)}@${actionData.result.version}. Workflow status: ${"workflowStatus" in actionData.result ? actionData.result.workflowStatus : "complete"}.`
                    : actionData.message}
                </div>
              ) : null}
            </div>
          </section>

          <section className="bo-panel-surface bg-[var(--bo-panel)] p-5">
            <PanelHeading
              title="Version history"
              detail={`${versions.length}${hasNextVersionPage ? "+" : ""} published`}
            />
            <div className="mt-4 space-y-2">
              {versions.map((version) => {
                const isLatest = version.version === listing.latestVersion;
                return (
                  <div
                    key={version.version}
                    className="flex items-center justify-between gap-4 bg-[var(--bo-panel-2)] px-3 py-3 shadow-[inset_0_0_0_1px_var(--bo-border)]"
                  >
                    <div className="min-w-0">
                      <p className="font-mono text-xs font-semibold text-[var(--bo-fg)]">
                        v{version.version}
                      </p>
                      <p className="mt-1 text-[10px] text-[var(--bo-muted-2)]">
                        {formatDate(version.publishedAt)}
                      </p>
                    </div>
                    {isLatest ? (
                      <BackofficeStatusLight tone="info">Latest</BackofficeStatusLight>
                    ) : null}
                  </div>
                );
              })}
            </div>
            {hasNextVersionPage && nextVersionCursor ? (
              <Link
                to={`${marketplaceListingPath(listing.listingId, selectedScope)}?versionCursor=${encodeURIComponent(nextVersionCursor)}`}
                className="bo-control-surface mt-3 flex min-h-10 items-center justify-center bg-[var(--bo-panel-2)] px-3 text-center text-[9px] font-semibold tracking-[0.16em] text-[var(--bo-muted)] uppercase transition-[scale,background-color,color,box-shadow] duration-150 ease-out hover:bg-[var(--bo-panel)] hover:text-[var(--bo-fg)] focus-visible:ring-2 focus-visible:ring-[color:var(--bo-accent)]/30 focus-visible:outline-none active:scale-[0.96]"
              >
                Browse older versions →
              </Link>
            ) : null}
          </section>
        </aside>

        <div className="min-w-0 space-y-5 2xl:contents 2xl:space-y-0">
          <div className="min-w-0 2xl:col-span-3">
            <MarketplaceArtifactFiles data={artifactFiles} />
          </div>
        </div>
      </div>
    </div>
  );
}

function PanelHeading({ title, detail }: { title: string; detail?: string }) {
  return (
    <div className="flex items-start justify-between gap-4">
      <h3 className="text-lg font-semibold tracking-tight text-balance text-[var(--bo-fg)]">
        {title}
      </h3>
      {detail ? (
        <span className="shrink-0 font-mono text-[9px] tracking-[0.1em] text-[var(--bo-muted-2)] uppercase">
          {detail}
        </span>
      ) : null}
    </div>
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

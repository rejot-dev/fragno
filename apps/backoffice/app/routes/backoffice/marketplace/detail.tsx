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
import { FormContainer } from "@/components/backoffice";
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
import type { MarketplaceLayoutContext } from "./layout-context";
import {
  marketplaceListingManagePath,
  marketplaceListingPath,
  marketplaceListingRefSchema,
} from "./navigation";
import { marketplaceScopeFromRouteParams } from "./scope";

const dateTimeFormatter = new Intl.DateTimeFormat("en-US", {
  month: "short",
  day: "numeric",
  year: "numeric",
  hour: "numeric",
  minute: "2-digit",
  timeZone: "UTC",
  timeZoneName: "short",
});

const formatDateTime = (value: string) => dateTimeFormatter.format(new Date(value));

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

  const marketplace = context.get(BackofficeWorkerContext).runtime.objects.marketplace.singleton();
  const detail = await marketplace.getPublishedListing({
    listingId: listingIdResult.data,
    versionCursor,
  });
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
  const ingestions = installationOrganization
    ? (
        await context
          .get(BackofficeWorkerContext)
          .runtime.objects.automations.forOrg(installationOrganization.id)
          .listMarketplaceIngestions()
      ).filter(
        (ingestion) =>
          ingestion.listingId === detail.listing.listingId &&
          ingestion.targetScopeKey === selectedTargetScopeKey,
      )
    : [];

  return {
    ...detail,
    manageOrganizationId: manageableOrganization?.organization.id ?? null,
    installationOrganizationId: installationOrganization?.id ?? null,
    ingestions: ingestions.map((ingestion) => ({
      ...ingestion,
      organizationName: installationOrganization?.name ?? installationOrganization?.id ?? "",
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

  return (
    <div className="max-w-7xl space-y-4">
      <header className="border border-[color:var(--bo-border)] bg-[var(--bo-panel)] p-5">
        <div className="flex flex-col gap-4 md:flex-row md:items-start md:justify-between">
          <div className="min-w-0">
            <p className="text-[10px] tracking-[0.22em] text-[var(--bo-muted-2)] uppercase">
              {listing.category}
            </p>
            <h2 className="mt-2 text-3xl font-semibold tracking-tight text-[var(--bo-fg)]">
              {listing.name}
            </h2>
            <p className="mt-2 max-w-3xl text-sm leading-6 text-[var(--bo-muted)]">
              {listing.summary}
            </p>
          </div>
          {manageOrganizationId ? (
            <Link
              to={marketplaceListingManagePath({
                listingId: listing.listingId,
                organizationId: manageOrganizationId,
              })}
              className="shrink-0 border border-[color:var(--bo-border)] bg-[var(--bo-panel-2)] px-4 py-2 text-[10px] font-semibold tracking-[0.22em] text-[var(--bo-muted)] uppercase transition-colors hover:border-[color:var(--bo-border-strong)] hover:text-[var(--bo-fg)]"
            >
              Manage
            </Link>
          ) : null}
        </div>
      </header>

      {publishedVersion ? (
        <div className="border border-emerald-400/40 bg-emerald-500/12 p-4 text-sm text-emerald-700 dark:text-emerald-200">
          {reusedPublication
            ? `Version ${publishedVersion} was already published.`
            : `Version ${publishedVersion} was published successfully.`}
        </div>
      ) : null}

      <div className="grid gap-4 xl:grid-cols-[20rem_minmax(0,1fr)]">
        <div className="space-y-4 xl:col-start-2 xl:row-start-1">
          <FormContainer
            eyebrow="About"
            title="Automation description"
            description="Review the published automation before adding it to a workspace."
          >
            <p className="max-w-3xl text-sm leading-7 whitespace-pre-wrap text-[var(--bo-muted)]">
              {listing.description}
            </p>
            {listing.tags.length ? (
              <div className="mt-5 flex flex-wrap gap-2">
                {listing.tags.map((tag) => (
                  <span
                    key={tag}
                    className="border border-[color:var(--bo-border)] bg-[var(--bo-panel-2)] px-2 py-1 font-mono text-[10px] text-[var(--bo-muted)]"
                  >
                    #{tag}
                  </span>
                ))}
              </div>
            ) : null}
          </FormContainer>
        </div>

        <aside className="flex flex-col gap-4 xl:col-start-1 xl:row-start-1">
          <section className="order-3 border border-[color:var(--bo-border)] bg-[var(--bo-panel)] p-4">
            <p className="text-[10px] tracking-[0.22em] text-[var(--bo-muted-2)] uppercase">
              Add to workspace
            </p>
            {installationOrganizationId ? (
              <Form method="post" className="mt-4 space-y-3">
                <div className="space-y-1">
                  <p className="text-xs text-[var(--bo-muted)]">Destination</p>
                  <div className="border border-[color:var(--bo-border)] bg-[var(--bo-panel-2)] px-3 py-2">
                    <p className="text-[9px] font-semibold tracking-[0.18em] text-[var(--bo-muted-2)] uppercase">
                      {selectedScope.kind === "org"
                        ? "Organisation"
                        : selectedScope.kind === "project"
                          ? "Project"
                          : "Personal"}
                    </p>
                    <p className="mt-1 truncate text-sm font-medium text-[var(--bo-fg)]">
                      {selectedScope.label}
                    </p>
                  </div>
                </div>
                <label className="block space-y-1">
                  <span className="text-xs text-[var(--bo-muted)]">Version</span>
                  <select
                    name="version"
                    defaultValue={listing.latestVersion}
                    className="w-full border border-[color:var(--bo-border)] bg-[var(--bo-panel-2)] px-3 py-2 font-mono text-sm text-[var(--bo-fg)]"
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
                  className="w-full border border-[color:var(--bo-accent)] bg-[var(--bo-accent)] px-3 py-2 text-xs font-semibold tracking-[0.12em] text-white uppercase disabled:opacity-50"
                >
                  {navigation.state === "submitting" ? "Requesting…" : "Add to selected scope"}
                </button>
              </Form>
            ) : (
              <p className="mt-3 text-sm text-[var(--bo-muted)]">
                Join an organization to install this automation into the selected scope.
              </p>
            )}
            {actionData ? (
              <p
                className={`mt-3 text-xs ${actionData.ok ? "text-emerald-600 dark:text-emerald-300" : "text-red-600 dark:text-red-300"}`}
              >
                {actionData.ok
                  ? `Ingestion ${actionData.result.state} for ${marketplaceListingSlug(actionData.result.listingId)}@${actionData.result.version}. Workflow status: ${"workflowStatus" in actionData.result ? actionData.result.workflowStatus : "complete"}.`
                  : actionData.message}
              </p>
            ) : null}
          </section>

          {ingestions.length ? (
            <section className="order-4 border border-[color:var(--bo-border)] bg-[var(--bo-panel)] p-4">
              <p className="text-[10px] tracking-[0.22em] text-[var(--bo-muted-2)] uppercase">
                Installed copies
              </p>
              <div className="mt-3 space-y-2">
                {ingestions.map((ingestion) => (
                  <div
                    key={`${ingestion.organizationName}:${ingestion.id}`}
                    className="border border-[color:var(--bo-border)] bg-[var(--bo-panel-2)] p-3 text-xs"
                  >
                    <p className="font-medium text-[var(--bo-fg)]">
                      {ingestion.organizationName} · {ingestion.targetScopeKey}
                    </p>
                    <p className="mt-1 font-mono text-[var(--bo-muted)]">v{ingestion.version}</p>
                  </div>
                ))}
              </div>
            </section>
          ) : null}

          <section className="order-1 border border-[color:var(--bo-border)] bg-[var(--bo-panel)] p-4">
            <p className="text-[10px] tracking-[0.22em] text-[var(--bo-muted-2)] uppercase">
              Latest release
            </p>
            <dl className="mt-4 space-y-3 text-sm">
              <MetadataRow label="Version" value={listing.latestVersion} mono />
              <MetadataRow label="Published" value={formatDateTime(listing.publishedAt)} />
              <MetadataRow label="Publisher" value={listing.publisherName} />
            </dl>
          </section>

          <section className="order-2 border border-[color:var(--bo-border)] bg-[var(--bo-panel)] p-4">
            <p className="text-[10px] tracking-[0.22em] text-[var(--bo-muted-2)] uppercase">
              Version history
            </p>
            <div className="mt-3 space-y-2">
              {versions.map((version) => (
                <div
                  key={version.version}
                  className="border border-[color:var(--bo-border)] bg-[var(--bo-panel-2)] p-3"
                >
                  <p className="font-mono text-xs font-semibold text-[var(--bo-fg)]">
                    v{version.version}
                  </p>
                  <p className="mt-1 text-[10px] text-[var(--bo-muted-2)]">
                    {formatDateTime(version.publishedAt)}
                  </p>
                </div>
              ))}
            </div>
            {hasNextVersionPage && nextVersionCursor ? (
              <Link
                to={`${marketplaceListingPath(listing.listingId, selectedScope)}?versionCursor=${encodeURIComponent(nextVersionCursor)}`}
                className="mt-3 block border border-[color:var(--bo-border)] bg-[var(--bo-panel-2)] px-3 py-2 text-center text-[9px] font-semibold tracking-[0.18em] text-[var(--bo-muted)] uppercase hover:border-[color:var(--bo-accent)]"
              >
                Older versions →
              </Link>
            ) : null}
          </section>
        </aside>
      </div>
    </div>
  );
}

function MetadataRow({
  label,
  value,
  mono = false,
}: {
  label: string;
  value: string;
  mono?: boolean;
}) {
  return (
    <div className="flex items-start justify-between gap-4">
      <dt className="text-[var(--bo-muted-2)]">{label}</dt>
      <dd
        className={
          mono
            ? "text-right font-mono text-xs break-all text-[var(--bo-fg)]"
            : "text-right text-[var(--bo-fg)]"
        }
      >
        {value}
      </dd>
    </div>
  );
}

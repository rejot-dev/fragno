import { ButtonLink } from "@fragno-private/design-system/button";
import { CopyButton } from "@fragno-private/design-system/copy-button";
import { BackofficeStatusLight } from "@fragno-private/design-system/status-light";
import {
  SurfaceFacts,
  SurfacePanel,
  SurfacePanelFooter,
  SurfaceTable,
  SurfaceTableRow,
  type SurfaceTableColumn,
} from "@fragno-private/design-system/surface-panel";
import { BackofficeSystemState } from "@fragno-private/design-system/system-state";
import { useLoaderData, useLocation } from "react-router";

import { buildAccessCodeSignUpUrl } from "@/fragno/access-codes/access-code";
import { getBackofficeObjects } from "@/worker-runtime/durable-objects";

import type { Route } from "./+types/access-code-redemptions";
import { ACCESS_CODE_STATUS_DISPLAY, formatAccessCodeDate } from "./access-codes-shared";

const REDEMPTIONS_PAGE_SIZE = 50;

const REDEMPTION_COLUMNS: SurfaceTableColumn[] = [
  { label: "Email", align: "start" },
  { label: "Signed up", align: "end" },
];

export async function loader({ context, params, url }: Route.LoaderArgs) {
  const cursor = url.searchParams.get("cursor");
  const listing = await getBackofficeObjects(context)
    .otp.singleton()
    .commands.listAccessCodeRedemptions({
      code: params.code,
      pagination:
        cursor === null
          ? { page: "first", pageSize: REDEMPTIONS_PAGE_SIZE }
          : { page: "next", cursor },
    });
  if (!listing.ok) {
    throw listing.reason === "not_found"
      ? new Response("Not Found", { status: 404 })
      : new Response("Invalid redemptions cursor.", { status: 400 });
  }
  return {
    ...listing,
    // This page is served from the origin people sign up at.
    signUpUrl: buildAccessCodeSignUpUrl(url.origin, listing.accessCode.code),
  };
}

export function meta({ loaderData }: Route.MetaArgs) {
  return [{ title: `${loaderData?.accessCode.label ?? "Access code"} · Backoffice Internals` }];
}

export default function BackofficeInternalAccessCodeRedemptions() {
  const { accessCode, page, signUpUrl } = useLoaderData<typeof loader>();
  const pathname = useLocation().pathname;
  const status = ACCESS_CODE_STATUS_DISPLAY[accessCode.status];

  return (
    <SurfacePanel
      caption={accessCode.label}
      actions={
        <>
          <BackofficeStatusLight tone={status.tone}>{status.label}</BackofficeStatusLight>
          <ButtonLink variant="secondary" to=".." relative="path">
            All codes
          </ButtonLink>
        </>
      }
    >
      <SurfaceFacts
        items={[
          {
            key: "code",
            label: "Code",
            value: (
              <span className="flex items-center gap-1">
                <code className="font-mono text-xs">{accessCode.code}</code>
                {accessCode.status === "active" ? (
                  <CopyButton value={signUpUrl} label="Copy sign-up link" text="Link" />
                ) : null}
              </span>
            ),
          },
          { key: "accounts", label: "Accounts", value: accessCode.redemptionCount },
          {
            key: "expires",
            label: "Expires",
            value:
              accessCode.expiresAt === null ? "Never" : formatAccessCodeDate(accessCode.expiresAt),
          },
          { key: "created", label: "Created", value: formatAccessCodeDate(accessCode.createdAt) },
        ]}
      />
      {page.redemptions.length === 0 ? (
        <BackofficeSystemState
          tone="empty"
          title="No accounts yet."
          description="Accounts created with this code appear here, newest first."
          flush
        />
      ) : (
        <SurfaceTable columns={REDEMPTION_COLUMNS}>
          {page.redemptions.map((redemption) => (
            <SurfaceTableRow
              key={redemption.email}
              columns={REDEMPTION_COLUMNS}
              cells={[
                <span key="email" className="break-all">
                  {redemption.email}
                </span>,
                <span key="redeemed" className="whitespace-nowrap">
                  {formatAccessCodeDate(redemption.redeemedAt)}
                </span>,
              ]}
            />
          ))}
        </SurfaceTable>
      )}
      {page.hasNextPage && page.cursor ? (
        <SurfacePanelFooter>
          <ButtonLink
            variant="secondary"
            to={`${pathname}?cursor=${encodeURIComponent(page.cursor)}`}
          >
            Older accounts
          </ButtonLink>
        </SurfacePanelFooter>
      ) : null}
    </SurfacePanel>
  );
}

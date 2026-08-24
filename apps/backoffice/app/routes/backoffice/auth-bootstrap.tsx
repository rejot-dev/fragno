import "../../backoffice.css";

import { useEffect, useState } from "react";
import { data, Link, redirect, useLoaderData } from "react-router";

import { FormContainer } from "@/components/backoffice";
import { getBackofficeMe } from "@/fragno/auth/auth-server";
import {
  readPreferredOrganization,
  writePreferredOrganization,
} from "@/fragno/auth/preferred-organization.client";
import { BackofficeSessionExchangeError } from "@/fragno/auth/session-exchange.client";

import type { Route } from "./+types/auth-bootstrap";
import {
  bootstrapBackofficePreferredOrganization,
  bootstrapBackofficeSession,
} from "./auth-bootstrap.client";
import {
  buildBackofficeLoginPath,
  readBackofficeOrganizationSwitchId,
  readBackofficeReturnTo,
  retargetBackofficeOrganizationReturnTo,
} from "./auth-navigation";

type BackofficeBootstrapLoaderData = {
  returnTo: string;
  organizationId: string | null;
};

export async function loader({ request, context, url }: Route.LoaderArgs) {
  if (import.meta.env.MODE !== "development") {
    throw new Response("Not Found", { status: 404 });
  }

  const returnTo = readBackofficeReturnTo(url);
  const organizationId = readBackofficeOrganizationSwitchId(url);
  const jwtMe = await getBackofficeMe(request, context);
  if (jwtMe.status === "authenticated") {
    const activeOrganizationId = jwtMe.me.activeOrganization?.organization.id ?? null;
    const hasConsistentOrganizationIdentity =
      jwtMe.me.activeOrganizationId === activeOrganizationId;
    if (
      hasConsistentOrganizationIdentity &&
      (!organizationId || activeOrganizationId === organizationId)
    ) {
      throw redirect(returnTo);
    }
  }

  return data({ returnTo, organizationId } satisfies BackofficeBootstrapLoaderData, {
    headers: { "Cache-Control": "no-store" },
  });
}

export function meta() {
  return [
    { title: "Preparing Fragno Backoffice" },
    { name: "description", content: "Preparing your Backoffice access." },
  ];
}

export default function BackofficeAuthBootstrap() {
  const { returnTo, organizationId } = useLoaderData<BackofficeBootstrapLoaderData>();
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    const bootstrap = organizationId
      ? bootstrapBackofficeSession(organizationId, writePreferredOrganization)
      : bootstrapBackofficePreferredOrganization(
          readPreferredOrganization(),
          writePreferredOrganization,
        );
    void bootstrap.then(
      (result) => {
        if (!active) {
          return;
        }
        window.location.replace(
          retargetBackofficeOrganizationReturnTo(returnTo, result.organization?.slug ?? null),
        );
      },
      (reason: unknown) => {
        if (!active) {
          return;
        }
        if (reason instanceof BackofficeSessionExchangeError && reason.status === 401) {
          window.location.replace(buildBackofficeLoginPath(returnTo));
          return;
        }
        setError(reason instanceof Error ? reason.message : "Unable to prepare the Backoffice.");
      },
    );
    return () => {
      active = false;
    };
  }, [organizationId, returnTo]);

  return (
    <div
      data-backoffice-root
      className="relative isolate min-h-screen bg-[var(--bo-bg)] text-[var(--bo-fg)]"
    >
      <div className="pointer-events-none absolute inset-0 bg-[linear-gradient(0deg,rgba(var(--bo-overlay),0.96),rgba(var(--bo-overlay),0.96)),linear-gradient(90deg,rgba(var(--bo-grid),0.45)_1px,transparent_1px),linear-gradient(0deg,rgba(var(--bo-grid),0.45)_1px,transparent_1px)] bg-[size:100%_100%,28px_28px,28px_28px]" />
      <div className="relative mx-auto flex min-h-screen max-w-5xl items-center justify-center px-4 py-8">
        <div className="w-full max-w-md">
          <FormContainer
            title="Preparing backoffice"
            description="Creating your organization-scoped Backoffice access."
            eyebrow="Bootstrap"
          >
            {error ? (
              <div className="space-y-3">
                <p className="text-sm text-red-400">{error}</p>
                <Link
                  to={buildBackofficeLoginPath(returnTo)}
                  className="inline-flex border border-[color:var(--bo-border)] bg-[var(--bo-panel)] px-4 py-2 text-[11px] font-semibold tracking-[0.22em] text-[var(--bo-muted)] uppercase transition-colors hover:border-[color:var(--bo-border-strong)] hover:text-[var(--bo-fg)]"
                >
                  Return to sign in
                </Link>
              </div>
            ) : (
              <p className="text-sm text-[var(--bo-muted)]">Opening backoffice…</p>
            )}
          </FormContainer>
        </div>
      </div>
    </div>
  );
}

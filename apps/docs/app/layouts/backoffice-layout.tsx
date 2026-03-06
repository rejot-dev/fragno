import type { ReactNode } from "react";
import { Link, Outlet, isRouteErrorResponse, useRouteError } from "react-router";
import { BackofficePageHeader, BackofficeShell } from "@/components/backoffice";
import type { Route } from "./+types/backoffice-layout";
import { getAuthMe } from "@/fragno/auth-server";
import "../backoffice.css";

export async function loader({ request, context }: Route.LoaderArgs) {
  if (import.meta.env.MODE !== "development") {
    throw new Response("Not Found", { status: 404 });
  }

  const me = await getAuthMe(request, context);
  if (!me?.user) {
    return Response.redirect(new URL("/backoffice/login", request.url), 302);
  }

  return { me };
}

export default function BackofficeLayout({
  children,
  loaderData,
}: {
  children?: ReactNode;
  loaderData: Route.ComponentProps["loaderData"];
}) {
  const { me } = loaderData;
  return (
    <BackofficeShell me={me} isLoading={false}>
      {children ?? <Outlet context={{ me }} />}
    </BackofficeShell>
  );
}

export type BackofficeLayoutContext = {
  me: NonNullable<Route.ComponentProps["loaderData"]["me"]>;
};

export function ErrorBoundary() {
  const error = useRouteError();
  const isResponse = isRouteErrorResponse(error);
  const status = isResponse ? error.status : null;
  const title =
    status === 404 ? "Page not found" : status ? "Request failed" : "Something went wrong";
  const description = isResponse
    ? typeof error.data === "string"
      ? error.data
      : "The requested backoffice page could not be loaded."
    : error instanceof Error
      ? error.message
      : "An unexpected error occurred while loading the backoffice.";

  return (
    <BackofficeShell me={null} isLoading={false}>
      <div className="space-y-4">
        <BackofficePageHeader
          breadcrumbs={[{ label: "Backoffice", to: "/backoffice" }, { label: "Error" }]}
          eyebrow="Backoffice"
          title={title}
          description={description}
          actions={
            <Link
              to="/backoffice"
              className="border border-[color:var(--bo-border)] bg-[var(--bo-panel-2)] px-3 py-2 text-[10px] font-semibold uppercase tracking-[0.22em] text-[var(--bo-muted)] transition-colors hover:border-[color:var(--bo-border-strong)] hover:text-[var(--bo-fg)]"
            >
              Back to dashboard
            </Link>
          }
        />
        {status ? (
          <div className="border border-[color:var(--bo-border)] bg-[var(--bo-panel)] p-4 text-sm text-[var(--bo-muted)]">
            Error code: {status}
          </div>
        ) : null}
      </div>
    </BackofficeShell>
  );
}

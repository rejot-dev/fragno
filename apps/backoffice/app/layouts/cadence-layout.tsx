import "../cadence.css";

import type { ReactNode } from "react";
import { Link, Outlet, isRouteErrorResponse, redirect, useRouteError } from "react-router";

import { CadencePageHeader, CadenceShell, CadenceGhostButton } from "@/components/cadence";
import type { AuthMeData } from "@/fragno/auth/auth-client";
import { getAuthMe } from "@/fragno/auth/auth-server";
import { buildBackofficeLoginPath } from "@/routes/backoffice/auth-navigation";
import { getRouteErrorDebugDetails } from "@/routes/backoffice/route-errors";

import type { Route } from "./+types/cadence-layout";

export const links: Route.LinksFunction = () => [
  { rel: "preconnect", href: "https://fonts.googleapis.com" },
  { rel: "preconnect", href: "https://fonts.gstatic.com", crossOrigin: "anonymous" },
  {
    rel: "stylesheet",
    href: "https://fonts.googleapis.com/css2?family=Plus+Jakarta+Sans:ital,wght@0,400;0,500;0,600;0,700;0,800;1,500;1,700&display=swap",
  },
];

export async function loader({ request, context }: Route.LoaderArgs) {
  const me = await getAuthMe(request, context);
  if (!me?.user) {
    // The login lives in the existing backoffice flow for now.
    throw redirect(buildBackofficeLoginPath());
  }
  return { me };
}

export type CadenceLayoutContext = {
  me: AuthMeData;
};

export default function CadenceLayout({
  children,
  loaderData,
}: {
  children?: ReactNode;
  loaderData: Route.ComponentProps["loaderData"];
}) {
  const { me } = loaderData;
  return (
    <CadenceShell me={me}>
      {children ?? <Outlet context={{ me } satisfies CadenceLayoutContext} />}
    </CadenceShell>
  );
}

export function ErrorBoundary() {
  const error = useRouteError();
  const isResponse = isRouteErrorResponse(error);
  const status = isResponse ? error.status : null;
  const title = status === 404 ? "Page not found" : "Something went wrong";
  const description = isResponse
    ? typeof error.data === "string"
      ? error.data
      : "This page could not be loaded."
    : error instanceof Error
      ? error.message
      : "An unexpected error occurred.";
  const debugDetails =
    import.meta.env.MODE === "development" ? getRouteErrorDebugDetails(error) : null;

  return (
    <CadenceShell me={null}>
      <CadencePageHeader
        eyebrow="Error"
        title={title}
        description={description}
        actions={
          <Link to="/">
            <CadenceGhostButton type="button">Back to Exec</CadenceGhostButton>
          </Link>
        }
      />
      {debugDetails ? (
        <details className="border border-[color:var(--cad-line)] bg-[var(--cad-panel)] p-4" open>
          <summary className="cad-eyebrow cursor-pointer text-[var(--cad-muted-2)]">
            Error details
          </summary>
          <pre className="cad-mono mt-3 max-h-[60vh] overflow-auto border border-[color:var(--cad-line)] bg-[var(--cad-bg-2)] p-3 text-xs whitespace-pre-wrap text-[var(--cad-fg)]">
            {debugDetails}
          </pre>
        </details>
      ) : null}
    </CadenceShell>
  );
}

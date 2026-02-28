import type { ReactNode } from "react";
import { Outlet } from "react-router";
import { BackofficeShell } from "@/components/backoffice";
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
  console.log("me", me);

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
      {children ?? <Outlet />}
    </BackofficeShell>
  );
}

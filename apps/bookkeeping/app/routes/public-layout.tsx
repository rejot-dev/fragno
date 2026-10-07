import { ButtonLink } from "@fragno-private/design-system/button";
import { Icon } from "@fragno-private/design-system/icon";
import { Link, Outlet, redirect } from "react-router";

import { getSession } from "../lib/session.server";
import type { Route } from "./+types/public-layout";

export async function loader({ request }: Route.LoaderArgs) {
  const session = await getSession(request);
  const pathname = new URL(request.url).pathname;
  if (session && (pathname === "/login" || pathname === "/signup")) {
    throw redirect("/dashboard");
  }
  return { user: session?.user ?? null };
}

export function headers() {
  return { "Cache-Control": "private, no-store" };
}

export default function PublicLayout({ loaderData }: Route.ComponentProps) {
  return (
    <div className="public-layout">
      <a className="skip-link" href="#main-content">
        Skip to content
      </a>
      <header className="public-header">
        <Link className="brand" to="/">
          <Icon name="book-open" className="size-6" />
          Bookkeeping
        </Link>
        <nav aria-label="Main navigation" className="flex items-center gap-2">
          {loaderData.user ? (
            <ButtonLink variant="solid" to="/dashboard">
              Open dashboard
            </ButtonLink>
          ) : (
            <>
              <ButtonLink variant="ghost" to="/login">
                Log in
              </ButtonLink>
              <ButtonLink variant="solid" to="/signup">
                Sign up
              </ButtonLink>
            </>
          )}
        </nav>
      </header>
      <main id="main-content" className="public-content">
        <Outlet context={{ user: loaderData.user }} />
      </main>
      <footer className="public-footer">
        <span>Bookkeeping</span>
        <span>A little more order. A little less overhead.</span>
      </footer>
    </div>
  );
}

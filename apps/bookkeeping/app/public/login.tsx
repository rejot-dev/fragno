import { Link, redirect } from "react-router";

import { getSessionUser, safeReturnTo } from "../auth/session.server";
import { SignInButton } from "../auth/sign-in-button";
import type { Route } from "./+types/login";

export function meta() {
  return [{ title: "Get started · Bookkeeping" }];
}

export async function loader({ request }: Route.LoaderArgs) {
  const params = new URL(request.url).searchParams;
  const returnTo = safeReturnTo(params.get("returnTo"));
  // Backoffice no longer accepts Bookkeeping's authorization, so a signed-in person signs in again.
  const reauthorize = params.has("reauthorize");
  if (!reauthorize && (await getSessionUser(request))) {
    throw redirect(returnTo);
  }
  return { returnTo, reauthorize };
}

export default function Login({ loaderData }: Route.ComponentProps) {
  return (
    <section className="auth">
      <h1>Get started</h1>
      <p>
        {loaderData.reauthorize
          ? "Sign in again to continue. "
          : "Sign in or create your account. "}
        We'll email you a code, so there's no password to remember.
      </p>
      <SignInButton returnTo={loaderData.returnTo} email={null} />
      <p>
        Trouble signing in? <Link to="/help">Get help</Link>
      </p>
    </section>
  );
}

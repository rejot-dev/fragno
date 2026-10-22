import { Link } from "react-router";

import { requireSessionUser } from "../auth/session.server";
import { SignOutButton } from "../auth/sign-out-button";
import type { Route } from "./+types/account";

export function meta() {
  return [{ title: "Account · Bookkeeping" }];
}

export async function loader({ request }: Route.LoaderArgs) {
  const { name, email } = await requireSessionUser(request);
  return { name, email };
}

/** Who is signed in, and logging out, from every area's header. */
export default function Account({ loaderData }: Route.ComponentProps) {
  return (
    <section className="auth">
      <h1>Your account</h1>
      <p>
        You're signed in as {loaderData.name} ({loaderData.email}).
      </p>
      <SignOutButton then="/login" />
      <p>
        <Link to="/start">Back to Bookkeeping</Link>
      </p>
    </section>
  );
}

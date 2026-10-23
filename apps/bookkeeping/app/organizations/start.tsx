import { env } from "cloudflare:workers";
import { Link, redirect } from "react-router";

import { requireSessionUser } from "../auth/session.server";
import { invitedTo } from "../invitations/invited-to";
import { MODE_GROUP_LABELS, MODES } from "../shell/modes";
import { listPlaces } from "../shell/shell.server";
import type { Route } from "./+types/start";
import { highestRole, ROLE_LABELS } from "./roles";

export function meta() {
  return [{ title: "Start · Bookkeeping" }];
}

/**
 * Where signing in lands: the person's only place, or a choice between them, grouped by mode, and
 * the invitations to their address, for someone who signed in without opening the email. The
 * header's switcher lists the same places.
 */
export async function loader({ request }: Route.LoaderArgs) {
  const user = await requireSessionUser(request);
  const places = await listPlaces(user);
  const invitations = await env.DIRECTORY.getByName("directory").listInvitationsTo(
    user.email,
    Date.now(),
  );
  if (places.length === 1 && invitations.length === 0) {
    throw redirect(places[0].path);
  }
  return {
    email: user.email,
    places,
    invitations: invitations.map((invitation) => ({
      path: `/invitations/${invitation.id}`,
      invitedTo: invitedTo(invitation.organization),
      role: ROLE_LABELS[highestRole(invitation.roles)].toLowerCase(),
      invitedBy: invitation.invitedBy,
    })),
  };
}

export function headers() {
  return { "Cache-Control": "private, no-store" };
}

export default function Start({ loaderData }: Route.ComponentProps) {
  const { email, places, invitations } = loaderData;
  if (places.length === 0 && invitations.length === 0) {
    return (
      <section className="auth">
        <h1>No access yet</h1>
        <p>
          You're signed in as {email}, but no one has added you to a firm or a client yet. Ask the
          firm that keeps your books to invite you.
        </p>
      </section>
    );
  }
  return (
    <section className="auth">
      <h1>Where to?</h1>
      {invitations.length > 0 && (
        <div className="space-y-2">
          <h2>Invitations</h2>
          <ul className="space-y-1">
            {invitations.map(({ path, invitedTo, role, invitedBy }) => (
              <li key={path}>
                <Link to={path}>
                  Join {invitedTo} as {role}
                </Link>{" "}
                <span className="text-sm text-[var(--bo-muted)]">from {invitedBy}</span>
              </li>
            ))}
          </ul>
        </div>
      )}
      {MODES.map((mode) => {
        const inMode = places.filter((place) => place.mode === mode);
        return inMode.length === 0 ? null : (
          <div key={mode} className="space-y-2">
            <h2>{MODE_GROUP_LABELS[mode]}</h2>
            <ul className="space-y-1">
              {inMode.map(({ name, path }) => (
                <li key={path}>
                  <Link to={path}>{name}</Link>
                </li>
              ))}
            </ul>
          </div>
        );
      })}
    </section>
  );
}

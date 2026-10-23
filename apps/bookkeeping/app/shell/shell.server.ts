import { env } from "cloudflare:workers";

import type { SessionUser } from "../../workers/auth/auth";
import { organizationPath } from "../organizations/paths";
import type { Place } from "./modes";

/**
 * Everywhere the person can go: the organizations Bookkeeping has recorded them in, the operators
 * first. Installed apps cannot ask Backoffice for someone's organizations, so this is Bookkeeping's
 * own record; each organization confirms membership again when it opens.
 */
export async function listPlaces(user: SessionUser): Promise<Place[]> {
  const memberships = await env.DIRECTORY.getByName("directory").listMemberships(
    user.backofficeUserId,
  );
  return memberships.map(({ organization: { name, kind, slug } }) => ({
    mode: kind,
    name,
    path: organizationPath(kind, slug),
  }));
}

/** What every area's frame needs: where the person is, where else they can go, and who they are. */
export type ShellData = {
  place: Place;
  places: Place[];
  user: { name: string; email: string; role: string };
};

export async function loadShell(user: SessionUser, place: Place, role: string): Promise<ShellData> {
  return {
    place,
    places: await listPlaces(user),
    user: { name: user.name, email: user.email, role },
  };
}

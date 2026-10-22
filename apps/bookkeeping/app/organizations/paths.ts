import type { OrganizationKind } from "../../workers/directory/directory";

/** Where an organization opens: a firm's dashboard, or a client's workspace. */
export function organizationPath(kind: OrganizationKind, slug: string): string {
  return kind === "firm" ? `/f/${slug}` : `/w/${slug}`;
}

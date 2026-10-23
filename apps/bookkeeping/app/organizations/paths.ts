import type { OrganizationKind } from "../../workers/directory/directory";

/** Where an organization opens: the operators' firms, a firm's dashboard, or a client's workspace. */
export function organizationPath(kind: OrganizationKind, slug: string): string {
  if (kind === "operator") {
    return "/operator";
  }
  return kind === "firm" ? `/f/${slug}` : `/w/${slug}`;
}

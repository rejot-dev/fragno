/**
 * The slug an organization's name suggests. Auth appends a number when another organization
 * already has it, so the stored slug may differ from this preview.
 */
export function organizationSlugFromName(name: string): string {
  const slug = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return slug || "organization";
}

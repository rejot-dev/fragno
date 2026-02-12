import type { AutoCreateOrganizationConfig, OrganizationRoleName } from "./types";

export const ORGANIZATION_SLUG_REGEX = /^[a-z0-9][a-z0-9-]{2,62}$/;

export const DEFAULT_CREATOR_ROLES = ["owner"] as const;
export const DEFAULT_MEMBER_ROLES = ["member"] as const;

export function slugifyOrganizationName(value: string): string {
  return value
    .toLowerCase()
    .trim()
    .replace(/['"]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .replace(/--+/g, "-");
}

export function normalizeOrganizationSlug(value: string): string | null {
  if (!value || !value.trim()) {
    return null;
  }
  const slug = slugifyOrganizationName(value);
  if (!ORGANIZATION_SLUG_REGEX.test(slug)) {
    return null;
  }
  return slug;
}

export function normalizeRoleNames<TRole extends string>(
  roles: readonly TRole[] | undefined | null,
  fallback: readonly TRole[],
): OrganizationRoleName<TRole>[] {
  const base = roles && roles.length > 0 ? roles : fallback;
  const unique = new Set(base.map((role) => String(role).trim()).filter(Boolean));
  return Array.from(unique) as OrganizationRoleName<TRole>[];
}

export function buildDefaultOrganizationName(email: string): string {
  const localPart = email.split("@")[0] ?? "";
  const safeLocalPart = localPart.trim() || "user";
  return `${safeLocalPart}'s Organization`;
}

export function buildAutoOrganizationInput(
  config: AutoCreateOrganizationConfig | undefined,
  ctx: { userId: string; email: string },
): {
  name: string;
  slug: string | null;
  logoUrl: string | null | undefined;
  metadata: Record<string, unknown> | null | undefined;
} {
  const name = config?.name?.(ctx) ?? buildDefaultOrganizationName(ctx.email);
  const rawSlug = config?.slug?.(ctx) ?? name;
  return {
    name,
    slug: normalizeOrganizationSlug(rawSlug),
    logoUrl: config?.logoUrl?.(ctx),
    metadata: config?.metadata?.(ctx),
  };
}

export function toExternalId(value: unknown): string {
  if (value && typeof value === "object" && "externalId" in value) {
    const externalId = (value as { externalId?: string }).externalId;
    if (externalId) {
      return externalId;
    }
  }
  return String(value);
}

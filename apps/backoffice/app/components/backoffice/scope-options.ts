import type { BackofficeResolvedScope } from "@/backoffice-runtime/resolved-scope";
import type { BackofficeMeData, Organization } from "@/fragno/auth/contracts";

/** A scope the signed-in user can switch to, with the label scope pickers show for it. */
export type BackofficeScopeOption = {
  label: string;
  scope: BackofficeResolvedScope<Organization>;
};

/** The system scope for administrators, each of the user's organizations, then their own. */
export function backofficeScopeOptions(me: BackofficeMeData): BackofficeScopeOption[] {
  return [
    ...(me.user.role === "admin" ? [{ label: "System", scope: { kind: "system" as const } }] : []),
    ...me.organizations.map(({ organization }) => ({
      label: organization.name,
      scope: { kind: "org" as const, organization },
    })),
    {
      label: me.user.email ?? me.user.id,
      scope: { kind: "user" as const, userId: me.user.id },
    },
  ];
}

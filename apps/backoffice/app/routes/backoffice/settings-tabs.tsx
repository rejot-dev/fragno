import { BackofficeTabHeader } from "@fragno-private/design-system/tab-header";

/** Both settings pages open with these tabs, so moving between them keeps the content in place. */
/** The user's own settings, which the sidebar's Settings opens in their personal workspace. */
export function SettingsTabs({
  active,
}: {
  active: "permissions" | "organizations" | "usage" | "applications";
}) {
  return (
    <BackofficeTabHeader
      items={[
        {
          id: "permissions",
          label: "My permissions",
          to: "/backoffice/settings",
          active: active === "permissions",
        },
        {
          id: "organizations",
          label: "Organizations",
          to: "/backoffice/organizations",
          active: active === "organizations",
        },
        {
          id: "usage",
          label: "Usage",
          to: "/backoffice/usage",
          active: active === "usage",
        },
        {
          id: "applications",
          label: "Authorized applications",
          to: "/backoffice/settings/authorized-applications",
          active: active === "applications",
        },
      ]}
      ariaLabel="Settings sections"
      trailing={null}
      options={null}
    />
  );
}

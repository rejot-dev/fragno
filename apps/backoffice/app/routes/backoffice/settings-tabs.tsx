import { BackofficeTabHeader } from "@fragno-private/design-system/tab-header";

/** Both settings pages open with these tabs, so moving between them keeps the content in place. */
export function SettingsTabs({ active }: { active: "permissions" | "applications" }) {
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

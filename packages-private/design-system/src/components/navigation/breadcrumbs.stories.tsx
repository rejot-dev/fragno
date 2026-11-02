import { BackofficeBreadcrumbs } from "./breadcrumbs";

export default { title: "Navigation/Breadcrumbs" };

export function Trail() {
  return (
    <BackofficeBreadcrumbs
      items={[
        { label: "Organization", to: "/org" },
        { label: "Automations", to: "/org/automations" },
        { label: "Nightly sync" },
      ]}
    />
  );
}

// A leading "Backoffice" crumb is dropped because the shell already names the product.
export function DropsLeadingBackoffice() {
  return (
    <BackofficeBreadcrumbs
      items={[
        { label: "Backoffice", to: "/" },
        { label: "Settings", to: "/settings" },
        { label: "Billing" },
      ]}
    />
  );
}

import { BackofficePageHeader } from "./page-header";

export default { title: "Layout/Page header" };

export function Default() {
  return (
    <BackofficePageHeader
      title="Automations"
      description="Scripts and workflows that run on routes, schedules, and events."
      breadcrumbs={[{ label: "Organization", to: "/org" }, { label: "Automations" }]}
    />
  );
}

export function WithEyebrowCodeAndActions() {
  return (
    <BackofficePageHeader
      title="Nightly sync"
      eyebrow="Workflow"
      code="AUT-014"
      description="Pulls invoices from Stripe and files them in the shared drive."
      breadcrumbs={[
        { label: "Organization", to: "/org" },
        { label: "Automations", to: "/org/automations" },
        { label: "Nightly sync" },
      ]}
      actions={
        <button
          type="button"
          className="inline-flex min-h-10 items-center bg-[var(--bo-btn-bg)] px-4 text-xs font-semibold text-[var(--bo-btn-fg)] hover:bg-[var(--bo-btn-bg-hover)]"
        >
          Run now
        </button>
      }
    />
  );
}

import { BackofficePageHeader } from "@/components/backoffice";

export default function BackofficeNotFound() {
  return (
    <div className="space-y-4">
      <BackofficePageHeader
        breadcrumbs={[{ label: "Backoffice", to: "/backoffice" }, { label: "Not found" }]}
        eyebrow="Backoffice"
        title="Page not found"
        description="This backoffice route does not exist."
      />

      <div className="border border-[color:var(--bo-border)] bg-[var(--bo-panel)] p-4 text-sm text-[var(--bo-muted)]">
        Double-check the URL or use the backoffice navigation to find the page you need.
      </div>
    </div>
  );
}

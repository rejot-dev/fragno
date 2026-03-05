import { Link } from "react-router";
import { BackofficePageHeader } from "@/components/backoffice";

export default function BackofficeNotFound() {
  return (
    <div className="space-y-4">
      <BackofficePageHeader
        breadcrumbs={[{ label: "Backoffice", to: "/backoffice" }, { label: "Not found" }]}
        eyebrow="Backoffice"
        title="Page not found"
        description="This backoffice route does not exist."
        actions={
          <Link
            to="/backoffice"
            className="border border-[color:var(--bo-border)] bg-[var(--bo-panel-2)] px-3 py-2 text-[10px] font-semibold uppercase tracking-[0.22em] text-[var(--bo-muted)] transition-colors hover:border-[color:var(--bo-border-strong)] hover:text-[var(--bo-fg)]"
          >
            Back to dashboard
          </Link>
        }
      />

      <div className="border border-[color:var(--bo-border)] bg-[var(--bo-panel)] p-4 text-sm text-[var(--bo-muted)]">
        Double-check the URL or use the backoffice navigation to find the page you need.
      </div>
    </div>
  );
}

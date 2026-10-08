import { Button } from "@fragno-private/design-system/button";
import { FormContainer, FormField } from "@fragno-private/design-system/form-container";
import { Input } from "@fragno-private/design-system/input";
import { BackofficePageHeader } from "@fragno-private/design-system/page-header";
import { BackofficeStatusLight } from "@fragno-private/design-system/status-light";
import { useState } from "react";

import { authClient } from "../lib/auth-client";

export function meta() {
  return [{ title: "Organizations · Bookkeeping" }];
}

function slugify(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/gu, "-")
    .replace(/^-|-$/gu, "");
}

export default function Organizations() {
  const organizations = authClient.useListOrganizations();
  const active = authClient.useActiveOrganization();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  return (
    <div className="space-y-6">
      <BackofficePageHeader
        title="Organizations"
        description="Keep books together with your team. The active organization is used everywhere in Bookkeeping."
        breadcrumbs={[{ label: "Bookkeeping", to: "/dashboard" }, { label: "Organizations" }]}
      />
      <div className="max-w-2xl space-y-6">
        <FormContainer title="Your organizations">
          {organizations.isPending ? (
            <p className="text-sm text-[var(--bo-muted)]">Loading…</p>
          ) : organizations.data?.length ? (
            <ul className="divide-y divide-[var(--bo-border)]">
              {organizations.data.map((organization) => (
                <li key={organization.id} className="flex items-center justify-between gap-3 py-3">
                  <span className="text-sm font-medium">{organization.name}</span>
                  {active.data?.id === organization.id ? (
                    <BackofficeStatusLight tone="live">Active</BackofficeStatusLight>
                  ) : (
                    <Button
                      variant="ghost"
                      type="button"
                      onClick={async () => {
                        await authClient.organization.setActive({
                          organizationId: organization.id,
                        });
                        window.location.reload();
                      }}
                    >
                      Make active
                    </Button>
                  )}
                </li>
              ))}
            </ul>
          ) : (
            <p className="text-sm text-[var(--bo-muted)]">
              You don't belong to any organizations yet.
            </p>
          )}
        </FormContainer>
        <FormContainer title="Create an organization" description="You become its owner.">
          <form
            className="space-y-4"
            onSubmit={async (event) => {
              event.preventDefault();
              const name = String(new FormData(event.currentTarget).get("name")).trim();
              setPending(true);
              setError(null);
              try {
                const created = await authClient.organization.create({ name, slug: slugify(name) });
                if (created.error) {
                  setError(created.error.message ?? "Could not create the organization.");
                  return;
                }
                await authClient.organization.setActive({ organizationId: created.data.id });
                window.location.reload();
              } catch {
                setError("Could not connect. Please try again.");
              } finally {
                setPending(false);
              }
            }}
          >
            <FormField label="Name">
              <Input
                className="w-full focus-visible:ring-2 focus-visible:ring-[var(--bo-accent)]/30"
                name="name"
                required
              />
            </FormField>
            {error && (
              <p role="alert" className="text-sm text-[var(--bo-failed)]">
                {error}
              </p>
            )}
            <Button type="submit" variant="accent" disabled={pending}>
              {pending ? "Creating…" : "Create organization"}
            </Button>
          </form>
        </FormContainer>
      </div>
    </div>
  );
}

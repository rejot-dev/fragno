import { useEffect, useState, type FormEvent } from "react";
import { useOutletContext } from "react-router";

import { FormContainer, FormField } from "@/components/backoffice";
import { authClient } from "@/fragno/auth/auth-client";

import type { OrganisationLayoutContext } from "./organisation-layout";
import {
  Notice,
  type ActionNotice,
  formatDate,
  formatRoles,
  getErrorMessage,
} from "./organisation-shared";

export function meta() {
  return [{ title: "Organisation Overview" }];
}

export default function BackofficeOrganisationOverview() {
  const { organization, member, me } = useOutletContext<OrganisationLayoutContext>();
  const currentUserRole = me.user.role;
  const isActive = me.activeOrganization?.organization.id === organization.id;
  const canManageOrganization =
    currentUserRole === "admin" ||
    member.roles.some((role) => role === "owner" || role === "admin");

  const {
    mutate: updateOrganization,
    loading: updatingOrganization,
    error: updateOrganizationError,
  } = authClient.useUpdateOrganization();

  const [nameInput, setNameInput] = useState(organization.name);
  const [nameNotice, setNameNotice] = useState<ActionNotice>(null);

  useEffect(() => {
    setNameInput(organization.name);
    setNameNotice(null);
  }, [organization.id, organization.name]);

  const handleNameSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setNameNotice(null);

    const nextName = nameInput.trim();
    if (!nextName) {
      setNameNotice({ type: "error", message: "Organisation name is required." });
      return;
    }

    try {
      await updateOrganization({
        path: { organizationId: organization.id },
        body: { name: nextName },
      });
      setNameNotice({ type: "success", message: "Organisation name updated." });
    } catch (error) {
      setNameNotice({ type: "error", message: getErrorMessage(error) });
    }
  };

  const nameDirty = nameInput.trim() !== organization.name;
  const nameValid = nameInput.trim().length > 0;

  return (
    <div className="space-y-4">
      <FormContainer
        eyebrow="Overview"
        title={organization.name}
        description="Review core organisation details and admin status."
      >
        <div className="grid gap-3 text-sm sm:grid-cols-2">
          <div>
            <p className="text-[10px] tracking-[0.22em] text-[var(--bo-muted-2)] uppercase">Slug</p>
            <p className="mt-1 font-semibold text-[var(--bo-fg)]">{organization.slug}</p>
          </div>
          <div>
            <p className="text-[10px] tracking-[0.22em] text-[var(--bo-muted-2)] uppercase">
              Status
            </p>
            <p className="mt-1 font-semibold text-[var(--bo-fg)]">{isActive ? "Active" : "Idle"}</p>
          </div>
          <div>
            <p className="text-[10px] tracking-[0.22em] text-[var(--bo-muted-2)] uppercase">
              Your roles
            </p>
            <p className="mt-1 font-semibold text-[var(--bo-fg)]">{formatRoles(member.roles)}</p>
          </div>
          <div>
            <p className="text-[10px] tracking-[0.22em] text-[var(--bo-muted-2)] uppercase">
              Created
            </p>
            <p className="mt-1 font-semibold text-[var(--bo-fg)]">
              {formatDate(organization.createdAt)}
            </p>
          </div>
        </div>
      </FormContainer>

      <FormContainer
        eyebrow="Identity"
        title="Rename organisation"
        description="Update the name shown across dashboards and invitations."
      >
        <form onSubmit={handleNameSubmit} className="space-y-3">
          <FormField label="Organisation name">
            <input
              type="text"
              value={nameInput}
              onChange={(event) => {
                setNameInput(event.target.value);
                setNameNotice(null);
              }}
              disabled={!canManageOrganization}
              className="w-full border border-[color:var(--bo-border)] bg-[var(--bo-panel-2)] px-3 py-2 text-sm text-[var(--bo-fg)] focus:border-[color:var(--bo-accent)] focus:ring-2 focus:ring-[color:var(--bo-accent)]/20 focus:outline-none disabled:opacity-60"
            />
          </FormField>
          <div className="flex flex-wrap items-center gap-2">
            <button
              type="submit"
              disabled={!canManageOrganization || !nameDirty || !nameValid || updatingOrganization}
              className="border border-[color:var(--bo-accent)] bg-[var(--bo-accent-bg)] px-3 py-2 text-[10px] font-semibold tracking-[0.22em] text-[var(--bo-accent-fg)] uppercase transition-colors hover:border-[color:var(--bo-accent-strong)] disabled:opacity-60"
            >
              {updatingOrganization ? "Saving..." : "Save name"}
            </button>
            {updateOrganizationError ? (
              <span className="text-xs text-red-600">
                {getErrorMessage(updateOrganizationError)}
              </span>
            ) : null}
            {!canManageOrganization ? (
              <span className="text-xs text-[var(--bo-muted-2)]">
                Admin or owner access required.
              </span>
            ) : null}
          </div>
          <Notice notice={nameNotice} />
        </form>
      </FormContainer>
    </div>
  );
}

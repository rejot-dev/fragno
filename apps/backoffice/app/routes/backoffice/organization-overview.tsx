import { Button } from "@fragno-private/design-system/button";
import { FormContainer, FormField } from "@fragno-private/design-system/form-container";
import { Input } from "@fragno-private/design-system/input";
import { useEffect, useState, type SubmitEvent } from "react";
import { useOutletContext } from "react-router";

import { authClient } from "@/fragno/auth/auth-client";

import type { OrganizationLayoutContext } from "./organization-layout";
import { Notice } from "./organization-shared";
import { type ActionNotice, formatDate, formatRoles, getErrorMessage } from "./organization-utils";

export function meta() {
  return [{ title: "Organization Overview" }];
}

export default function BackofficeOrganizationOverview() {
  const { organization, member, me } = useOutletContext<OrganizationLayoutContext>();
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

  const handleNameSubmit = async (event: SubmitEvent<HTMLFormElement>) => {
    event.preventDefault();
    setNameNotice(null);

    const nextName = nameInput.trim();
    if (!nextName) {
      setNameNotice({ type: "error", message: "Organization name is required." });
      return;
    }

    try {
      await updateOrganization({
        path: { organizationId: organization.id },
        body: { name: nextName },
      });
      setNameNotice({ type: "success", message: "Organization name updated." });
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
        description="Review core organization details and admin status."
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
        title="Rename organization"
        description="Update the name shown across dashboards and invitations."
      >
        <form onSubmit={(event) => void handleNameSubmit(event)} className="space-y-3">
          <FormField label="Organization name">
            <Input
              type="text"
              value={nameInput}
              onChange={(event) => {
                setNameInput(event.target.value);
                setNameNotice(null);
              }}
              disabled={!canManageOrganization}
              className="w-full"
            />
          </FormField>
          <div className="flex flex-wrap items-center gap-2">
            <Button
              variant="accent"
              type="submit"
              disabled={!canManageOrganization || !nameDirty || !nameValid || updatingOrganization}
            >
              {updatingOrganization ? "Saving..." : "Save name"}
            </Button>
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

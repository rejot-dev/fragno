import { Button } from "@fragno-private/design-system/button";
import { Field } from "@fragno-private/design-system/field";
import { Input } from "@fragno-private/design-system/input";
import { BackofficeStatusLight } from "@fragno-private/design-system/status-light";
import {
  SurfaceFacts,
  SurfacePanel,
  SurfacePanelBody,
} from "@fragno-private/design-system/surface-panel";
import { useEffect, useState, type SubmitEvent } from "react";
import { useOutletContext, useRevalidator } from "react-router";

import { authClient } from "@/fragno/auth/auth-client";

import type { OrganizationLayoutContext } from "./organization-layout";
import { Notice } from "./organization-shared";
import { type ActionNotice, formatDate, formatRoles, getErrorMessage } from "./organization-utils";

export function meta() {
  return [{ title: "Organization Overview" }];
}

export default function BackofficeOrganizationOverview() {
  const { organization, member, me } = useOutletContext<OrganizationLayoutContext>();
  const revalidator = useRevalidator();
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
      await revalidator.revalidate();
      setNameNotice({ type: "success", message: "Organization name updated." });
    } catch (error) {
      setNameNotice({ type: "error", message: getErrorMessage(error) });
    }
  };

  const nameDirty = nameInput.trim() !== organization.name;
  const nameValid = nameInput.trim().length > 0;

  return (
    <>
      <SurfacePanel
        caption="Organization"
        actions={
          <BackofficeStatusLight tone={isActive ? "live" : "muted"}>
            {isActive ? "Active" : "Idle"}
          </BackofficeStatusLight>
        }
      >
        <SurfaceFacts
          items={[
            { key: "name", label: "Name", value: organization.name },
            { key: "slug", label: "Slug", value: organization.slug },
            { key: "roles", label: "Your roles", value: formatRoles(member.roles) },
            { key: "created", label: "Created", value: formatDate(organization.createdAt) },
          ]}
        />
      </SurfacePanel>

      <SurfacePanel caption="Rename organization" actions={null}>
        <SurfacePanelBody>
          <form
            onSubmit={(event) => void handleNameSubmit(event)}
            className="flex max-w-xl flex-col gap-3"
          >
            <Field
              label="Organization name"
              description="Shown across dashboards and invitations. The slug stays the same."
            >
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
            </Field>
            <div className="flex flex-wrap items-center gap-3">
              <Button
                variant="accent"
                type="submit"
                disabled={
                  !canManageOrganization || !nameDirty || !nameValid || updatingOrganization
                }
              >
                {updatingOrganization ? "Saving…" : "Save name"}
              </Button>
              {!canManageOrganization ? (
                <span className="text-xs text-[var(--bo-muted-2)]">
                  Admin or owner access required.
                </span>
              ) : null}
            </div>
            {updateOrganizationError && !nameNotice ? (
              <Notice
                notice={{ type: "error", message: getErrorMessage(updateOrganizationError) }}
              />
            ) : (
              <Notice notice={nameNotice} />
            )}
          </form>
        </SurfacePanelBody>
      </SurfacePanel>
    </>
  );
}

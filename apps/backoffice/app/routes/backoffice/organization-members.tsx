import { Button } from "@fragno-private/design-system/button";
import { Checkbox } from "@fragno-private/design-system/checkbox";
import { cn } from "@fragno-private/design-system/cn";
import { Input } from "@fragno-private/design-system/input";
import {
  SurfacePanel,
  SurfacePanelFooter,
  SurfaceTable,
  SurfaceTableRow,
  type SurfaceTableColumn,
} from "@fragno-private/design-system/surface-panel";
import { BackofficeSystemState } from "@fragno-private/design-system/system-state";
import { usePostHog } from "@posthog/react/slim";
import { useEffect, useMemo, useState } from "react";
import {
  Link,
  useLoaderData,
  useNavigation,
  useOutletContext,
  useRevalidator,
  useSearchParams,
} from "react-router";

import { authClient } from "@/fragno/auth/auth-client";
import { loadOrganizationMembers } from "@/fragno/auth/auth-directory.server";
import { administersMembers } from "@/fragno/auth/contracts";

import type { Route } from "./+types/organization-members";
import { dashboardPath } from "./dashboard/path";
import type { OrganizationLayoutContext } from "./organization-layout";
import { ROLE_OPTIONS, formatDate, formatRoles, getErrorMessage } from "./organization-utils";

export async function loader({ request, context, params }: Route.LoaderArgs) {
  return await loadOrganizationMembers({ request, context }, params.orgSlug);
}

type OrganizationMember = Awaited<ReturnType<typeof loader>>["members"][number];

type ActionNotice = {
  type: "success" | "error";
  message: string;
} | null;

export function meta() {
  return [{ title: "Organization Members" }];
}

const MEMBER_COLUMNS: readonly SurfaceTableColumn[] = [
  { label: "Member", align: "start" },
  { label: "Roles", align: "start" },
  { label: "Joined", align: "start" },
];

export default function BackofficeOrganizationMembers() {
  const posthog = usePostHog();
  const { organization, member, me } = useOutletContext<OrganizationLayoutContext>();
  const currentUserId = me.user.id;
  const administersOrganization = administersMembers(member.roles);
  const canManageMembers = me.user.role === "admin" || administersOrganization;

  const membersData = useLoaderData<typeof loader>();
  const members = membersData.members;
  const membersPage = membersData.page;
  const membersLoading = useNavigation().state !== "idle";
  const [, setSearchParams] = useSearchParams();
  const revalidator = useRevalidator();
  const [memberSearch, setMemberSearch] = useState("");

  const { mutate: updateMemberRoles } = authClient.useUpdateOrganizationMemberRoles();
  const { mutate: removeMember } = authClient.useRemoveOrganizationMember();

  useEffect(() => {
    setMemberSearch("");
  }, [organization.id]);

  const handleUpdateMemberRoles = async (memberId: string, roles: string[]) => {
    await updateMemberRoles({
      path: { organizationId: organization.id, memberId },
      body: { roles },
    });
    await revalidator.revalidate();
    if (posthog) {
      posthog.capture("organization_member_role_updated", {
        organization_id: organization.id,
        role_count: roles.length,
      });
    }
  };

  const handleRemoveMember = async (memberId: string) => {
    await removeMember({
      path: { organizationId: organization.id, memberId },
    });
    await revalidator.revalidate();
    if (posthog) {
      posthog.capture("organization_member_removed", {
        organization_id: organization.id,
      });
    }
  };

  const filteredMembers = useMemo(() => {
    const query = memberSearch.trim().toLowerCase();
    if (!query) {
      return members;
    }
    return members.filter(
      (entry) =>
        entry.user.name.toLowerCase().includes(query) ||
        entry.user.email.toLowerCase().includes(query) ||
        entry.roles.some((role) => role.toLowerCase().includes(query)),
    );
  }, [memberSearch, members]);

  const hasMemberSearch = memberSearch.trim().length > 0;
  const totalPages = membersData.totalPages;
  const columns: readonly SurfaceTableColumn[] = canManageMembers
    ? [...MEMBER_COLUMNS, { label: "Actions", align: "end" }]
    : MEMBER_COLUMNS;

  return (
    <SurfacePanel
      caption={
        hasMemberSearch
          ? `${filteredMembers.length} of ${members.length} members`
          : `${membersData.total} ${membersData.total === 1 ? "member" : "members"}`
      }
      actions={
        <Input
          type="search"
          aria-label="Search organization members"
          value={memberSearch}
          onChange={(event) => {
            setMemberSearch(event.target.value);
          }}
          placeholder="Search members"
          className="w-full text-xs sm:w-56"
        />
      }
    >
      {filteredMembers.length === 0 ? (
        <BackofficeSystemState
          tone="empty"
          title={hasMemberSearch ? "No members match your search." : "No members found."}
          flush
        />
      ) : (
        <SurfaceTable columns={columns}>
          {filteredMembers.map((memberEntry) => (
            <OrganizationMemberRow
              key={`${memberEntry.id}:${memberEntry.roles.join(",")}`}
              columns={columns}
              member={memberEntry}
              isSelf={memberEntry.userId === currentUserId}
              canManageMembers={canManageMembers}
              canOpenWorkspace={administersOrganization}
              onUpdateRoles={handleUpdateMemberRoles}
              onRemove={handleRemoveMember}
            />
          ))}
        </SurfaceTable>
      )}

      {totalPages > 1 ? (
        <SurfacePanelFooter>
          <span className="mr-auto text-xs text-[var(--bo-muted-2)]">
            Page {membersPage} of {totalPages}
          </span>
          <Button
            variant="secondary"
            type="button"
            onClick={() => {
              setSearchParams({ page: String(Math.max(1, membersPage - 1)) });
            }}
            disabled={membersLoading || membersPage === 1}
          >
            Previous
          </Button>
          <Button
            variant="secondary"
            type="button"
            onClick={() => {
              setSearchParams({ page: String(membersPage + 1) });
            }}
            disabled={membersLoading || membersPage >= totalPages}
          >
            Next
          </Button>
        </SurfacePanelFooter>
      ) : null}
    </SurfacePanel>
  );
}

function OrganizationMemberRow({
  columns,
  member,
  isSelf,
  canManageMembers,
  canOpenWorkspace,
  onUpdateRoles,
  onRemove,
}: {
  columns: readonly SurfaceTableColumn[];
  member: OrganizationMember;
  isSelf: boolean;
  canManageMembers: boolean;
  /** Owners and admins act in their members' personal workspaces. */
  canOpenWorkspace: boolean;
  onUpdateRoles: (memberId: string, roles: string[]) => Promise<void>;
  onRemove: (memberId: string) => Promise<void>;
}) {
  const [selectedRoles, setSelectedRoles] = useState<string[]>(member.roles);
  const [actionNotice, setActionNotice] = useState<ActionNotice>(null);
  const [saving, setSaving] = useState(false);
  const [removing, setRemoving] = useState(false);

  const roleOptions = useMemo(() => {
    const extras = member.roles.filter(
      (role) => !ROLE_OPTIONS.includes(role as (typeof ROLE_OPTIONS)[number]),
    );
    const uniqueExtras = Array.from(new Set(extras)).sort((left, right) =>
      left.localeCompare(right),
    );
    return [...ROLE_OPTIONS, ...uniqueExtras];
  }, [member.roles]);

  const selectedRoleSet = useMemo(() => new Set(selectedRoles), [selectedRoles]);
  const canEditMember = canManageMembers && !isSelf;

  const rolesChanged = useMemo(() => {
    const current = [...member.roles].sort((left, right) => left.localeCompare(right)).join("|");
    const next = [...selectedRoles].sort((left, right) => left.localeCompare(right)).join("|");
    return current !== next;
  }, [member.roles, selectedRoles]);

  const handleToggleRole = (role: string) => {
    if (!canEditMember) {
      return;
    }
    setActionNotice(null);
    setSelectedRoles((prev) =>
      prev.includes(role) ? prev.filter((entry) => entry !== role) : [...prev, role],
    );
  };

  const handleSave = async () => {
    if (!canEditMember || selectedRoles.length === 0 || !rolesChanged) {
      return;
    }
    setSaving(true);
    setActionNotice(null);
    try {
      await onUpdateRoles(member.id, selectedRoles);
      setActionNotice({ type: "success", message: "Roles updated." });
    } catch (error) {
      setActionNotice({ type: "error", message: getErrorMessage(error) });
    } finally {
      setSaving(false);
    }
  };

  const handleRemove = async () => {
    if (!canEditMember || removing) {
      return;
    }
    if (!window.confirm(`Remove ${member.user.name} from this organization?`)) {
      return;
    }
    setRemoving(true);
    setActionNotice(null);
    try {
      await onRemove(member.id);
    } catch (error) {
      setActionNotice({ type: "error", message: getErrorMessage(error) });
      setRemoving(false);
    }
  };

  const identity = (
    <div key="member" className="min-w-0">
      <div className="flex items-center gap-2">
        <span className="truncate font-semibold text-[var(--bo-fg)]">{member.user.name}</span>
        {isSelf ? (
          <span className="text-[10px] tracking-[0.22em] text-[var(--bo-muted-2)] uppercase">
            You
          </span>
        ) : null}
      </div>
      <span className="block truncate text-xs">{member.user.email}</span>
      {canOpenWorkspace && !isSelf ? (
        <Link
          to={dashboardPath({ kind: "user", userId: member.userId })}
          className="text-xs font-semibold text-[var(--bo-accent-fg)] hover:underline"
        >
          Open workspace
        </Link>
      ) : null}
    </div>
  );
  const roles = canManageMembers ? (
    <fieldset key="roles" className="flex gap-4 whitespace-nowrap">
      <legend className="sr-only">Roles for {member.user.name}</legend>
      {roleOptions.map((role) => (
        <Checkbox
          key={role}
          density="compact"
          checked={selectedRoleSet.has(role)}
          onCheckedChange={() => {
            handleToggleRole(role);
          }}
          disabled={!canEditMember}
        >
          {role}
        </Checkbox>
      ))}
    </fieldset>
  ) : (
    <span key="roles">{formatRoles(member.roles)}</span>
  );
  const joined = (
    <span key="joined" className="whitespace-nowrap">
      {formatDate(member.createdAt)}
    </span>
  );

  if (!canManageMembers) {
    return <SurfaceTableRow columns={columns} cells={[identity, roles, joined]} />;
  }

  return (
    <SurfaceTableRow
      columns={columns}
      cells={[
        identity,
        roles,
        joined,
        <div key="actions" className="flex flex-col items-end gap-1">
          <div className="flex items-center justify-end gap-2 whitespace-nowrap">
            <Button
              variant="accent"
              type="button"
              onClick={() => void handleSave()}
              disabled={!canEditMember || !rolesChanged || selectedRoles.length === 0 || saving}
            >
              {saving ? "Saving…" : "Save"}
            </Button>
            <Button
              variant="danger"
              type="button"
              onClick={() => void handleRemove()}
              disabled={!canEditMember || removing}
            >
              {removing ? "Removing…" : "Remove"}
            </Button>
          </div>
          {actionNotice ? (
            <p
              role={actionNotice.type === "error" ? "alert" : "status"}
              className={cn(
                "text-[11px]",
                actionNotice.type === "error"
                  ? "text-[var(--bo-failed)]"
                  : "text-[var(--bo-muted)]",
              )}
            >
              {actionNotice.message}
            </p>
          ) : null}
        </div>,
      ]}
    />
  );
}

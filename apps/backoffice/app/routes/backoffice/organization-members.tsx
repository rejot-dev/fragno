import { Button } from "@fragno-private/design-system/button";
import { cn } from "@fragno-private/design-system/cn";
import { FormContainer } from "@fragno-private/design-system/form-container";
import { Input } from "@fragno-private/design-system/input";
import { useEffect, useMemo, useState } from "react";
import {
  useLoaderData,
  useNavigation,
  useOutletContext,
  useRevalidator,
  useSearchParams,
} from "react-router";

import { authClient } from "@/fragno/auth/auth-client";
import { loadOrganizationMembers } from "@/fragno/auth/auth-directory.server";

import type { Route } from "./+types/organization-members";
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

export default function BackofficeOrganizationMembers() {
  const { organization, member, me } = useOutletContext<OrganizationLayoutContext>();
  const currentUserId = me.user.id;
  const canManageMembers =
    me.user.role === "admin" || member.roles.some((role) => role === "owner" || role === "admin");

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
  };

  const handleRemoveMember = async (memberId: string) => {
    await removeMember({
      path: { organizationId: organization.id, memberId },
    });
    await revalidator.revalidate();
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

  return (
    <div className="space-y-4">
      <FormContainer
        eyebrow="Members"
        title={`Members (${members.length})`}
        description="Review the current organization roster and role assignments."
        actions={
          <Input
            type="search"
            aria-label="Search organization members"
            value={memberSearch}
            onChange={(event) => {
              setMemberSearch(event.target.value);
            }}
            placeholder="Search members"
            className="w-full text-xs sm:w-52"
          />
        }
      >
        <div className="space-y-3">
          <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-[var(--bo-muted-2)]">
            <span>
              {hasMemberSearch
                ? `Showing ${filteredMembers.length} of ${members.length} members on this page`
                : `${membersData?.total ?? 0} members`}
            </span>
            <span>
              Page {membersData?.page ?? membersPage} of {membersData?.totalPages ?? 1}
            </span>
          </div>

          {filteredMembers.length === 0 ? (
            <p className="text-sm text-[var(--bo-muted)]">
              {hasMemberSearch ? "No members match your search." : "No members found."}
            </p>
          ) : (
            <div className="overflow-hidden border border-[color:var(--bo-border)]">
              <table className="min-w-full divide-y divide-[color:var(--bo-border)] text-sm">
                <thead className="bg-[var(--bo-panel-2)] text-left">
                  <tr className="text-[11px] tracking-[0.22em] text-[var(--bo-muted-2)] uppercase">
                    <th scope="col" className="px-3 py-2">
                      User
                    </th>
                    <th scope="col" className="px-3 py-2">
                      Roles
                    </th>
                    <th scope="col" className="px-3 py-2">
                      Joined
                    </th>
                    <th scope="col" className="px-3 py-2">
                      Actions
                    </th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-[color:var(--bo-border)] bg-[var(--bo-panel)]">
                  {filteredMembers.map((memberEntry) => (
                    <OrganizationMemberRow
                      key={`${memberEntry.id}:${memberEntry.roles.join(",")}`}
                      member={memberEntry}
                      isSelf={Boolean(currentUserId && memberEntry.userId === currentUserId)}
                      canManageMembers={canManageMembers}
                      onUpdateRoles={handleUpdateMemberRoles}
                      onRemove={handleRemoveMember}
                    />
                  ))}
                </tbody>
              </table>
            </div>
          )}

          <div className="flex items-center justify-end gap-2">
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
              disabled={membersLoading || membersPage >= (membersData?.totalPages ?? 1)}
            >
              Next
            </Button>
          </div>
        </div>
      </FormContainer>
    </div>
  );
}

function OrganizationMemberRow({
  member,
  isSelf,
  canManageMembers,
  onUpdateRoles,
  onRemove,
}: {
  member: OrganizationMember;
  isSelf: boolean;
  canManageMembers: boolean;
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

  return (
    <tr className="text-[var(--bo-muted)]">
      <td className="px-3 py-2 font-semibold text-[var(--bo-fg)]">
        <div className="flex flex-col">
          <div className="flex items-center gap-2">
            <span className="text-sm text-[var(--bo-fg)]">{member.user.name}</span>
            {isSelf ? (
              <span className="text-[10px] tracking-[0.22em] text-[var(--bo-muted-2)] uppercase">
                You
              </span>
            ) : null}
          </div>
          <span className="text-xs font-normal text-[var(--bo-muted)]">{member.user.email}</span>
        </div>
      </td>
      <td className="px-3 py-2">
        {canManageMembers ? (
          <div className="flex flex-wrap gap-2">
            {roleOptions.map((role) => {
              const isSelected = selectedRoleSet.has(role);
              return (
                <button
                  key={role}
                  type="button"
                  onClick={() => {
                    handleToggleRole(role);
                  }}
                  disabled={!canEditMember}
                  className={cn(
                    "border px-2 py-1 text-[10px] font-semibold uppercase tracking-[0.2em] transition-colors disabled:cursor-not-allowed disabled:opacity-60",
                    isSelected
                      ? "border-[color:var(--bo-selected-border)] bg-[var(--bo-selected-bg)] shadow-[var(--bo-selected-shadow)] text-[var(--bo-fg)]"
                      : "border-[color:var(--bo-border)] bg-[var(--bo-panel-2)] text-[var(--bo-muted)] hover:border-[color:var(--bo-border-strong)] hover:text-[var(--bo-fg)]",
                  )}
                >
                  {role}
                </button>
              );
            })}
          </div>
        ) : (
          <span>{formatRoles(member.roles)}</span>
        )}
      </td>
      <td className="px-3 py-2">{formatDate(member.createdAt)}</td>
      <td className="px-3 py-2">
        {canManageMembers ? (
          <div className="space-y-2">
            <div className="flex flex-wrap items-center gap-2">
              <Button
                variant="accent"
                type="button"
                onClick={() => void handleSave()}
                disabled={!canEditMember || !rolesChanged || selectedRoles.length === 0 || saving}
              >
                {saving ? "Saving" : "Save"}
              </Button>
              <Button
                variant="secondary"
                type="button"
                onClick={() => void handleRemove()}
                disabled={!canEditMember || removing}
              >
                {removing ? "Removing" : "Remove"}
              </Button>
            </div>
            {actionNotice ? (
              <p
                className={cn(
                  "text-[11px]",
                  actionNotice.type === "error" ? "text-red-600" : "text-[var(--bo-muted)]",
                )}
              >
                {actionNotice.message}
              </p>
            ) : null}
          </div>
        ) : (
          <span className="text-xs text-[var(--bo-muted-2)]">Admin only</span>
        )}
      </td>
    </tr>
  );
}

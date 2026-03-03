import { useEffect, useMemo, useState } from "react";
import { useOutletContext } from "react-router";
import { FormContainer } from "@/components/backoffice";
import { authClient } from "@/fragno/auth-client";
import type { OrganisationLayoutContext } from "./organisation-layout";
import { ROLE_OPTIONS, formatDate, formatRoles, getErrorMessage } from "./organisation-shared";
import { cn } from "@/lib/utils";

const MEMBER_PAGE_SIZE = 25;

type OrganizationMembersHook = ReturnType<typeof authClient.useOrganizationMembers>;
type OrganizationMember = NonNullable<OrganizationMembersHook["data"]>["members"][number];

type ActionNotice = {
  type: "success" | "error";
  message: string;
} | null;

export function meta() {
  return [{ title: "Organisation Members" }];
}

export default function BackofficeOrganisationMembers() {
  const { organization, member, me } = useOutletContext<OrganisationLayoutContext>();
  const currentUserId = me.user.id;
  const canManageMembers =
    me.user.role === "admin" || member.roles.some((role) => role === "owner" || role === "admin");

  const [membersCursor, setMembersCursor] = useState<string | null>(null);
  const [members, setMembers] = useState<OrganizationMember[]>([]);
  const [membersHasNext, setMembersHasNext] = useState(false);
  const [membersInitialized, setMembersInitialized] = useState(false);
  const [membersLoadingMore, setMembersLoadingMore] = useState(false);
  const [memberSearch, setMemberSearch] = useState("");

  const {
    data: membersData,
    loading: membersLoading,
    error: membersError,
  } = authClient.useOrganizationMembers({
    path: { organizationId: organization.id },
    query: {
      pageSize: String(MEMBER_PAGE_SIZE),
      cursor: membersCursor ?? undefined,
    },
  });

  const { mutate: updateMemberRoles } = authClient.useUpdateOrganizationMemberRoles();
  const { mutate: removeMember } = authClient.useRemoveOrganizationMember();

  useEffect(() => {
    setMembersCursor(null);
    setMembers([]);
    setMembersHasNext(false);
    setMembersInitialized(false);
    setMembersLoadingMore(false);
    setMemberSearch("");
  }, [organization.id]);

  useEffect(() => {
    if (!membersData) {
      return;
    }

    const pageMembers = membersData.members ?? [];
    setMembers((prev) => {
      const next = membersCursor ? [...prev, ...pageMembers] : pageMembers;
      const seen = new Set<string>();
      return next.filter((entry) => {
        if (seen.has(entry.id)) {
          return false;
        }
        seen.add(entry.id);
        return true;
      });
    });
    setMembersHasNext(membersData.hasNextPage);
    setMembersInitialized(true);
    setMembersLoadingMore(false);
  }, [membersCursor, membersData]);

  useEffect(() => {
    if (membersError) {
      setMembersLoadingMore(false);
    }
  }, [membersError]);

  const handleUpdateMemberRoles = async (memberId: string, roles: string[]) => {
    await updateMemberRoles({
      path: { organizationId: organization.id, memberId },
      body: { roles },
    });
    setMembers((prev) =>
      prev.map((entry) => (entry.id === memberId ? { ...entry, roles } : entry)),
    );
  };

  const handleRemoveMember = async (memberId: string) => {
    await removeMember({
      path: { organizationId: organization.id, memberId },
    });
    setMembers((prev) => prev.filter((entry) => entry.id !== memberId));
  };

  const filteredMembers = useMemo(() => {
    const query = memberSearch.trim().toLowerCase();
    if (!query) {
      return members;
    }
    return members.filter(
      (entry) =>
        entry.userId.toLowerCase().includes(query) ||
        entry.roles.some((role) => role.toLowerCase().includes(query)),
    );
  }, [memberSearch, members]);

  const isInitialMembersLoading = Boolean(
    membersLoading && !membersInitialized && members.length === 0,
  );
  const hasMemberSearch = memberSearch.trim().length > 0;

  return (
    <div className="space-y-4">
      <FormContainer
        eyebrow="Members"
        title={`Members (${members.length})`}
        description="Review the current organisation roster and role assignments."
        actions={
          <input
            type="search"
            value={memberSearch}
            onChange={(event) => setMemberSearch(event.target.value)}
            placeholder="Search members"
            className="focus:ring-[color:var(--bo-accent)]/20 w-full border border-[color:var(--bo-border)] bg-[var(--bo-panel-2)] px-3 py-2 text-xs text-[var(--bo-fg)] focus:border-[color:var(--bo-accent)] focus:outline-none focus:ring-2 sm:w-52"
          />
        }
      >
        <div className="space-y-3">
          <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-[var(--bo-muted-2)]">
            <span>
              {hasMemberSearch
                ? `Showing ${filteredMembers.length} of ${members.length} loaded members`
                : `${members.length} members loaded`}
            </span>
            {membersHasNext ? (
              <span>More members available</span>
            ) : membersInitialized ? (
              <span>All members loaded</span>
            ) : null}
          </div>

          {isInitialMembersLoading ? (
            <p className="text-sm text-[var(--bo-muted)]">Loading members...</p>
          ) : membersError && members.length === 0 ? (
            <p className="text-sm text-red-600">{getErrorMessage(membersError)}</p>
          ) : filteredMembers.length === 0 ? (
            <p className="text-sm text-[var(--bo-muted)]">
              {hasMemberSearch ? "No members match your search." : "No members found."}
            </p>
          ) : (
            <div className="overflow-hidden border border-[color:var(--bo-border)]">
              <table className="min-w-full divide-y divide-[color:var(--bo-border)] text-sm">
                <thead className="bg-[var(--bo-panel-2)] text-left">
                  <tr className="text-[11px] uppercase tracking-[0.22em] text-[var(--bo-muted-2)]">
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
                      key={memberEntry.id}
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

          {membersError && members.length > 0 ? (
            <p className="text-xs text-red-600">{getErrorMessage(membersError)}</p>
          ) : null}

          {membersHasNext ? (
            <button
              type="button"
              onClick={() => {
                if (!membersHasNext || membersLoadingMore) {
                  return;
                }
                const nextCursor = membersData?.cursor;
                if (!nextCursor) {
                  return;
                }
                setMembersLoadingMore(true);
                setMembersCursor(nextCursor);
              }}
              disabled={!membersHasNext || membersLoadingMore}
              className="border border-[color:var(--bo-border)] bg-[var(--bo-panel-2)] px-3 py-2 text-[10px] font-semibold uppercase tracking-[0.22em] text-[var(--bo-muted)] transition-colors hover:border-[color:var(--bo-border-strong)] hover:text-[var(--bo-fg)] disabled:opacity-60"
            >
              {membersLoadingMore ? "Loading..." : "Load more"}
            </button>
          ) : null}
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

  useEffect(() => {
    setSelectedRoles(member.roles);
    setActionNotice(null);
    setSaving(false);
    setRemoving(false);
  }, [member.id, member.roles.join("|")]);

  const roleOptions = useMemo(() => {
    const extras = member.roles.filter(
      (role) => !ROLE_OPTIONS.includes(role as (typeof ROLE_OPTIONS)[number]),
    );
    const uniqueExtras = Array.from(new Set(extras)).sort();
    return [...ROLE_OPTIONS, ...uniqueExtras];
  }, [member.roles]);

  const rolesChanged = useMemo(() => {
    const current = [...member.roles].sort().join("|");
    const next = [...selectedRoles].sort().join("|");
    return current !== next;
  }, [member.roles, selectedRoles]);

  const handleToggleRole = (role: string) => {
    if (!canManageMembers) {
      return;
    }
    setActionNotice(null);
    setSelectedRoles((prev) =>
      prev.includes(role) ? prev.filter((entry) => entry !== role) : [...prev, role],
    );
  };

  const handleSave = async () => {
    if (!canManageMembers || selectedRoles.length === 0 || !rolesChanged) {
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
    if (!canManageMembers || removing) {
      return;
    }
    if (!window.confirm(`Remove ${member.userId} from this organisation?`)) {
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
          <span className="font-mono text-xs text-[var(--bo-fg)]">{member.userId}</span>
          {isSelf ? (
            <span className="text-[10px] uppercase tracking-[0.22em] text-[var(--bo-muted-2)]">
              You
            </span>
          ) : null}
        </div>
      </td>
      <td className="px-3 py-2">
        {canManageMembers ? (
          <div className="flex flex-wrap gap-2">
            {roleOptions.map((role) => {
              const isSelected = selectedRoles.includes(role);
              return (
                <button
                  key={role}
                  type="button"
                  onClick={() => handleToggleRole(role)}
                  className={cn(
                    "border px-2 py-1 text-[10px] font-semibold uppercase tracking-[0.2em] transition-colors",
                    isSelected
                      ? "border-[color:var(--bo-accent)] bg-[var(--bo-accent-bg)] text-[var(--bo-accent-fg)]"
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
              <button
                type="button"
                onClick={handleSave}
                disabled={!rolesChanged || selectedRoles.length === 0 || saving}
                className="border border-[color:var(--bo-accent)] bg-[var(--bo-accent-bg)] px-2 py-1 text-[10px] font-semibold uppercase tracking-[0.2em] text-[var(--bo-accent-fg)] transition-colors hover:border-[color:var(--bo-accent-strong)] disabled:opacity-60"
              >
                {saving ? "Saving" : "Save"}
              </button>
              <button
                type="button"
                onClick={handleRemove}
                disabled={removing}
                className="border border-[color:var(--bo-border)] bg-[var(--bo-panel-2)] px-2 py-1 text-[10px] font-semibold uppercase tracking-[0.2em] text-[var(--bo-muted)] transition-colors hover:border-[color:var(--bo-border-strong)] hover:text-[var(--bo-fg)] disabled:opacity-60"
              >
                {removing ? "Removing" : "Remove"}
              </button>
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

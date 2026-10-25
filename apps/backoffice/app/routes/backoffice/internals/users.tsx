import { Button } from "@fragno-private/design-system/button";
import { Input } from "@fragno-private/design-system/input";
import { Select } from "@fragno-private/design-system/select";
import {
  SurfacePanel,
  SurfacePanelFooter,
  SurfaceTable,
  SurfaceTableRow,
  type SurfaceTableColumn,
} from "@fragno-private/design-system/surface-panel";
import { BackofficeSystemState } from "@fragno-private/design-system/system-state";
import { useState } from "react";
import {
  useLoaderData,
  useNavigation,
  useOutletContext,
  useRevalidator,
  useSearchParams,
} from "react-router";

import { authClient } from "@/fragno/auth/auth-client";
import { loadSystemUsers } from "@/fragno/auth/auth-directory.server";

import type { Route } from "./+types/users";
import type { InternalsLayoutContext } from "./layout";

const GLOBAL_ROLES = ["user", "admin"] as const;

const USER_COLUMNS: SurfaceTableColumn[] = [
  { label: "User", align: "start" },
  { label: "Created", align: "start" },
  { label: "Global role", align: "start" },
  { label: "Action", align: "end" },
];

export async function loader({ request, context }: Route.LoaderArgs) {
  return await loadSystemUsers({ request, context });
}

type SystemUser = Awaited<ReturnType<typeof loader>>["users"][number];
type GlobalRole = SystemUser["role"];

type ActionNotice = {
  tone: "success" | "error";
  message: string;
} | null;

const USER_DATE_FORMATTER = new Intl.DateTimeFormat("en", {
  dateStyle: "medium",
  timeStyle: "short",
});

export function meta() {
  return [
    { title: "System Users · Backoffice Internals" },
    { name: "description", content: "Inspect system users and manage their global roles." },
  ];
}

export default function BackofficeInternalUsers() {
  const { me } = useOutletContext<InternalsLayoutContext>();
  const { search, users, page, total, totalPages } = useLoaderData<typeof loader>();
  const [searchInput, setSearchInput] = useState(search);
  const [, setSearchParams] = useSearchParams();
  const revalidator = useRevalidator();
  const loading = useNavigation().state !== "idle";

  const runSearch = () => {
    const nextSearch = searchInput.trim();
    if (loading || nextSearch === search) {
      return;
    }

    setSearchParams({ search: nextSearch });
  };

  const updateUser = () => {
    void revalidator.revalidate();
  };

  const caption = `${total} ${total === 1 ? "account" : "accounts"}${search ? ` matching “${search}”` : ""}`;

  return (
    <SurfacePanel
      caption={caption}
      actions={
        <form
          className="flex gap-2"
          onSubmit={(event) => {
            event.preventDefault();
            runSearch();
          }}
        >
          <Input
            type="search"
            value={searchInput}
            onChange={(event) => {
              setSearchInput(event.target.value);
            }}
            placeholder="Search by email"
            aria-label="Search system users by email"
            className="w-56"
          />
          <Button type="submit" disabled={loading} variant="secondary">
            Search
          </Button>
          {search ? (
            <Button
              disabled={loading}
              onClick={() => {
                setSearchInput("");
                setSearchParams({});
              }}
              variant="ghost"
            >
              Clear
            </Button>
          ) : null}
        </form>
      }
    >
      {users.length === 0 ? (
        <BackofficeSystemState
          tone="empty"
          title={search ? `No accounts match “${search}”.` : "No accounts yet."}
          description="Every account known to Auth appears here, with its global role. Organization roles are managed per organization."
          flush
        />
      ) : (
        <SurfaceTable columns={USER_COLUMNS}>
          {users.map((user) => (
            <SystemUserRow
              key={user.id}
              user={user}
              isCurrentUser={user.id === me.user.id}
              onUpdated={updateUser}
            />
          ))}
        </SurfaceTable>
      )}

      {totalPages > 1 ? (
        <SurfacePanelFooter>
          <span className="mr-auto text-xs text-[var(--bo-muted-2)] tabular-nums">
            Page {page} of {totalPages}
          </span>
          <Button
            disabled={loading || page === 1}
            onClick={() => {
              setSearchParams({ search, page: String(page - 1) });
            }}
            variant="secondary"
          >
            Previous
          </Button>
          <Button
            disabled={loading || page >= totalPages}
            onClick={() => {
              setSearchParams({ search, page: String(page + 1) });
            }}
            variant="secondary"
          >
            Next
          </Button>
        </SurfacePanelFooter>
      ) : null}
    </SurfacePanel>
  );
}

function SystemUserRow({
  user,
  isCurrentUser,
  onUpdated,
}: {
  user: SystemUser;
  isCurrentUser: boolean;
  onUpdated: (userId: string, role: GlobalRole) => void;
}) {
  const [roleSelection, setRoleSelection] = useState({
    userRole: user.role,
    selectedRole: user.role,
  });
  const selectedRole =
    roleSelection.userRole === user.role ? roleSelection.selectedRole : user.role;
  const [saving, setSaving] = useState(false);
  const [notice, setNotice] = useState<ActionNotice>(null);
  const { mutate: updateRole } = authClient.useUpdateUserRole();

  const saveRole = async () => {
    if (isCurrentUser || selectedRole === user.role || saving) {
      return;
    }

    setSaving(true);
    setNotice(null);
    try {
      await updateRole({ path: { userId: user.id }, body: { role: selectedRole } });
      setRoleSelection({ userRole: selectedRole, selectedRole });
      onUpdated(user.id, selectedRole);
      setNotice({ tone: "success", message: "Role updated." });
    } catch (updateError) {
      setNotice({ tone: "error", message: getErrorMessage(updateError) });
    } finally {
      setSaving(false);
    }
  };

  return (
    <SurfaceTableRow
      columns={USER_COLUMNS}
      cells={[
        <div key="user" className="min-w-0">
          <div className="font-semibold text-[var(--bo-fg)]">{user.email}</div>
          <div className="font-mono text-[11px] text-[var(--bo-muted-2)]">{user.id}</div>
        </div>,
        <span key="created" className="whitespace-nowrap">
          {formatDate(user.createdAt)}
        </span>,
        <Select
          key="role"
          aria-label={`Global role for ${user.email}`}
          density="compact"
          disabled={isCurrentUser}
          value={selectedRole}
          options={GLOBAL_ROLES.map((role) => ({ label: role, value: role }))}
          onValueChange={(role) => {
            if (role === null) {
              return;
            }
            setRoleSelection({ userRole: user.role, selectedRole: role });
            setNotice(null);
          }}
          className="min-w-28"
        />,
        <div key="action" className="flex flex-col items-end gap-1">
          {isCurrentUser ? (
            <span className="max-w-36 text-right text-xs text-[var(--bo-muted-2)]">
              You cannot change your own role.
            </span>
          ) : (
            <Button
              disabled={selectedRole === user.role || saving}
              onClick={() => void saveRole()}
              variant="accent"
            >
              {saving ? "Saving…" : "Save role"}
            </Button>
          )}
          {notice ? (
            <span
              role={notice.tone === "error" ? "alert" : "status"}
              className={
                notice.tone === "error"
                  ? "text-xs text-[var(--bo-failed)]"
                  : "text-xs text-[var(--bo-live)]"
              }
            >
              {notice.message}
            </span>
          ) : null}
        </div>,
      ]}
    />
  );
}

function formatDate(value: string) {
  return USER_DATE_FORMATTER.format(new Date(value));
}

function getErrorMessage(error: unknown) {
  return error instanceof Error ? error.message : "The request could not be completed.";
}

import { useEffect, useReducer, useState } from "react";
import { useOutletContext } from "react-router";

import { BackofficePageHeader } from "@/components/backoffice";
import { authClient } from "@/fragno/auth/auth-client";
import type { BackofficeLayoutContext } from "@/layouts/backoffice-layout";
import { cn } from "@/lib/utils";

const USERS_PAGE_SIZE = 50;
const GLOBAL_ROLES = ["user", "admin"] as const;

type UsersHook = ReturnType<typeof authClient.useUsers>;
type SystemUser = NonNullable<UsersHook["data"]>["users"][number];
type GlobalRole = SystemUser["role"];

type ActionNotice = {
  tone: "success" | "error";
  message: string;
} | null;

type UsersDirectoryState = {
  search: string;
  users: SystemUser[];
  page: number;
  total: number;
  totalPages: number;
  initialized: boolean;
};

type UsersDirectoryAction =
  | {
      type: "resultsReceived";
      users: SystemUser[];
      page: number;
      total: number;
      totalPages: number;
    }
  | { type: "searchChanged"; search: string }
  | { type: "pageRequested"; page: number }
  | { type: "userRoleUpdated"; userId: string; role: GlobalRole };

const INITIAL_USERS_DIRECTORY_STATE: UsersDirectoryState = {
  search: "",
  users: [],
  page: 1,
  total: 0,
  totalPages: 1,
  initialized: false,
};

const usersDirectoryReducer = (
  state: UsersDirectoryState,
  action: UsersDirectoryAction,
): UsersDirectoryState => {
  switch (action.type) {
    case "resultsReceived":
      return {
        ...state,
        users: action.users,
        page: action.page,
        total: action.total,
        totalPages: action.totalPages,
        initialized: true,
      };
    case "searchChanged":
      return { ...INITIAL_USERS_DIRECTORY_STATE, search: action.search };
    case "pageRequested":
      return { ...state, page: action.page };
    case "userRoleUpdated":
      return {
        ...state,
        users: state.users.map((user) =>
          user.id === action.userId ? { ...user, role: action.role } : user,
        ),
      };
  }

  throw new Error(`Unhandled action type`);
};

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
  const { me } = useOutletContext<BackofficeLayoutContext>();
  const [searchInput, setSearchInput] = useState("");
  const [directory, dispatchDirectory] = useReducer(
    usersDirectoryReducer,
    INITIAL_USERS_DIRECTORY_STATE,
  );
  const { search, users, page, total, totalPages, initialized } = directory;

  const { data, loading, error } = authClient.useUsers({
    query: {
      search: search || undefined,
      sortBy: "createdAt",
      sortOrder: "desc",
      pageSize: String(USERS_PAGE_SIZE),
      page: String(page),
    },
  });

  useEffect(() => {
    if (!data) {
      return;
    }

    dispatchDirectory({
      type: "resultsReceived",
      users: data.users,
      page: data.page,
      total: data.total,
      totalPages: data.totalPages,
    });
  }, [data]);

  const runSearch = () => {
    const nextSearch = searchInput.trim();
    if (loading || nextSearch === search) {
      return;
    }

    dispatchDirectory({ type: "searchChanged", search: nextSearch });
  };

  const updateUser = (userId: string, role: GlobalRole) => {
    dispatchDirectory({ type: "userRoleUpdated", userId, role });
  };

  const isInitialLoading = loading && !initialized && users.length === 0;

  return (
    <div className="space-y-4">
      <BackofficePageHeader
        breadcrumbs={[
          { label: "Backoffice", to: "/backoffice" },
          { label: "Internals", to: "/backoffice/internals" },
          { label: "Users" },
        ]}
        eyebrow="Identity control"
        title="System users and global authority."
        description="Review every account known to Auth and assign the global user or administrator role. Organisation roles are managed separately."
      />

      <section className="bo-fragment-surface bo-panel-surface bg-[var(--bo-panel)] p-4">
        <div className="flex flex-wrap items-end justify-between gap-4">
          <div>
            <p className="text-[10px] tracking-[0.24em] text-[var(--bo-muted-2)] uppercase">
              Global directory
            </p>
            <h2 className="mt-2 text-xl font-semibold text-[var(--bo-fg)]">
              {total} {total === 1 ? "account" : "accounts"}
            </h2>
          </div>

          <form
            className="flex w-full gap-2 sm:w-auto"
            onSubmit={(event) => {
              event.preventDefault();
              runSearch();
            }}
          >
            <input
              type="search"
              value={searchInput}
              onChange={(event) => {
                setSearchInput(event.target.value);
              }}
              placeholder="Search by email"
              aria-label="Search system users by email"
              className="min-w-0 flex-1 border border-[color:var(--bo-border)] bg-[var(--bo-panel-2)] px-3 py-2 text-sm text-[var(--bo-fg)] placeholder:text-[var(--bo-muted-2)] focus:border-[color:var(--bo-accent)] focus:ring-2 focus:ring-[color:var(--bo-accent)]/20 focus:outline-none sm:w-64"
            />
            <button
              type="submit"
              disabled={loading}
              className="bg-[var(--bo-accent-bg)] px-3 py-2 text-[10px] font-semibold tracking-[0.22em] text-[var(--bo-accent-fg)] uppercase shadow-[inset_0_0_0_1px_var(--bo-accent)] hover:shadow-[inset_0_0_0_1px_var(--bo-accent-strong)] disabled:opacity-60"
            >
              Search
            </button>
          </form>
        </div>

        {search ? (
          <div className="mt-3 flex items-center gap-2 text-xs text-[var(--bo-muted)]">
            <span>Results for “{search}”</span>
            <button
              type="button"
              disabled={loading}
              onClick={() => {
                setSearchInput("");
                dispatchDirectory({ type: "searchChanged", search: "" });
              }}
              className="font-semibold text-[var(--bo-fg)] underline underline-offset-4 disabled:opacity-60"
            >
              Clear
            </button>
          </div>
        ) : null}

        <div className="mt-4">
          {isInitialLoading ? (
            <p role="status" className="py-8 text-center text-sm text-[var(--bo-muted)]">
              Loading system users…
            </p>
          ) : error && users.length === 0 ? (
            <p role="alert" className="py-8 text-center text-sm text-red-600">
              {getErrorMessage(error)}
            </p>
          ) : users.length === 0 ? (
            <p className="py-8 text-center text-sm text-[var(--bo-muted)]">No users found.</p>
          ) : (
            <div className="overflow-x-auto border border-[color:var(--bo-border)]">
              <table className="min-w-full divide-y divide-[color:var(--bo-border)] text-sm">
                <thead className="bg-[var(--bo-panel-2)] text-left">
                  <tr className="text-[11px] tracking-[0.22em] text-[var(--bo-muted-2)] uppercase">
                    <th scope="col" className="px-3 py-2">
                      User
                    </th>
                    <th scope="col" className="px-3 py-2">
                      Created
                    </th>
                    <th scope="col" className="px-3 py-2">
                      Global role
                    </th>
                    <th scope="col" className="px-3 py-2">
                      Action
                    </th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-[color:var(--bo-border)] bg-[var(--bo-panel)]">
                  {users.map((user) => (
                    <SystemUserRow
                      key={user.id}
                      user={user}
                      isCurrentUser={user.id === me.user.id}
                      onUpdated={updateUser}
                    />
                  ))}
                </tbody>
              </table>
            </div>
          )}

          {error && users.length > 0 ? (
            <p role="alert" className="mt-3 text-xs text-red-600">
              {getErrorMessage(error)}
            </p>
          ) : null}

          {initialized && users.length > 0 ? (
            <div className="mt-3 flex items-center justify-between gap-3">
              <p className="text-xs text-[var(--bo-muted-2)]">
                Page {page} of {totalPages}
              </p>
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  disabled={loading || page === 1}
                  onClick={() => {
                    dispatchDirectory({ type: "pageRequested", page: page - 1 });
                  }}
                  className="border border-[color:var(--bo-border)] bg-[var(--bo-panel-2)] px-3 py-2 text-[10px] font-semibold tracking-[0.22em] text-[var(--bo-muted)] uppercase hover:border-[color:var(--bo-border-strong)] hover:text-[var(--bo-fg)] disabled:opacity-60"
                >
                  Previous
                </button>
                <button
                  type="button"
                  disabled={loading || page >= totalPages}
                  onClick={() => {
                    dispatchDirectory({ type: "pageRequested", page: page + 1 });
                  }}
                  className="border border-[color:var(--bo-border)] bg-[var(--bo-panel-2)] px-3 py-2 text-[10px] font-semibold tracking-[0.22em] text-[var(--bo-muted)] uppercase hover:border-[color:var(--bo-border-strong)] hover:text-[var(--bo-fg)] disabled:opacity-60"
                >
                  Next
                </button>
              </div>
            </div>
          ) : null}
        </div>
      </section>
    </div>
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
    <tr className="text-[var(--bo-muted)]">
      <td className="px-3 py-3">
        <div className="font-semibold text-[var(--bo-fg)]">{user.email}</div>
        <div className="mt-1 font-mono text-[10px] text-[var(--bo-muted-2)]">{user.id}</div>
      </td>
      <td className="px-3 py-3 whitespace-nowrap">{formatDate(user.createdAt)}</td>
      <td className="px-3 py-3">
        <select
          aria-label={`Global role for ${user.email}`}
          disabled={isCurrentUser}
          title={isCurrentUser ? "You cannot change your own global role." : undefined}
          value={selectedRole}
          onChange={(event) => {
            setRoleSelection({
              userRole: user.role,
              selectedRole: event.target.value as GlobalRole,
            });
            setNotice(null);
          }}
          className="min-w-32 border border-[color:var(--bo-border)] bg-[var(--bo-panel-2)] px-3 py-2 text-xs font-semibold tracking-[0.16em] text-[var(--bo-fg)] uppercase focus:border-[color:var(--bo-accent)] focus:outline-none"
        >
          {GLOBAL_ROLES.map((role) => (
            <option key={role} value={role}>
              {role}
            </option>
          ))}
        </select>
      </td>
      <td className="px-3 py-3">
        <div className="flex min-w-36 flex-col items-start gap-1.5">
          {isCurrentUser ? (
            <span className="text-[11px] text-[var(--bo-muted-2)]">
              You cannot change your own role.
            </span>
          ) : (
            <button
              type="button"
              disabled={selectedRole === user.role || saving}
              onClick={() => void saveRole()}
              className="border border-[color:var(--bo-accent)] bg-[var(--bo-accent-bg)] px-3 py-2 text-[10px] font-semibold tracking-[0.2em] text-[var(--bo-accent-fg)] uppercase hover:border-[color:var(--bo-accent-strong)] disabled:opacity-50"
            >
              {saving ? "Saving…" : "Save role"}
            </button>
          )}
          {notice ? (
            <span
              className={cn(
                "text-[11px]",
                notice.tone === "error" ? "text-red-600" : "text-[var(--bo-muted)]",
              )}
            >
              {notice.message}
            </span>
          ) : null}
        </div>
      </td>
    </tr>
  );
}

function formatDate(value: string) {
  return USER_DATE_FORMATTER.format(new Date(value));
}

function getErrorMessage(error: unknown) {
  return error instanceof Error ? error.message : "The request could not be completed.";
}

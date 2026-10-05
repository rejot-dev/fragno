import { Button } from "@fragno-private/design-system/button";
import { cn } from "@fragno-private/design-system/cn";
import { Input } from "@fragno-private/design-system/input";
import { BackofficePageHeader } from "@fragno-private/design-system/page-header";
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
import { internalsScopeBasePath } from "./internals-scope";
import type { InternalsLayoutContext } from "./layout";

const GLOBAL_ROLES = ["user", "admin"] as const;

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
  const { me, selectedRouteScope } = useOutletContext<InternalsLayoutContext>();
  const internalsBasePath = internalsScopeBasePath(selectedRouteScope);
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

  return (
    <div className="space-y-4">
      <BackofficePageHeader
        breadcrumbs={[
          { label: "Backoffice", to: "/backoffice" },
          { label: "Internals", to: internalsBasePath },
          { label: "Users" },
        ]}
        eyebrow="Identity control"
        title="System users and global authority."
        description="Review every account known to Auth and assign the global user or administrator role. Organization roles are managed separately."
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
            <Input
              type="search"
              value={searchInput}
              onChange={(event) => {
                setSearchInput(event.target.value);
              }}
              placeholder="Search by email"
              aria-label="Search system users by email"
              className="min-w-0 flex-1 sm:w-64"
            />
            <Button type="submit" disabled={loading} variant="accent">
              Search
            </Button>
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
                setSearchParams({});
              }}
              className="font-semibold text-[var(--bo-fg)] underline underline-offset-4 disabled:opacity-60"
            >
              Clear
            </button>
          </div>
        ) : null}

        <div className="mt-4">
          {users.length === 0 ? (
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

          {users.length > 0 ? (
            <div className="mt-3 flex items-center justify-between gap-3">
              <p className="text-xs text-[var(--bo-muted-2)]">
                Page {page} of {totalPages}
              </p>
              <div className="flex items-center gap-2">
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
          className="bo-input min-w-32 px-3 py-2 text-xs font-semibold tracking-[0.16em] uppercase"
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

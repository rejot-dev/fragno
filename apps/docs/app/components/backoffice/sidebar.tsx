import type { ReactNode } from "react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { Link, NavLink, useNavigate } from "react-router";
import { DrawerPreview as Drawer } from "@base-ui/react/drawer";
import { Menu } from "@base-ui/react/menu";
import { Separator } from "@base-ui/react/separator";
import type { AuthMeData } from "@/fragno/auth-client";
import { cn } from "@/lib/utils";
import { authClient } from "@/fragno/auth-client";
import { toCfSandboxPath } from "@/routes/backoffice/environments/cf-sandbox-path";

type NavItem = {
  label: string;
  to: string;
  end?: boolean;
  children?: NavItem[];
};

function createNavItems(): NavItem[] {
  return [
    { label: "Dashboard", to: "/backoffice", end: true },
    {
      label: "Connections",
      to: "/backoffice/connections",
      children: [
        { label: "Telegram", to: "/backoffice/connections/telegram" },
        { label: "Resend", to: "/backoffice/connections/resend" },
        { label: "GitHub", to: "/backoffice/connections/github" },
        { label: "Upload", to: "/backoffice/connections/upload" },
      ],
    },
    {
      label: "Environments",
      to: "/backoffice/environments",
      children: [{ label: "CF Sandbox", to: toCfSandboxPath({}) }],
    },
    {
      label: "Internals",
      to: "/backoffice/internals",
      children: [
        { label: "Durable hooks", to: "/backoffice/internals/durable-hooks" },
        { label: "GitHub", to: "/backoffice/internals/github" },
      ],
    },
  ];
}

type BackofficeSidebarProps = {
  me: AuthMeData | null;
  isLoading?: boolean;
};

export function BackofficeSidebar({ me, isLoading }: BackofficeSidebarProps) {
  return (
    <>
      <aside className="relative hidden min-w-0 shrink-0 border-r border-[color:var(--bo-border)] bg-[var(--bo-panel)] px-4 py-4 lg:sticky lg:top-0 lg:flex lg:h-screen lg:w-72">
        <BackofficeSidebarContent me={me} isLoading={isLoading} />
      </aside>

      <Drawer.Portal>
        <Drawer.Backdrop
          data-backoffice-root
          className="fixed inset-0 z-40 bg-[rgba(var(--bo-overlay),0.96)] backdrop-blur-[1px] transition-opacity duration-200 ease-out data-[ending-style]:opacity-0 data-[starting-style]:opacity-0 lg:hidden"
        />
        <Drawer.Viewport className="fixed inset-0 z-50 flex lg:hidden">
          <Drawer.Popup
            data-backoffice-root
            className="h-full w-screen translate-x-[var(--drawer-swipe-movement-x,0px)] border-r border-[color:var(--bo-border)] bg-[var(--bo-panel)] px-4 py-4 text-[var(--bo-fg)] shadow-[0_20px_50px_rgba(15,23,42,0.25)] transition-transform duration-200 ease-out data-[ending-style]:-translate-x-full data-[starting-style]:-translate-x-full sm:w-[min(88vw,20rem)] dark:shadow-[0_24px_60px_rgba(0,0,0,0.6)]"
          >
            <Drawer.Content className="h-full">
              <BackofficeSidebarContent me={me} isLoading={isLoading} showClose />
            </Drawer.Content>
          </Drawer.Popup>
        </Drawer.Viewport>
      </Drawer.Portal>
    </>
  );
}

function BackofficeSidebarContent({
  me,
  isLoading,
  showClose = false,
}: BackofficeSidebarProps & { showClose?: boolean }) {
  const [portalContainer, setPortalContainer] = useState<HTMLDivElement | null>(null);
  const { data: meData, loading: meLoading } = authClient.useMe();
  const effectiveMe = meData ?? me ?? null;
  const activeOrganization = effectiveMe?.activeOrganization?.organization ?? null;
  const navItems = createNavItems();
  const sessionLoading = isLoading || (!effectiveMe && meLoading);

  return (
    <>
      <div className="flex h-full min-h-0 flex-col gap-4">
        <div className="flex items-center justify-between">
          <div>
            <p className="text-[10px] uppercase tracking-[0.24em] text-[var(--bo-muted-2)]">
              Fragno
            </p>
            <p className="text-lg font-semibold text-[var(--bo-fg)]">
              {activeOrganization?.name ?? "Backoffice"}
            </p>
          </div>
          <div className="flex items-center gap-2">
            <span className="border border-[color:var(--bo-border)] px-2 py-1 text-[10px] uppercase tracking-[0.22em] text-[var(--bo-muted-2)]">
              beta
            </span>
            {showClose ? (
              <Drawer.Close className="border border-[color:var(--bo-border)] px-2 py-1 text-[10px] uppercase tracking-[0.22em] text-[var(--bo-muted)] transition-colors hover:border-[color:var(--bo-border-strong)] hover:text-[var(--bo-fg)]">
                Close
              </Drawer.Close>
            ) : null}
          </div>
        </div>

        <Separator className="h-px w-full bg-[var(--bo-border)]" />

        <div className="backoffice-scroll min-h-0 flex-1 overflow-y-auto overflow-x-hidden pr-1">
          <div className="flex min-h-full flex-col gap-4 pb-4">
            <BackofficeSidebarSection title="Navigation">
              <nav aria-label="Backoffice">
                <ul className="space-y-3">
                  {navItems.map((item) => (
                    <li key={item.to} className="space-y-2">
                      <BackofficeSidebarLink to={item.to} label={item.label} end={item.end} />
                      {item.children ? (
                        <ul className="ml-3 space-y-2 border-l border-[color:var(--bo-border)] pl-3">
                          {item.children.map((child) => (
                            <li key={child.to}>
                              <BackofficeSidebarLink
                                to={child.to}
                                label={child.label}
                                end={child.end}
                                variant="sub"
                              />
                            </li>
                          ))}
                        </ul>
                      ) : null}
                    </li>
                  ))}
                </ul>
              </nav>
            </BackofficeSidebarSection>

            <BackofficeSidebarSection title="Shortcuts">
              <div className="flex flex-wrap gap-2">
                {["Draft releases", "Staging", "Audit logs", "Role map", "Help queue"].map(
                  (label) => (
                    <span
                      key={label}
                      className="border border-[color:var(--bo-border)] bg-[var(--bo-panel-2)] px-2 py-1 text-[10px] uppercase tracking-[0.22em] text-[var(--bo-muted-2)]"
                    >
                      {label}
                    </span>
                  ),
                )}
              </div>
            </BackofficeSidebarSection>

            <div className="mt-auto space-y-4">
              <BackofficeSidebarSection title="Theme">
                <BackofficeThemeToggle />
              </BackofficeSidebarSection>

              <BackofficeUserCard
                portalContainer={portalContainer}
                me={effectiveMe}
                isLoading={sessionLoading}
              />
            </div>
          </div>
        </div>
      </div>
      <div ref={setPortalContainer} />
    </>
  );
}

function BackofficeSidebarSection({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="space-y-2">
      <p className="text-[10px] uppercase tracking-[0.26em] text-[var(--bo-muted-2)]">{title}</p>
      {children}
    </div>
  );
}

function BackofficeSidebarLink({
  label,
  to,
  end,
  variant = "primary",
}: {
  label: string;
  to: string;
  end?: boolean;
  variant?: "primary" | "sub";
}) {
  const showSuffix = variant === "primary";
  return (
    <NavLink
      to={to}
      end={end}
      className={({ isActive }) =>
        cn(
          "flex items-center justify-between border px-3 py-2 font-semibold transition-colors",
          variant === "sub" ? "text-xs" : "text-sm",
          isActive
            ? "border-[color:var(--bo-accent)] bg-[var(--bo-accent-bg)] text-[var(--bo-accent-fg)]"
            : "border-[color:var(--bo-border)] bg-[var(--bo-panel-2)] text-[var(--bo-muted)] hover:border-[color:var(--bo-border-strong)] hover:text-[var(--bo-fg)]",
        )
      }
    >
      <span>{label}</span>
      {showSuffix ? (
        <span className="text-[10px] uppercase tracking-[0.22em] opacity-70">View</span>
      ) : null}
    </NavLink>
  );
}

function BackofficeUserCard({
  portalContainer,
  me,
  isLoading,
}: {
  portalContainer: HTMLDivElement | null;
  me: AuthMeData | null;
  isLoading?: boolean;
}) {
  const { mutate: signOut, loading: signingOut } = authClient.useSignOut();
  const navigate = useNavigate();
  const user = me?.user ?? null;

  const displayName = useMemo(() => {
    if (!user) {
      return null;
    }
    const handle = user.email.split("@")[0] ?? user.email;
    return handle
      .split(/[._-]+/)
      .map((part) => part.slice(0, 1).toUpperCase() + part.slice(1))
      .join(" ");
  }, [user]);

  const initials = useMemo(() => {
    if (!user) {
      return "--";
    }
    const handle = user.email.split("@")[0] ?? user.email;
    const parts = handle.split(/[._-]+/).filter(Boolean);
    const letters = parts.length > 0 ? parts : [handle];
    return letters
      .slice(0, 2)
      .map((part) => part.slice(0, 1).toUpperCase())
      .join("");
  }, [user]);

  if (isLoading) {
    return (
      <div className="border border-[color:var(--bo-border)] bg-[var(--bo-panel-2)] p-3 text-xs text-[var(--bo-muted)]">
        Checking session…
      </div>
    );
  }

  if (!user) {
    return (
      <div className="border border-[color:var(--bo-border)] bg-[var(--bo-panel-2)] p-3">
        <p className="text-xs text-[var(--bo-muted)]">Sign in to access the backoffice.</p>
        <Link
          to="/backoffice/login"
          className="mt-3 inline-flex w-full items-center justify-between border border-[color:var(--bo-border)] bg-[var(--bo-panel)] px-3 py-2 text-[11px] font-semibold uppercase tracking-[0.22em] text-[var(--bo-muted)] transition-colors hover:border-[color:var(--bo-border-strong)] hover:text-[var(--bo-fg)]"
        >
          Sign in
          <span className="text-[10px] text-[var(--bo-muted-2)]">GitHub</span>
        </Link>
      </div>
    );
  }

  return (
    <div className="border border-[color:var(--bo-border)] bg-[var(--bo-panel-2)] p-3">
      <div className="flex items-center gap-3">
        <div className="flex h-10 w-10 items-center justify-center border border-[color:var(--bo-border-strong)] bg-[var(--bo-panel)] text-sm font-semibold text-[var(--bo-fg)]">
          {initials}
        </div>
        <div>
          <p className="text-sm font-semibold text-[var(--bo-fg)]">{displayName}</p>
          <p className="text-xs text-[var(--bo-muted-2)]">{user.email}</p>
        </div>
      </div>

      <Menu.Root modal={false}>
        <Menu.Trigger className="mt-3 flex w-full items-center justify-between border border-[color:var(--bo-border)] bg-[var(--bo-panel)] px-3 py-2 text-left text-[11px] font-semibold uppercase tracking-[0.22em] text-[var(--bo-muted)] transition-colors hover:border-[color:var(--bo-border-strong)] hover:text-[var(--bo-fg)]">
          <span>Account</span>
          <span className="text-[10px] text-[var(--bo-muted-2)]">Menu</span>
        </Menu.Trigger>
        <Menu.Portal container={portalContainer ?? undefined}>
          <Menu.Positioner sideOffset={8} align="start">
            <Menu.Popup className="w-64 border border-[color:var(--bo-border-strong)] bg-[var(--bo-panel)] p-3 shadow-[0_10px_24px_rgba(15,23,42,0.14)] dark:shadow-[0_12px_32px_rgba(0,0,0,0.4)]">
              <Menu.Group className="space-y-2">
                <Menu.GroupLabel className="text-[10px] uppercase tracking-[0.24em] text-[var(--bo-muted-2)]">
                  Account
                </Menu.GroupLabel>
                <Menu.Item
                  onClick={() => navigate("/backoffice/organisations")}
                  className="flex w-full items-center justify-between border border-[color:var(--bo-border)] bg-[var(--bo-panel-2)] px-3 py-2 text-[10px] font-semibold uppercase tracking-[0.24em] text-[var(--bo-muted)] transition-colors data-[highlighted]:border-[color:var(--bo-border-strong)] data-[highlighted]:text-[var(--bo-fg)]"
                >
                  Manage organisations
                </Menu.Item>
                <Menu.Item
                  onClick={() => navigate("/backoffice/settings")}
                  className="flex w-full items-center justify-between border border-[color:var(--bo-border)] bg-[var(--bo-panel-2)] px-3 py-2 text-[10px] font-semibold uppercase tracking-[0.24em] text-[var(--bo-muted)] transition-colors data-[highlighted]:border-[color:var(--bo-border-strong)] data-[highlighted]:text-[var(--bo-fg)]"
                >
                  Settings
                </Menu.Item>
              </Menu.Group>
              <Menu.Separator className="my-3 h-px w-full bg-[var(--bo-border)]" />
              <Menu.Item
                onClick={async () => {
                  try {
                    await signOut({});
                  } finally {
                    navigate("/backoffice/login", { replace: true });
                  }
                }}
                disabled={signingOut}
                className="flex w-full items-center justify-between border border-[color:var(--bo-border)] bg-[var(--bo-panel-2)] px-3 py-2 text-[10px] font-semibold uppercase tracking-[0.24em] text-[var(--bo-muted)] transition-colors disabled:opacity-60 data-[highlighted]:border-[color:var(--bo-border-strong)] data-[highlighted]:text-[var(--bo-fg)]"
              >
                Sign out
              </Menu.Item>
            </Menu.Popup>
          </Menu.Positioner>
        </Menu.Portal>
      </Menu.Root>
    </div>
  );
}

function BackofficeThemeToggle() {
  const [mounted, setMounted] = useState(false);
  const [choice, setChoice] = useState<"light" | "dark" | "system">("system");

  const updateTheme = useCallback((nextTheme: "light" | "dark" | "system") => {
    setChoice(nextTheme);
    if (typeof window === "undefined") {
      return;
    }
    const root = document.documentElement;
    const prefersDark = window.matchMedia("(prefers-color-scheme: dark)").matches;
    const isDark = nextTheme === "dark" || (nextTheme === "system" && prefersDark);
    root.classList.toggle("dark", isDark);
    root.style.colorScheme = isDark ? "dark" : "light";
    try {
      window.localStorage.setItem("theme", nextTheme);
    } catch {
      // ignore
    }
    try {
      window.dispatchEvent(
        new StorageEvent("storage", {
          key: "theme",
          newValue: nextTheme,
        }),
      );
    } catch {
      // ignore
    }
  }, []);

  useEffect(() => {
    setMounted(true);
    if (typeof window === "undefined") {
      return;
    }
    const stored = window.localStorage.getItem("theme");
    const nextChoice =
      stored === "light" || stored === "dark" || stored === "system" ? stored : "system";
    setChoice(nextChoice);
    updateTheme(nextChoice);
  }, [updateTheme]);

  return (
    <div
      role="radiogroup"
      aria-label="Theme"
      className="flex border border-[color:var(--bo-border)] bg-[var(--bo-panel-2)]"
    >
      {(
        [
          { value: "light", label: "Light" },
          { value: "dark", label: "Dark" },
          { value: "system", label: "System" },
        ] as const
      ).map((option) => (
        <button
          key={option.value}
          type="button"
          role="radio"
          aria-checked={choice === option.value}
          disabled={!mounted}
          onClick={() => updateTheme(option.value)}
          className={cn(
            "flex-1 px-3 py-2 text-[11px] font-semibold uppercase tracking-[0.22em] transition-colors",
            choice === option.value
              ? "bg-[var(--bo-accent-bg)] text-[var(--bo-accent-fg)]"
              : "text-[var(--bo-muted)] hover:text-[var(--bo-fg)]",
            option.value !== "light" ? "border-l border-[color:var(--bo-border)]" : "",
          )}
        >
          {option.label}
        </button>
      ))}
    </div>
  );
}

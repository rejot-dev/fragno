import { Menu } from "@base-ui/react/menu";
import { useNavigate } from "react-router";

import type { IntegrationScopeSwitchOption } from "./scope";

const scopeKindLabel = (kind: IntegrationScopeSwitchOption["kind"]) => {
  switch (kind) {
    case "system":
      return "System";
    case "org":
      return "Org";
    case "project":
      return "Project";
    case "user":
      return "User";
  }
};

export function IntegrationScopeBreadcrumbSelector({
  label,
  options,
}: {
  label: string;
  options: IntegrationScopeSwitchOption[];
}) {
  const navigate = useNavigate();

  if (options.length <= 1) {
    return <span>{label}</span>;
  }

  return (
    <Menu.Root modal={false}>
      <Menu.Trigger
        type="button"
        className="inline-flex min-h-6 items-center gap-1 border border-transparent px-1.5 py-0.5 text-[10px] font-semibold tracking-[0.24em] text-[var(--bo-fg)] uppercase transition-colors hover:border-[color:var(--bo-border)] hover:bg-[var(--bo-panel-2)] data-[popup-open]:border-[color:var(--bo-border)] data-[popup-open]:bg-[var(--bo-panel-2)]"
      >
        <span>{label}</span>
        <span aria-hidden="true" className="text-[8px] text-[var(--bo-muted-2)]">
          ▾
        </span>
      </Menu.Trigger>
      <Menu.Portal style={{ position: "relative", zIndex: 2147483647 }}>
        <Menu.Positioner side="bottom" align="start" sideOffset={6} style={{ zIndex: 2147483647 }}>
          <Menu.Popup className="relative max-h-[min(22rem,calc(100vh-8rem))] w-64 overflow-y-auto border border-[color:var(--bo-border-strong)] bg-[var(--bo-panel)] p-1.5 text-left tracking-normal shadow-[0_18px_50px_rgba(15,23,42,0.22)] outline-none dark:shadow-[0_22px_60px_rgba(0,0,0,0.55)]">
            <Menu.Group className="space-y-1">
              <Menu.GroupLabel className="px-2 py-1 text-[9px] font-semibold tracking-[0.24em] text-[var(--bo-muted-2)] uppercase">
                Switch scope
              </Menu.GroupLabel>
              {options.map((option) => {
                const isCurrent = option.label === label;
                return (
                  <Menu.Item
                    key={option.id}
                    disabled={isCurrent}
                    onClick={() => {
                      if (!isCurrent) {
                        void navigate(option.to);
                      }
                    }}
                    className={
                      isCurrent
                        ? "grid cursor-default gap-1 border border-[color:var(--bo-accent)] bg-[var(--bo-accent-bg)] px-2.5 py-2 text-left text-[var(--bo-accent-fg)] outline-none"
                        : "grid gap-1 border border-transparent px-2.5 py-2 text-left text-[var(--bo-muted)] transition-colors outline-none data-[highlighted]:border-[color:var(--bo-border-strong)] data-[highlighted]:bg-[var(--bo-panel-2)] data-[highlighted]:text-[var(--bo-fg)]"
                    }
                  >
                    <span className="flex min-w-0 items-center justify-between gap-3">
                      <span className="truncate text-sm font-medium tracking-normal text-[var(--bo-fg)] normal-case">
                        {option.label}
                      </span>
                      <span className="shrink-0 text-[9px] font-semibold tracking-[0.18em] text-[var(--bo-muted-2)] uppercase">
                        {scopeKindLabel(option.kind)}
                      </span>
                    </span>
                    <span className="truncate text-xs tracking-normal text-[var(--bo-muted-2)] normal-case">
                      {option.description}
                    </span>
                  </Menu.Item>
                );
              })}
            </Menu.Group>
          </Menu.Popup>
        </Menu.Positioner>
      </Menu.Portal>
    </Menu.Root>
  );
}

import { Menu } from "@base-ui/react/menu";
import { Link } from "react-router";

export type BackofficeOrganisationScopeOption = {
  id: string;
  label: string;
};

export function BackofficeOrganisationScopeMenu({
  activeOrganisationId,
  activeOrganisationLabel,
  options,
  pathForOption,
  scopeLabel,
}: {
  activeOrganisationId: string;
  activeOrganisationLabel: string;
  options: BackofficeOrganisationScopeOption[];
  pathForOption: (option: BackofficeOrganisationScopeOption) => string;
  scopeLabel: string;
}) {
  return (
    <Menu.Root modal={false}>
      <Menu.Trigger
        type="button"
        aria-label={`Switch organisation. Current organisation: ${activeOrganisationLabel}`}
        className="group flex min-h-10 w-full min-w-0 items-center gap-2.5 border border-[color:var(--bo-border)] bg-[var(--bo-panel-2)] py-2 pr-2.5 pl-3 text-left transition-[scale,background-color,border-color,color] duration-150 ease-out outline-none hover:border-[color:var(--bo-border-strong)] focus-visible:ring-2 focus-visible:ring-[color:var(--bo-accent)]/30 active:scale-[0.96] data-[popup-open]:border-[color:var(--bo-accent)] data-[popup-open]:bg-[var(--bo-accent-bg)] sm:w-auto"
      >
        <span className="hidden shrink-0 text-[8px] font-semibold tracking-[0.18em] text-[var(--bo-muted-2)] uppercase group-data-[popup-open]:text-[var(--bo-accent-fg)] lg:inline">
          {scopeLabel}
        </span>
        <span
          className="hidden h-4 w-px shrink-0 bg-[var(--bo-border-strong)] lg:block"
          aria-hidden="true"
        />
        <span className="flex min-w-0 flex-1 items-center gap-1.5">
          <span className="shrink-0 text-[9px] font-semibold tracking-[0.16em] text-[var(--bo-muted-2)] uppercase">
            Org
          </span>
          <span className="text-[var(--bo-muted-2)]" aria-hidden="true">
            ·
          </span>
          <span className="min-w-0 truncate text-sm font-medium tracking-normal text-[var(--bo-fg)] normal-case">
            {activeOrganisationLabel}
          </span>
        </span>
        <span
          aria-hidden="true"
          className="shrink-0 text-xs text-[var(--bo-muted-2)] transition-transform duration-150 ease-out group-data-[popup-open]:rotate-180 group-data-[popup-open]:text-[var(--bo-accent-fg)]"
        >
          ▾
        </span>
      </Menu.Trigger>

      <Menu.Portal style={{ position: "relative", zIndex: 2147483647 }}>
        <Menu.Positioner side="bottom" align="end" sideOffset={10} style={{ zIndex: 2147483647 }}>
          <Menu.Popup
            data-backoffice-root
            className="relative max-h-[min(32rem,calc(100vh-6rem))] w-[min(24rem,calc(100vw-2rem))] origin-top-left overflow-y-auto border border-[color:var(--bo-border-strong)] bg-[var(--bo-panel)] p-2 text-left tracking-normal text-[var(--bo-fg)] shadow-[0_18px_50px_rgba(15,23,42,0.2)] transition-[opacity,transform] duration-150 ease-out outline-none data-[ending-style]:-translate-y-1 data-[ending-style]:opacity-0 data-[starting-style]:-translate-y-1 data-[starting-style]:opacity-0 dark:shadow-[0_22px_60px_rgba(0,0,0,0.55)]"
          >
            <p className="px-2 py-1 text-[10px] font-semibold tracking-[0.24em] text-[var(--bo-muted-2)] uppercase">
              Switch organisation
            </p>
            <Menu.Separator className="my-2 h-px bg-[var(--bo-border)]" />
            <Menu.Group className="space-y-1">
              {options.map((option) => {
                const isCurrent = option.id === activeOrganisationId;
                const content = (
                  <>
                    <span className="truncate text-sm font-medium text-[var(--bo-fg)]">
                      {option.label}
                    </span>
                    <span className="truncate text-xs text-[var(--bo-muted-2)]">{option.id}</span>
                  </>
                );

                return isCurrent ? (
                  <Menu.Item
                    key={option.id}
                    disabled
                    className="grid min-h-11 cursor-default gap-1 border border-[color:var(--bo-accent)] bg-[var(--bo-accent-bg)] px-2.5 py-2 text-left outline-none"
                  >
                    {content}
                  </Menu.Item>
                ) : (
                  <Menu.Item
                    key={option.id}
                    render={<Link to={pathForOption(option)} />}
                    className="grid min-h-11 gap-1 border border-transparent px-2.5 py-2 text-left transition-[background-color,border-color,color] duration-150 ease-out outline-none data-[highlighted]:border-[color:var(--bo-border-strong)] data-[highlighted]:bg-[var(--bo-panel-2)] data-[highlighted]:text-[var(--bo-fg)]"
                  >
                    {content}
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

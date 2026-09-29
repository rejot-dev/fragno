import {
  SelectorMenu,
  SelectorMenuButton,
  SelectorMenuGroup,
  SelectorMenuHeading,
  SelectorMenuLink,
  SelectorMenuNote,
  SelectorMenuOption,
  SelectorMenuPopup,
  SelectorMenuTrigger,
} from "./selector-menu";

export default { title: "Controls/Selector menu" };

export function Options() {
  return (
    <div className="flex h-16 w-72 items-stretch border border-[color:var(--bo-border)]">
      <SelectorMenu>
        <SelectorMenuTrigger
          label="Organization"
          value="Acme Inc."
          ariaLabel="Switch scope. Current context: Acme Inc."
          layout={{ kind: "fill" }}
        />
        <SelectorMenuPopup align="start" height="capped">
          <SelectorMenuGroup label="Organizations">
            <SelectorMenuOption
              to="/acme"
              label="Acme Inc."
              description={null}
              badge={null}
              current
            />
            <SelectorMenuOption
              to="/globex"
              label="Globex"
              description={null}
              badge={null}
              current={false}
            />
          </SelectorMenuGroup>
          <SelectorMenuGroup label={null}>
            <SelectorMenuNote tone="muted">Synchronizing…</SelectorMenuNote>
            <SelectorMenuNote tone="error">Unable to load projects.</SelectorMenuNote>
          </SelectorMenuGroup>
        </SelectorMenuPopup>
      </SelectorMenu>
    </div>
  );
}

export function Collapsed() {
  return (
    <div className="flex h-16 w-16 items-stretch border border-[color:var(--bo-border)]">
      <SelectorMenu>
        <SelectorMenuTrigger
          label="Organization"
          value="Acme Inc."
          ariaLabel="Switch scope. Current context: Acme Inc."
          layout={{
            kind: "workspace",
            mark: { kind: "letter", letter: "A" },
            color: { kind: "primary" },
            collapsed: true,
          }}
        />
        <SelectorMenuPopup align="start" height="capped">
          <SelectorMenuGroup label="Organizations">
            <SelectorMenuOption
              to="/acme"
              label="Acme Inc."
              description={null}
              badge={null}
              current
            />
          </SelectorMenuGroup>
        </SelectorMenuPopup>
      </SelectorMenu>
    </div>
  );
}

export function Empty() {
  return (
    <div className="flex h-16 w-72 items-stretch border border-[color:var(--bo-border)]">
      <SelectorMenu>
        <SelectorMenuTrigger
          label="Project"
          value={null}
          ariaLabel="Switch project"
          layout={{ kind: "fill" }}
        />
        <SelectorMenuPopup align="start" height="capped">
          <SelectorMenuHeading>Switch project</SelectorMenuHeading>
          <SelectorMenuGroup label={null}>
            <SelectorMenuNote tone="muted">This organization has no projects yet.</SelectorMenuNote>
          </SelectorMenuGroup>
        </SelectorMenuPopup>
      </SelectorMenu>
    </div>
  );
}

export function Actions() {
  return (
    <div className="flex h-16 justify-end border border-[color:var(--bo-border)]">
      <SelectorMenu>
        <SelectorMenuTrigger
          label="Account"
          value="Ada Lovelace"
          ariaLabel="Open account menu for Ada Lovelace"
          layout={{ kind: "hug", initials: "AL" }}
        />
        <SelectorMenuPopup align="end" height="content" className="w-72">
          <SelectorMenuGroup label="Workspace">
            <SelectorMenuLink to="/settings" icon="settings">
              Settings
            </SelectorMenuLink>
          </SelectorMenuGroup>
          <SelectorMenuGroup label={null}>
            <SelectorMenuButton icon="log-out" disabled={false} onClick={() => undefined}>
              Sign out
            </SelectorMenuButton>
          </SelectorMenuGroup>
        </SelectorMenuPopup>
      </SelectorMenu>
    </div>
  );
}

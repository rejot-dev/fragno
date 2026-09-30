import { AppearanceSubmenu, useAppearancePreferences } from "./appearance-menu";
import { SelectorMenu, SelectorMenuPopup, SelectorMenuTrigger } from "./selector-menu";

export default { title: "Controls/Appearance menu" };

// Writes to this origin's localStorage and toggles `.dark` on <html>, overriding the toolbar theme
// until the page reloads.
export function Default() {
  const preferences = useAppearancePreferences();

  return (
    <div className="flex h-16 w-72 items-stretch border border-[color:var(--bo-border)]">
      <SelectorMenu>
        <SelectorMenuTrigger
          label="Account"
          value="Ada Lovelace"
          ariaLabel="Open account menu"
          layout={{ kind: "fill" }}
        />
        <SelectorMenuPopup align="start" height="content">
          <AppearanceSubmenu preferences={preferences} />
        </SelectorMenuPopup>
      </SelectorMenu>
    </div>
  );
}

import { Menu } from "@base-ui/react/menu";

import {
  appearanceThemeIcon,
  isThemeChoice,
  type AppearancePreferences,
} from "./appearance-preferences";
import { Icon } from "./icon";
import { SelectorSubmenu } from "./selector-menu";

// Following the system comes first, as the default that most people keep.
const THEME_OPTIONS = [
  { value: "system", label: "System", icon: "monitor" },
  { value: "light", label: "Light", icon: "sun" },
  { value: "dark", label: "Dark", icon: "moon" },
] as const;

const ITEM_CLASS_NAME =
  "group flex min-h-10 cursor-pointer items-center gap-3 rounded-[4px] px-2.5 text-sm font-medium text-[var(--bo-fg)] outline-none transition-[background-color,box-shadow] duration-150 ease-out data-[highlighted]:bg-[var(--bo-panel-2)]";

const ITEM_ICON_CLASS_NAME =
  "size-4 shrink-0 text-[var(--bo-muted)] transition-colors duration-150 ease-out group-data-[highlighted]:text-[var(--bo-fg)]";

// The theme choices and the reduced-motion switch, as items of an open menu. Items stay open on
// click so the change is visible while the menu is still showing.
export function AppearanceOptions({ preferences }: { preferences: AppearancePreferences }) {
  return (
    <>
      <Menu.RadioGroup
        value={preferences.theme}
        aria-label="Theme"
        onValueChange={(value) => {
          if (isThemeChoice(value)) {
            preferences.setTheme(value);
          }
        }}
        className="flex flex-col gap-0.5"
      >
        {THEME_OPTIONS.map(({ value, label, icon }) => (
          <Menu.RadioItem
            key={value}
            value={value}
            closeOnClick={false}
            className={`${ITEM_CLASS_NAME} data-[checked]:bg-[var(--bo-selected-bg)] data-[checked]:shadow-[var(--bo-selected-shadow)]`}
          >
            <Icon name={icon} className={ITEM_ICON_CLASS_NAME} strokeWidth={1.75} />
            <span className="flex-1">{label}</span>
            <Menu.RadioItemIndicator className="text-[var(--bo-accent)]">
              <Icon name="check" className="size-4" />
            </Menu.RadioItemIndicator>
          </Menu.RadioItem>
        ))}
      </Menu.RadioGroup>

      <Menu.Separator className="mx-1 my-1.5 h-px bg-[var(--bo-border)]" />

      <Menu.CheckboxItem
        checked={preferences.reducedMotion}
        onCheckedChange={preferences.setReducedMotion}
        closeOnClick={false}
        className={ITEM_CLASS_NAME}
      >
        <Icon name="eye" className={ITEM_ICON_CLASS_NAME} strokeWidth={1.75} />
        <span className="flex-1">Reduced motion</span>
        <span
          aria-hidden="true"
          className="inline-flex h-5 w-9 shrink-0 items-center rounded-full bg-[var(--bo-border)] p-0.5 transition-[background-color] duration-150 ease-out group-data-[checked]:bg-[var(--bo-accent)]"
        >
          <span className="size-4 rounded-full bg-white shadow-[0_1px_2px_rgba(0,0,0,0.2)] transition-transform duration-150 ease-out group-data-[checked]:translate-x-4" />
        </span>
      </Menu.CheckboxItem>
    </>
  );
}

// Selector-menu submenu for choosing the theme and motion preference.
export function AppearanceSubmenu({ preferences }: { preferences: AppearancePreferences }) {
  return (
    <SelectorSubmenu icon={appearanceThemeIcon(preferences)} label="Appearance">
      <AppearanceOptions preferences={preferences} />
    </SelectorSubmenu>
  );
}

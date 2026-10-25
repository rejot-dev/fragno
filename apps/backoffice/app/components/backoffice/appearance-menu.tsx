import { AppearanceOptions } from "@fragno-private/design-system/appearance-menu";
import {
  appearanceThemeIcon,
  useAppearancePreferences,
} from "@fragno-private/design-system/appearance-preferences";
import { ButtonLink } from "@fragno-private/design-system/button";
import {
  SelectorMenu,
  SelectorMenuPopup,
  SelectorMenuTrigger,
} from "@fragno-private/design-system/selector-menu";

import type { BackofficeMeData } from "@/fragno/auth/contracts";

/**
 * How Backoffice looks: the theme and reduced motion, behind the chosen theme's icon. Who is signed
 * in and signing out are in the scope menu; everything else the user opens is in the sidebar.
 */
export function BackofficeAppearanceMenu({
  me,
  isLoading,
}: {
  me: BackofficeMeData | null;
  isLoading?: boolean;
}) {
  // Called before the early returns so the stored appearance is applied even while signed out.
  const appearance = useAppearancePreferences();

  if (isLoading) {
    return (
      <div
        aria-label="Checking session"
        className="bo-control-surface flex size-10 items-center justify-center bg-[var(--bo-panel)] text-[10px] font-semibold text-[var(--bo-muted-2)]"
      >
        …
      </div>
    );
  }

  if (!me?.user) {
    return (
      <ButtonLink to="/backoffice/login" variant="secondary">
        Sign in
      </ButtonLink>
    );
  }

  return (
    <SelectorMenu>
      <SelectorMenuTrigger
        label="Appearance"
        value={null}
        ariaLabel="Appearance"
        layout={{ kind: "icon", icon: appearanceThemeIcon(appearance) }}
      />
      <SelectorMenuPopup align="end" height="content" className="w-[min(16rem,calc(100vw-1rem))]">
        <AppearanceOptions preferences={appearance} />
      </SelectorMenuPopup>
    </SelectorMenu>
  );
}

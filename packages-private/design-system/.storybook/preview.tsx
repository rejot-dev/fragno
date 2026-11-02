import "./storybook.css";

import { type ReactNode, useLayoutEffect } from "react";
import { MemoryRouter } from "react-router";

import type { Preview } from "@storybook/react-vite";

type BackofficeTheme = "light" | "dark";
/** Whether animations run: as the system prefers, or as if chosen in the appearance menu. */
type BackofficeMotion = "system" | "on" | "off";

// Stories render outside Backoffice, so this supplies what the app shell normally does: the
// `.dark` class the theme keys off, the motion choice the appearance menu sets, the
// [data-backoffice-root] scope the --bo-* tokens live under, and a router for components that
// render links.
function BackofficeFrame({
  theme,
  motion,
  children,
}: {
  theme: BackofficeTheme;
  motion: BackofficeMotion;
  children: ReactNode;
}) {
  const isDark = theme === "dark";

  useLayoutEffect(() => {
    document.documentElement.classList.toggle("dark", isDark);
    document.documentElement.style.colorScheme = isDark ? "dark" : "light";
  }, [isDark]);

  useLayoutEffect(() => {
    const root = document.documentElement;
    if (motion === "system") {
      delete root.dataset.reducedMotion;
    } else {
      root.dataset.reducedMotion = motion === "on" ? "no-preference" : "reduce";
    }
  }, [motion]);

  return (
    <MemoryRouter>
      <div
        data-backoffice-root
        className="min-h-screen bg-[var(--bo-bg)] p-6 font-sans text-[var(--bo-fg)]"
      >
        {children}
      </div>
    </MemoryRouter>
  );
}

const preview: Preview = {
  globalTypes: {
    theme: {
      description: "Backoffice color theme",
      toolbar: {
        title: "Theme",
        icon: "mirror",
        items: [
          { value: "light", title: "Light", icon: "sun" },
          { value: "dark", title: "Dark", icon: "moon" },
        ],
        dynamicTitle: true,
      },
    },
    motion: {
      description: "Whether animations run, overriding the system's reduced-motion preference",
      toolbar: {
        title: "Motion",
        icon: "play",
        items: [
          { value: "system", title: "Motion: system" },
          { value: "on", title: "Motion: on" },
          { value: "off", title: "Motion: reduced" },
        ],
        dynamicTitle: true,
      },
    },
  },
  initialGlobals: { theme: "light", motion: "system" },
  parameters: { layout: "fullscreen" },
  decorators: [
    (Story, context) => (
      <BackofficeFrame
        theme={context.globals.theme === "dark" ? "dark" : "light"}
        motion={
          context.globals.motion === "on" || context.globals.motion === "off"
            ? context.globals.motion
            : "system"
        }
      >
        <Story />
      </BackofficeFrame>
    ),
  ],
};

export default preview;

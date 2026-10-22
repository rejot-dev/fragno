import "./storybook.css";

import { type ReactNode, useLayoutEffect } from "react";
import { MemoryRouter } from "react-router";

import type { Preview } from "@storybook/react-vite";

type BackofficeTheme = "light" | "dark";

// Stories render outside Backoffice, so this supplies what the app shell normally does: the
// `.dark` class the theme keys off, the [data-backoffice-root] scope the --bo-* tokens live
// under, and a router for components that render links.
function BackofficeFrame({ theme, children }: { theme: BackofficeTheme; children: ReactNode }) {
  const isDark = theme === "dark";

  useLayoutEffect(() => {
    document.documentElement.classList.toggle("dark", isDark);
    document.documentElement.style.colorScheme = isDark ? "dark" : "light";
  }, [isDark]);

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
  },
  initialGlobals: { theme: "light" },
  parameters: { layout: "fullscreen" },
  decorators: [
    (Story, context) => (
      <BackofficeFrame theme={context.globals.theme === "dark" ? "dark" : "light"}>
        <Story />
      </BackofficeFrame>
    ),
  ],
};

export default preview;

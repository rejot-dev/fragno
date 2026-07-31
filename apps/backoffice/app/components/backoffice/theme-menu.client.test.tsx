// @vitest-environment happy-dom

import { afterEach, describe, test, vi, assert } from "vitest";

import { cleanup, render, waitFor } from "@testing-library/react";

import { BackofficeThemeMenu } from "./theme-menu";

function mediaQueryList(media: string, matches: boolean): MediaQueryList {
  return {
    matches,
    media,
    onchange: null,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    addListener: vi.fn(),
    removeListener: vi.fn(),
    dispatchEvent: vi.fn(() => true),
  };
}

function installAppearancePreferences({ reducedMotion }: { reducedMotion: boolean }) {
  vi.stubGlobal("matchMedia", (query: string) =>
    mediaQueryList(query, query === "(prefers-reduced-motion: reduce)" && reducedMotion),
  );
}

afterEach(() => {
  cleanup();
  window.localStorage.clear();
  delete document.documentElement.dataset.reducedMotion;
  vi.unstubAllGlobals();
});

describe("BackofficeThemeMenu", () => {
  test("follows the system motion preference when no override is stored", async () => {
    installAppearancePreferences({ reducedMotion: true });
    render(<BackofficeThemeMenu />);

    await waitFor(() => {
      assert(document.documentElement.dataset.reducedMotion === "reduce");
    });
  });

  test("restores a persisted motion preference instead of the system preference", async () => {
    installAppearancePreferences({ reducedMotion: true });
    window.localStorage.setItem("reduced-motion", "no-preference");

    render(<BackofficeThemeMenu />);

    await waitFor(() => {
      assert(document.documentElement.dataset.reducedMotion === "no-preference");
    });
  });
});

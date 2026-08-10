import { assert, describe, test } from "vitest";

import { matchesGlobalHotkey } from "./global-hotkey-definition";

const keyboardEvent = (
  overrides: Partial<{
    altKey: boolean;
    ctrlKey: boolean;
    key: string;
    metaKey: boolean;
    repeat: boolean;
    shiftKey: boolean;
  }> = {},
) => ({
  altKey: false,
  ctrlKey: false,
  key: "i",
  metaKey: false,
  repeat: false,
  shiftKey: false,
  ...overrides,
});

describe("matchesGlobalHotkey", () => {
  test("matches the primary modifier on macOS and other platforms", () => {
    const definition = { key: "i", modifiers: { primary: true } };

    assert(matchesGlobalHotkey(keyboardEvent({ metaKey: true }), definition));
    assert(matchesGlobalHotkey(keyboardEvent({ ctrlKey: true }), definition));
  });

  test("rejects missing or additional modifiers", () => {
    const definition = { key: "i", modifiers: { primary: true } };

    assert(!matchesGlobalHotkey(keyboardEvent(), definition));
    assert(!matchesGlobalHotkey(keyboardEvent({ metaKey: true, shiftKey: true }), definition));
  });

  test("ignores repeated keydown events unless explicitly enabled", () => {
    assert(
      !matchesGlobalHotkey(keyboardEvent({ metaKey: true, repeat: true }), {
        key: "i",
        modifiers: { primary: true },
      }),
    );
    assert(
      matchesGlobalHotkey(keyboardEvent({ metaKey: true, repeat: true }), {
        key: "i",
        modifiers: { primary: true },
        allowRepeat: true,
      }),
    );
  });
});

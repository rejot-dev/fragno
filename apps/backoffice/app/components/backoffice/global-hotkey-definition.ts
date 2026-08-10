import type { KeyboardEvent as ReactKeyboardEvent } from "react";

type GlobalHotkeyModifiers = {
  primary?: boolean;
  alt?: boolean;
  shift?: boolean;
};

export type GlobalHotkeyDefinition = {
  key: string;
  modifiers?: GlobalHotkeyModifiers;
  allowRepeat?: boolean;
  preventDefault?: boolean;
};

export function matchesGlobalHotkey(
  event: Pick<
    KeyboardEvent | ReactKeyboardEvent,
    "altKey" | "ctrlKey" | "key" | "metaKey" | "repeat" | "shiftKey"
  >,
  definition: GlobalHotkeyDefinition,
): boolean {
  if (!definition.allowRepeat && event.repeat) {
    return false;
  }

  const modifiers = definition.modifiers ?? {};
  const primaryPressed = event.metaKey || event.ctrlKey;
  return (
    event.key.toLowerCase() === definition.key.toLowerCase() &&
    primaryPressed === Boolean(modifiers.primary) &&
    event.altKey === Boolean(modifiers.alt) &&
    event.shiftKey === Boolean(modifiers.shift)
  );
}

import { createContext, useContext, useEffect, useMemo, useRef, type ReactNode } from "react";

import { matchesGlobalHotkey, type GlobalHotkeyDefinition } from "./global-hotkey-definition";

type GlobalHotkeyRegistration = GlobalHotkeyDefinition & {
  id: string;
  handler: (event: KeyboardEvent) => void;
};

type GlobalHotkeyRegistry = {
  register: (hotkey: GlobalHotkeyRegistration) => () => void;
};

const GlobalHotkeyContext = createContext<GlobalHotkeyRegistry | null>(null);

export function GlobalHotkeysProvider({ children }: { children: ReactNode }) {
  const hotkeysRef = useRef(new Map<string, GlobalHotkeyRegistration>());
  const registry = useMemo<GlobalHotkeyRegistry>(
    () => ({
      register(hotkey) {
        hotkeysRef.current.set(hotkey.id, hotkey);
        return () => {
          if (hotkeysRef.current.get(hotkey.id) === hotkey) {
            hotkeysRef.current.delete(hotkey.id);
          }
        };
      },
    }),
    [],
  );

  useEffect(() => {
    const handleGlobalKeyDown = (event: KeyboardEvent) => {
      const registeredHotkeys = [...hotkeysRef.current.values()].reverse();
      const hotkey = registeredHotkeys.find((candidate) => matchesGlobalHotkey(event, candidate));
      if (!hotkey) {
        return;
      }
      if (hotkey.preventDefault !== false) {
        event.preventDefault();
      }
      hotkey.handler(event);
    };

    document.addEventListener("keydown", handleGlobalKeyDown, { capture: true });
    return () => {
      document.removeEventListener("keydown", handleGlobalKeyDown, { capture: true });
    };
  }, []);

  return <GlobalHotkeyContext.Provider value={registry}>{children}</GlobalHotkeyContext.Provider>;
}

export function useGlobalHotkey(
  definition: GlobalHotkeyDefinition & {
    id: string;
    enabled?: boolean;
    handler: (event: KeyboardEvent) => void;
  },
) {
  const registry = useContext(GlobalHotkeyContext);
  const handlerRef = useRef(definition.handler);
  const modifierAlt = definition.modifiers?.alt;
  const modifierPrimary = definition.modifiers?.primary;
  const modifierShift = definition.modifiers?.shift;

  useEffect(() => {
    handlerRef.current = definition.handler;
  }, [definition.handler]);

  useEffect(() => {
    if (!registry || definition.enabled === false) {
      return undefined;
    }

    return registry.register({
      id: definition.id,
      key: definition.key,
      code: definition.code,
      modifiers: {
        alt: modifierAlt,
        primary: modifierPrimary,
        shift: modifierShift,
      },
      allowRepeat: definition.allowRepeat,
      preventDefault: definition.preventDefault,
      handler(event) {
        handlerRef.current(event);
      },
    });
  }, [
    definition.allowRepeat,
    definition.enabled,
    definition.id,
    definition.key,
    definition.code,
    modifierAlt,
    modifierPrimary,
    modifierShift,
    definition.preventDefault,
    registry,
  ]);
}

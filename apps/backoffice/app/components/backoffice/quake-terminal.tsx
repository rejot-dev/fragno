import { TerminalOverlay, TerminalScopeMenu } from "@fragno-private/design-system/terminal";
import { useEffect, useMemo, useState } from "react";
import { createPortal } from "react-dom";

import {
  backofficeResolvedScopeId,
  type BackofficeScopeSelection,
} from "@/backoffice-runtime/resolved-scope";
import type { BackofficeMeData } from "@/fragno/auth/contracts";
import {
  type DashboardCommandSpec,
  type DashboardTerminalScope,
  recordDashboardTerminalArrival,
} from "@/routes/backoffice/dashboard-terminal";
import { DashboardTerminalPanel } from "@/routes/backoffice/dashboard-terminal-panel";
import { loadBackofficeTerminalCommandSpecs } from "@/routes/backoffice/terminal-command-spec-loader.client";

import { useGlobalHotkey } from "./global-hotkeys";
import { terminalScopes, type TerminalScope } from "./terminal-scope";

type QuakeTerminalProps = {
  pageScope: BackofficeScopeSelection;
  me: BackofficeMeData | null;
};

const EMPTY_TERMINAL_COMMAND_SPECS: readonly DashboardCommandSpec[] = [];

const SCOPE_MENU_GROUPS: readonly TerminalScope["group"][] = [
  "This page",
  "System",
  "Organizations",
  "Personal",
];

function isEditableKeyboardTarget(target: EventTarget | null) {
  return (
    target instanceof HTMLInputElement ||
    target instanceof HTMLTextAreaElement ||
    (target instanceof HTMLElement && target.isContentEditable)
  );
}

function isTerminalCommandLine(target: EventTarget | null): target is HTMLTextAreaElement {
  return target instanceof HTMLTextAreaElement && target.name === "command";
}

/**
 * The terminal runs in the page's scope until switched with `use` or its scope menu, and follows
 * the page again once the page moves to another scope.
 */
export function QuakeTerminal({ pageScope, me }: QuakeTerminalProps) {
  const [mounted, setMounted] = useState(false);
  const [open, setOpen] = useState(false);
  const [commandSpecs, setCommandSpecs] = useState<readonly DashboardCommandSpec[] | null>(null);
  const [switched, setSwitched] = useState<{ pageScopeId: string; scopeId: string } | null>(null);
  const [scopeMenuOpen, setScopeMenuOpen] = useState(false);
  const pageScopeId = backofficeResolvedScopeId(pageScope);
  // The shell rebuilds the page scope every render; keep the scopes stable unless what the
  // terminal reads from it changes, since completions and their effects key off them.
  const scopes = useMemo(() => terminalScopes(me, pageScope), [me, pageScopeId, pageScope.label]);
  const scope =
    (switched?.pageScopeId === scopes.page.id
      ? scopes.all.find((candidate) => candidate.id === switched.scopeId)
      : undefined) ?? scopes.page;

  function switchScope(next: DashboardTerminalScope, command: string) {
    recordDashboardTerminalArrival({ scope: next, from: scope, command });
    setSwitched({ pageScopeId: scopes.page.id, scopeId: next.id });
  }

  useEffect(() => {
    setMounted(true);
  }, []);

  useGlobalHotkey({
    id: "toggle-quake-terminal",
    key: "`",
    code: "Backquote",
    modifiers: { primary: true },
    handler() {
      setOpen((currentOpen) => !currentOpen);
    },
  });
  useGlobalHotkey({
    id: "toggle-quake-terminal-with-backquote",
    key: "`",
    code: "Backquote",
    preventDefault: false,
    handler(event) {
      if (isTerminalCommandLine(event.target)) {
        if (open && event.target.value.length === 0) {
          event.preventDefault();
          setOpen(false);
        }
        return;
      }
      if (isEditableKeyboardTarget(event.target)) {
        return;
      }
      event.preventDefault();
      setOpen((currentOpen) => !currentOpen);
    },
  });
  useGlobalHotkey({
    id: "close-quake-terminal",
    key: "Escape",
    // Escape first closes what is open inside the terminal: the scope menu, or suggestions.
    enabled: open && !scopeMenuOpen,
    handler(event) {
      if (
        isTerminalCommandLine(event.target) &&
        event.target.getAttribute("aria-expanded") === "true"
      ) {
        return;
      }
      setOpen(false);
    },
  });

  useEffect(() => {
    if (!open || commandSpecs) {
      return undefined;
    }

    let active = true;
    void loadBackofficeTerminalCommandSpecs()
      .then((loadedCommandSpecs) => {
        if (active) {
          setCommandSpecs(loadedCommandSpecs);
        }
      })
      .catch((error: unknown) => {
        console.error("Backoffice terminal command metadata failed to load", error);
      });
    return () => {
      active = false;
    };
  }, [commandSpecs, open]);

  if (!mounted) {
    return null;
  }

  return createPortal(
    <TerminalOverlay
      open={open}
      label={`${scope.label} terminal`}
      scope={
        <TerminalScopeMenu
          open={scopeMenuOpen}
          onOpenChange={setScopeMenuOpen}
          label={scope.label}
          groups={SCOPE_MENU_GROUPS.map((group) => ({
            label: group,
            choices: scopes.all
              .filter((candidate) => candidate.group === group)
              .map((candidate) => ({
                id: candidate.id,
                name: candidate.name,
                label: candidate.label,
                current: candidate.id === scope.id,
              })),
          }))}
          onChoose={(id) => {
            const next = scopes.all.find((candidate) => candidate.id === id);
            if (next) {
              switchScope(next, `use ${next.name}`);
            }
          }}
        />
      }
      hint="⏎ run · \⏎ new line · Tab complete · ^R history · ^L clear · ^O scope"
      shortcut="` · ⌃`"
      onClose={() => {
        setOpen(false);
      }}
    >
      <DashboardTerminalPanel
        key={scope.actionPath}
        scope={scope}
        scopes={scopes.all}
        commandSpecs={commandSpecs ?? EMPTY_TERMINAL_COMMAND_SPECS}
        focusInput={open}
        onSwitchScope={switchScope}
        onOpenScopeMenu={() => {
          setScopeMenuOpen(true);
        }}
      />
    </TerminalOverlay>,
    document.body,
  );
}

import { useEffect, useState } from "react";
import { createPortal } from "react-dom";

import type { BackofficeScopeSelection } from "@/backoffice-runtime/resolved-scope";
import {
  automationScopeBasePath,
  automationScopeTerminalCommandPath,
} from "@/routes/backoffice/automations/scope";
import type { DashboardCommandSpec } from "@/routes/backoffice/dashboard-terminal";
import { DashboardTerminalPanel } from "@/routes/backoffice/dashboard-terminal-panel";
import { loadBackofficeTerminalCommandSpecs } from "@/routes/backoffice/terminal-command-spec-loader.client";

import { useGlobalHotkey } from "./global-hotkeys";

type QuakeTerminalProps = {
  selectedScope: BackofficeScopeSelection;
};

const EMPTY_TERMINAL_COMMAND_SPECS: readonly DashboardCommandSpec[] = [];

function isEditableKeyboardTarget(target: EventTarget | null) {
  return (
    target instanceof HTMLInputElement ||
    target instanceof HTMLTextAreaElement ||
    (target instanceof HTMLElement && target.isContentEditable)
  );
}

export function QuakeTerminal({ selectedScope }: QuakeTerminalProps) {
  const [mounted, setMounted] = useState(false);
  const [open, setOpen] = useState(false);
  const [commandSpecs, setCommandSpecs] = useState<readonly DashboardCommandSpec[] | null>(null);
  const scopePath = automationScopeBasePath(selectedScope);

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
      if (event.target instanceof HTMLInputElement && event.target.name === "command") {
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
    enabled: open,
    handler(event) {
      if (
        event.target instanceof HTMLInputElement &&
        event.target.name === "command" &&
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

  useEffect(() => {
    if (!open) {
      return undefined;
    }

    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = previousOverflow;
    };
  }, [open]);

  if (!mounted) {
    return null;
  }

  return createPortal(
    <div
      aria-hidden={!open}
      className={`fixed inset-0 z-[80] transition-[visibility] duration-200 motion-reduce:transition-none ${
        open ? "visible" : "invisible delay-200"
      }`}
    >
      <button
        type="button"
        aria-label="Close terminal"
        tabIndex={open ? 0 : -1}
        onClick={() => {
          setOpen(false);
        }}
        className={`absolute inset-0 cursor-default bg-[color:color-mix(in_srgb,var(--bo-bg)_24%,transparent)] backdrop-blur-sm transition-opacity duration-200 ease-out motion-reduce:transition-none ${
          open ? "opacity-100" : "opacity-0"
        }`}
      />

      <section
        role="dialog"
        aria-modal="true"
        aria-label={`${selectedScope.label} terminal`}
        className={`absolute top-0 right-0 left-0 flex h-[min(32rem,calc(100dvh-5rem))] min-h-0 flex-col overflow-visible border-b border-[color:var(--bo-border-strong)] bg-[color:color-mix(in_srgb,var(--bo-panel)_74%,transparent)] shadow-[0_28px_90px_rgba(0,0,0,0.22)] backdrop-blur-3xl transition-transform duration-200 ease-out motion-reduce:transition-none ${
          open ? "translate-y-0" : "-translate-y-[calc(100%+2rem)]"
        }`}
      >
        <header className="flex h-12 shrink-0 items-center justify-between border-b border-[color:var(--bo-border)] bg-[color:color-mix(in_srgb,var(--bo-panel)_62%,transparent)] px-4 backdrop-blur-3xl sm:px-5">
          <p className="font-mono text-[10px] font-semibold tracking-[0.24em] text-[var(--bo-fg)] uppercase">
            Terminal
          </p>

          <div className="flex items-center gap-2">
            <p className="hidden font-mono text-[10px] tracking-[0.08em] text-[var(--bo-muted-2)] sm:block">
              ^J run · ^L clear · ^R history · Tab complete
            </p>
            <kbd className="border border-[color:var(--bo-border)] bg-[color:color-mix(in_srgb,var(--bo-panel-2)_50%,transparent)] px-2 py-1 font-mono text-[10px] text-[var(--bo-muted)]">
              ` · ⌃`
            </kbd>
            <button
              type="button"
              onClick={() => {
                setOpen(false);
              }}
              className="flex size-10 items-center justify-center text-lg text-[var(--bo-muted)] transition-colors duration-150 hover:bg-[var(--bo-panel-2)] hover:text-[var(--bo-fg)] active:scale-[0.96]"
              aria-label="Close terminal"
            >
              ×
            </button>
          </div>
        </header>

        <DashboardTerminalPanel
          key={scopePath}
          scopeId={scopePath}
          scopeName={selectedScope.label}
          actionPath={automationScopeTerminalCommandPath(selectedScope)}
          commandSpecs={commandSpecs ?? EMPTY_TERMINAL_COMMAND_SPECS}
          description={`Commands run directly in the ${selectedScope.label} ${selectedScope.kind} scope.`}
          presentation="quake"
          focusInput={open}
        />
      </section>
    </div>,
    document.body,
  );
}

/*
 * Monaco-backed code editor for the workflow workbench. Monaco is browser-only
 * (and loaded from the CDN by @monaco-editor/react), so we gate the whole thing
 * behind a client mount to keep it out of SSR. The editor theme is derived from
 * the live cadence CSS variables so it blends into the surrounding panel.
 */

import { useEffect, useRef, useState } from "react";

import Editor, { type OnMount } from "@monaco-editor/react";

export type CodeEditorEngine = "bash" | "codemode";

const LANGUAGE: Record<CodeEditorEngine, string> = {
  bash: "shell",
  codemode: "typescript",
};

export function CadenceCodeEditor({
  value,
  onChange,
  engine,
  readOnly,
  onSave,
}: {
  value: string;
  onChange: (next: string) => void;
  engine: CodeEditorEngine;
  readOnly: boolean;
  /** Invoked on Cmd/Ctrl+S inside the editor. */
  onSave: () => void;
}) {
  // Monaco references `window`/`document` and loads from a CDN, so only render
  // it after hydration — SSR gets the plain placeholder below.
  const [mounted, setMounted] = useState(false);
  useEffect(() => {
    setMounted(true);
  }, []);

  // Keep the latest onSave reachable from the editor command (registered once).
  const onSaveRef = useRef(onSave);
  useEffect(() => {
    onSaveRef.current = onSave;
  }, [onSave]);

  const onMount: OnMount = (editor, monaco) => {
    monaco.editor.defineTheme("cadence", buildCadenceTheme());
    monaco.editor.setTheme("cadence");

    // Workflow scripts are snippets against an injected runtime — full semantic
    // validation just produces noise (unresolved imports, missing globals).
    monaco.languages.typescript.typescriptDefaults.setDiagnosticsOptions({
      noSemanticValidation: true,
      noSyntaxValidation: false,
    });

    editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS, () => {
      onSaveRef.current();
    });
  };

  // Before hydration (and while Monaco itself is loading from the CDN) show the
  // same quiet loader, so the transition into the editor is a single smooth swap
  // rather than a flash of raw text reflowing into Monaco.
  if (!mounted) {
    return <EditorLoader />;
  }

  return (
    <div className="min-h-0 flex-1">
      <Editor
        height="100%"
        language={LANGUAGE[engine]}
        value={value}
        onChange={(next) => {
          onChange(next ?? "");
        }}
        onMount={onMount}
        theme="cadence"
        loading={<EditorLoader />}
        options={{
          readOnly,
          minimap: { enabled: false },
          fontSize: 11,
          lineHeight: 16,
          tabSize: 2,
          insertSpaces: true,
          scrollBeyondLastLine: false,
          wordWrap: "off",
          renderLineHighlight: "line",
          smoothScrolling: true,
          automaticLayout: true,
          padding: { top: 12, bottom: 12 },
          fontFamily: "var(--cad-mono-font, ui-monospace, SFMono-Regular, monospace)",
          fixedOverflowWidgets: true,
        }}
      />
    </div>
  );
}

/**
 * Quiet, centered loader shown while the editor is being prepared (pre-hydration
 * and while Monaco loads from the CDN). Fills the editor area so the panel keeps
 * its layout and the editor fades in without a flash of reflowing content.
 */
function EditorLoader() {
  return (
    <div className="flex min-h-0 flex-1 items-center justify-center bg-[var(--cad-panel)]">
      <span className="cad-mono flex items-center gap-2 text-[10px] text-[var(--cad-muted-2)]">
        <span className="size-2 animate-pulse rounded-full bg-[var(--cad-brass)]" />
        loading editor…
      </span>
    </div>
  );
}

/**
 * Resolve a cadence CSS custom property (`oklch(...)`) to a Monaco-friendly hex
 * string. Custom properties read back verbatim from getComputedStyle, so we let
 * the browser resolve the color by applying it to a throwaway element.
 */
function cssVarToHex(name: string, fallback: string): string {
  const probe = document.createElement("span");
  probe.style.color = `var(${name})`;
  probe.style.display = "none";
  document.body.appendChild(probe);
  const resolved = getComputedStyle(probe).color;
  document.body.removeChild(probe);
  return rgbToHex(resolved) ?? fallback;
}

function rgbToHex(color: string): string | null {
  const match = /rgba?\(([^)]+)\)/.exec(color);
  if (!match) {
    return null;
  }
  const parts = match[1].split(",").map((p) => p.trim());
  const [r, g, b] = parts.map((p) => Math.round(Number.parseFloat(p)));
  if ([r, g, b].some((n) => Number.isNaN(n))) {
    return null;
  }
  const hex = (n: number) => n.toString(16).padStart(2, "0");
  return `#${hex(r)}${hex(g)}${hex(b)}`;
}

function buildCadenceTheme() {
  const panel = cssVarToHex("--cad-panel", "#ffffff");
  const panel2 = cssVarToHex("--cad-panel-2", "#fafafa");
  const fg = cssVarToHex("--cad-fg", "#2b2b2b");
  const muted = cssVarToHex("--cad-muted", "#808080");
  const muted2 = cssVarToHex("--cad-muted-2", "#a0a0a0");
  const line = cssVarToHex("--cad-line", "#e6e6e6");
  const brass = cssVarToHex("--cad-brass", "#b07a3c");

  return {
    base: "vs" as const,
    inherit: true,
    rules: [
      { token: "comment", foreground: stripHash(muted) },
      { token: "keyword", foreground: stripHash(brass) },
      { token: "string", foreground: stripHash(muted) },
    ],
    colors: {
      "editor.background": panel,
      "editor.foreground": fg,
      "editorLineNumber.foreground": muted2,
      "editorLineNumber.activeForeground": fg,
      "editor.lineHighlightBackground": panel2,
      "editor.lineHighlightBorder": "#00000000",
      "editorCursor.foreground": brass,
      "editorIndentGuide.background1": line,
      "editorIndentGuide.activeBackground1": muted2,
      "editorWidget.background": panel,
      "editorWidget.border": line,
      "scrollbarSlider.background": `${line}99`,
    },
  };
}

function stripHash(hex: string): string {
  return hex.startsWith("#") ? hex.slice(1) : hex;
}

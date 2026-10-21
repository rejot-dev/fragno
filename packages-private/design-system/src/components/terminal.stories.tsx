import { useEffect, useId, useRef, useState, type ReactNode } from "react";

import {
  TerminalBanner,
  TerminalLog,
  TerminalLogEntry,
  TerminalLogPending,
  TerminalOverlay,
  TerminalPrompt,
  TerminalScopeMenu,
  TerminalSuggestion,
  TerminalSuggestions,
  type TerminalScopeChoice,
} from "./terminal";

export default { title: "Terminal/Terminal overlay" };

type SampleEntry = {
  id: string;
  timestamp: string;
  cwd: string;
  command: string;
  output: string;
  ok: boolean;
  exitCode: number;
  durationMs: number;
};

type SampleSuggestion = { kind: string; label: string; description: string };

type SampleScope = { id: string; name: string; label: string; group: string };

const HINT = "⏎ run · \\⏎ new line · ^R history · Tab complete · ^O scope";
const SHORTCUT = "` · ⌃`";

const SCOPES: SampleScope[] = [
  { id: "system", name: "system", label: "System", group: "System" },
  { id: "acme", name: "acme", label: "Acme Inc.", group: "Organizations" },
  { id: "globex", name: "globex", label: "Globex Corporation", group: "Organizations" },
  { id: "personal", name: "personal", label: "ada@acme.test", group: "Personal" },
];

const ACME = SCOPES[1];

function banner(scope: SampleScope) {
  return `Backoffice terminal connected to ${scope.label}
Type a command and press Enter; end a line with \\ to continue it. 'use' switches scope.`;
}

const SESSION: SampleEntry[] = [
  {
    id: "ls",
    timestamp: "2026-10-20T09:41:07",
    cwd: "/",
    command: "ls /workspace",
    output: "AGENTS.md\nREADME.md\ndrafts\nintegrations\ninvoices.csv\nprompts",
    ok: true,
    exitCode: 0,
    durationMs: 12,
  },
  {
    id: "execute",
    timestamp: "2026-10-20T09:41:30",
    cwd: "/",
    command:
      "integrations.execute --connection-id 'app#bookkeeping' --action-id organization.get --input-json '{}'",
    output: `{
  "id": "BDRh4si3EAm6oPcqmPe7PZD44gCkkmBh",
  "name": "Acme Inc.",
  "slug": "acme",
  "memberCount": 4,
  "linkedAt": "2026-10-15T16:05:46.222Z"
}`,
    ok: true,
    exitCode: 0,
    durationMs: 67,
  },
  {
    id: "jq",
    timestamp: "2026-10-20T09:42:02",
    cwd: "/",
    command: "integrations.list | jq '[].connectionId'",
    output: 'jq: parse error: Cannot index array with string "connectionId"',
    ok: false,
    exitCode: 5,
    durationMs: 17,
  },
];

const WRAPPING_ENTRY: SampleEntry = {
  id: "list",
  timestamp: "2026-10-20T09:43:10",
  cwd: "/",
  command: "integrations.list",
  output: `{ "connections": [ { "configuration": { "status": "configured" }, "authorization": { "status": "not-required" }, "checks": [], "nextSteps": [], "connectionId": "mcp#agensi", "integrationId": "mcp", "name": "agensi", "authMethod": "none" }, { "configuration": { "status": "configured" }, "authorization": { "status": "available" }, "checks": [ { "id": "endpoint.ping", "label": "Reach the app's action endpoint", "status": "not-checked", "reason": "Run integrations.verify to ping the app's endpoint." } ], "connectionId": "app#bookkeeping", "integrationId": "app", "name": "Bookkeeping", "authMethod": "app-installation" } ], "cursor": null }
https://backoffice.example.test/api/backoffice/actions/app%23bookkeeping/organization.get?expand=members,invitations,billing.subscription.items`,
  ok: true,
  exitCode: 0,
  durationMs: 42,
};

const MULTI_LINE_ENTRY: SampleEntry = {
  id: "multi-line",
  timestamp: "2026-10-20T09:44:00",
  cwd: "/workspace",
  command: `integrations.execute \\
  --connection-id 'app#bookkeeping' \\
  --action-id organization.get \\
  --input-json '{}' | jq .name`,
  output: '"Acme Inc."',
  ok: true,
  exitCode: 0,
  durationMs: 58,
};

/** Page content behind the overlay, so the backdrop has something to blur. */
function PageBehind() {
  return (
    <div className="space-y-4">
      <h1 className="text-2xl font-semibold">Files for Acme Inc.</h1>
      {["AGENTS.md", "README.md", "drafts", "integrations", "invoices.csv", "prompts"].map(
        (name) => (
          <div key={name} className="border border-[color:var(--bo-border)] px-4 py-3 text-sm">
            {name}
          </div>
        ),
      )}
    </div>
  );
}

function SampleScopeMenu({
  current,
  open,
  onOpenChange,
  onChoose,
}: {
  current: SampleScope;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onChoose: (scope: SampleScope) => void;
}) {
  const groups = ["System", "Organizations", "Personal"].map((group) => ({
    label: group,
    choices: SCOPES.filter((scope) => scope.group === group).map(
      (scope): TerminalScopeChoice => ({
        id: scope.id,
        name: scope.name,
        label: scope.label,
        current: scope.id === current.id,
      }),
    ),
  }));
  return (
    <TerminalScopeMenu
      open={open}
      onOpenChange={onOpenChange}
      label={current.label}
      groups={groups}
      onChoose={(id) => {
        const scope = SCOPES.find((candidate) => candidate.id === id);
        if (scope) {
          onChoose(scope);
        }
      }}
    />
  );
}

function UncontrolledSampleScopeMenu() {
  const [open, setOpen] = useState(false);
  return <SampleScopeMenu current={ACME} open={open} onOpenChange={setOpen} onChoose={() => {}} />;
}

function SampleTerminal({
  entries,
  pending,
  cwd,
  command,
  suggestions,
  activeIndex,
  suggestionsLabel,
}: {
  entries: SampleEntry[];
  pending: string | null;
  cwd: string;
  command: string;
  suggestions: SampleSuggestion[];
  activeIndex: number;
  suggestionsLabel: string;
}) {
  const listId = useId();
  return (
    <>
      <PageBehind />
      <TerminalOverlay
        open
        label="Acme Inc. terminal"
        scope={<UncontrolledSampleScopeMenu />}
        hint={HINT}
        shortcut={SHORTCUT}
        onClose={() => {}}
      >
        <SampleLog scope={ACME} entries={entries}>
          {pending === null ? null : <TerminalLogPending cwd={cwd} command={pending} />}
        </SampleLog>
        <TerminalPrompt
          scope={ACME.name}
          cwd={cwd}
          aria-label="Terminal command"
          value={command}
          readOnly
          disabled={pending !== null}
          placeholder="Run a bash command (e.g. ls /workspace, pwd, find /static)"
        />
        {suggestions.length > 0 ? (
          <TerminalSuggestions id={listId} label={suggestionsLabel}>
            {suggestions.map((suggestion, index) => (
              <TerminalSuggestion
                key={suggestion.label}
                id={`${listId}-option-${index}`}
                {...suggestion}
                active={index === activeIndex}
              />
            ))}
          </TerminalSuggestions>
        ) : null}
      </TerminalOverlay>
    </>
  );
}

function SampleLog({
  scope,
  entries,
  children,
}: {
  scope: SampleScope;
  entries: SampleEntry[];
  children: ReactNode;
}) {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (ref.current) {
      ref.current.scrollTop = ref.current.scrollHeight;
    }
  }, [entries, children]);

  return (
    <TerminalLog ref={ref}>
      <TerminalBanner>{banner(scope)}</TerminalBanner>
      {entries.map(({ id, ...entry }) => (
        <TerminalLogEntry key={id} {...entry} />
      ))}
      {children}
    </TerminalLog>
  );
}

const IDLE = {
  pending: null,
  cwd: "/",
  command: "",
  suggestions: [],
  activeIndex: 0,
  suggestionsLabel: "Suggestions",
};

export function Session() {
  return <SampleTerminal {...IDLE} entries={SESSION} />;
}

export function Greeting() {
  return <SampleTerminal {...IDLE} entries={[]} />;
}

export function LongLinesWrap() {
  return <SampleTerminal {...IDLE} entries={[...SESSION, WRAPPING_ENTRY]} />;
}

export function Running() {
  return <SampleTerminal {...IDLE} entries={SESSION} pending="integrations.verify --all" />;
}

export function MultiLineCommand() {
  return (
    <SampleTerminal
      {...IDLE}
      entries={[...SESSION, MULTI_LINE_ENTRY]}
      cwd="/workspace"
      command={`find /workspace \\
  -name '*.md' \\
  -newer /workspace/README.md`}
    />
  );
}

export function PathCompletions() {
  return (
    <SampleTerminal
      {...IDLE}
      entries={SESSION}
      command="cat /workspace/"
      suggestions={[
        { kind: "path", label: "/workspace/AGENTS.md", description: "File · /workspace/AGENTS.md" },
        { kind: "path", label: "/workspace/README.md", description: "File · /workspace/README.md" },
        { kind: "path", label: "/workspace/drafts/", description: "Directory · /workspace/drafts" },
        {
          kind: "path",
          label: "/workspace/integrations/",
          description: "Directory · /workspace/integrations",
        },
        {
          kind: "path",
          label: "/workspace/invoices.csv",
          description: "File · /workspace/invoices.csv",
        },
        {
          kind: "path",
          label: "/workspace/prompts/",
          description: "Directory · /workspace/prompts",
        },
      ]}
      activeIndex={2}
    />
  );
}

export function CommandCompletions() {
  return (
    <SampleTerminal
      {...IDLE}
      entries={SESSION}
      command="integrations.execute "
      suggestions={[
        {
          kind: "arg",
          label: "--connection-id <id>",
          description: "Required · The connection to run the action through",
        },
        {
          kind: "arg",
          label: "--action-id <id>",
          description: "Required · The action to run, as listed by integrations.get",
        },
        {
          kind: "arg",
          label: "--input-json <json>",
          description: "The action input as a JSON object",
        },
      ]}
    />
  );
}

export function ScopeCompletions() {
  return (
    <SampleTerminal
      {...IDLE}
      entries={SESSION}
      command="use g"
      suggestions={[{ kind: "scope", label: "globex", description: "Globex Corporation" }]}
    />
  );
}

export function HistorySearch() {
  return (
    <SampleTerminal
      {...IDLE}
      entries={SESSION}
      suggestions={SESSION.map((entry) => ({
        kind: "history",
        label: entry.command,
        description: "Recent command",
      })).reverse()}
      suggestionsLabel="Command history"
    />
  );
}

export function DeepWorkingDirectory() {
  return (
    <SampleTerminal
      {...IDLE}
      entries={[
        {
          id: "cd",
          timestamp: "2026-10-20T09:41:07",
          cwd: "/",
          command: "cd /workspace/integrations/app/bookkeeping/generated/clients",
          output: "",
          ok: true,
          exitCode: 0,
          durationMs: 3,
        },
      ]}
      cwd="/workspace/integrations/app/bookkeeping/generated/clients"
      command="ls"
    />
  );
}

/**
 * A toy shell: `ls`, `pwd`, `cd`, `echo`, `clear`, and `use <scope>`. Tab lists commands, a
 * trailing `\` continues the command on a new line, ⌃O opens the scope menu, and ` toggles the
 * overlay.
 */
export function Interactive() {
  const [open, setOpen] = useState(true);
  const [scope, setScope] = useState(ACME);
  const [sessions, setSessions] = useState<Record<string, SampleEntry[]>>({});
  const [cwd, setCwd] = useState("/");
  const [command, setCommand] = useState("");
  const [suggestionsOpen, setSuggestionsOpen] = useState(false);
  const [activeIndex, setActiveIndex] = useState(0);
  const listId = useId();
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const [scopeMenuOpen, setScopeMenuOpen] = useState(false);
  const entries = sessions[scope.id] ?? [];

  const suggestions: SampleSuggestion[] = command.startsWith("use ")
    ? SCOPES.filter((candidate) => candidate.name.startsWith(command.slice(4).trim())).map(
        (candidate) => ({ kind: "scope", label: candidate.name, description: candidate.label }),
      )
    : TOY_COMMANDS.filter((candidate) => candidate.label.startsWith(command.trim()));

  useEffect(() => {
    if (open) {
      inputRef.current?.focus();
    }
  }, [open, scope]);

  useEffect(() => {
    function toggle(event: KeyboardEvent) {
      if (event.key === "`" && (event.target !== inputRef.current || command === "")) {
        event.preventDefault();
        setOpen((current) => !current);
      }
    }
    document.addEventListener("keydown", toggle);
    return () => {
      document.removeEventListener("keydown", toggle);
    };
  }, [command]);

  function append(scopeId: string, line: string, output: string, exitCode: number) {
    setSessions((current) => ({
      ...current,
      [scopeId]: [
        ...(current[scopeId] ?? []),
        {
          id: `${current[scopeId]?.length ?? 0}`,
          timestamp: new Date().toISOString(),
          cwd,
          command: line,
          output,
          ok: exitCode === 0,
          exitCode,
          durationMs: Math.round(Math.random() * 40),
        },
      ],
    }));
  }

  function switchTo(next: SampleScope) {
    append(next.id, `use ${next.name}`, `Switched from ${scope.label} to ${next.label}.`, 0);
    setScope(next);
    setCwd("/");
  }

  function run(line: string) {
    setCommand("");
    setSuggestionsOpen(false);
    const useMatch = /^use\s+(\S+)$/u.exec(line.trim());
    if (useMatch) {
      const next = SCOPES.find((candidate) => candidate.name === useMatch[1]);
      if (next) {
        switchTo(next);
      } else {
        append(scope.id, line, `use: no scope named '${useMatch[1]}'`, 1);
      }
      return;
    }
    const result = runToyCommand(line.replace(/\\\n/gu, " ").trim(), cwd);
    if (result.clear) {
      setSessions((current) => ({ ...current, [scope.id]: [] }));
      return;
    }
    append(scope.id, line, result.output, result.exitCode);
    setCwd(result.nextCwd);
  }

  return (
    <>
      <PageBehind />
      <TerminalOverlay
        open={open}
        label={`${scope.label} terminal`}
        scope={
          <SampleScopeMenu
            current={scope}
            open={scopeMenuOpen}
            onOpenChange={setScopeMenuOpen}
            onChoose={switchTo}
          />
        }
        hint={HINT}
        shortcut={SHORTCUT}
        onClose={() => {
          setOpen(false);
        }}
      >
        <SampleLog scope={scope} entries={entries}>
          {null}
        </SampleLog>
        <form
          onSubmit={(event) => {
            event.preventDefault();
            run(command);
          }}
        >
          <TerminalPrompt
            ref={inputRef}
            scope={scope.name}
            cwd={cwd}
            aria-label="Terminal command"
            aria-expanded={suggestionsOpen}
            value={command}
            onChange={(event) => {
              setCommand(event.target.value);
              setActiveIndex(0);
            }}
            onKeyDown={(event) => {
              if (event.ctrlKey && event.key === "o") {
                event.preventDefault();
                setScopeMenuOpen(true);
              } else if (event.key === "Tab") {
                event.preventDefault();
                if (suggestionsOpen && suggestions[activeIndex]) {
                  const replacement = suggestions[activeIndex].label;
                  setCommand(command.startsWith("use ") ? `use ${replacement}` : `${replacement} `);
                  setSuggestionsOpen(false);
                } else {
                  setSuggestionsOpen(true);
                }
              } else if (event.key === "Enter" && !event.shiftKey) {
                const before = command.slice(0, event.currentTarget.selectionStart);
                if (!before.endsWith("\\")) {
                  event.preventDefault();
                  event.currentTarget.form?.requestSubmit();
                }
              } else if (suggestionsOpen && event.key === "ArrowDown") {
                event.preventDefault();
                setActiveIndex((current) => (current + 1) % Math.max(suggestions.length, 1));
              } else if (suggestionsOpen && event.key === "ArrowUp") {
                event.preventDefault();
                setActiveIndex(
                  (current) => (current - 1 + suggestions.length) % Math.max(suggestions.length, 1),
                );
              } else if (event.key === "Escape") {
                setSuggestionsOpen(false);
              }
            }}
            placeholder="Try ls, cd /workspace, echo hello \, use globex, or clear"
            autoComplete="off"
            spellCheck={false}
          />
        </form>
        {suggestionsOpen && suggestions.length > 0 ? (
          <TerminalSuggestions id={listId} label="Suggestions">
            {suggestions.map((suggestion, index) => (
              <TerminalSuggestion
                key={suggestion.label}
                id={`${listId}-option-${index}`}
                {...suggestion}
                active={index === activeIndex}
                onMouseDown={(event) => {
                  event.preventDefault();
                  setCommand(`${suggestion.label} `);
                  setSuggestionsOpen(false);
                }}
              />
            ))}
          </TerminalSuggestions>
        ) : null}
      </TerminalOverlay>
    </>
  );
}

const TOY_COMMANDS: SampleSuggestion[] = [
  { kind: "command", label: "ls", description: "List a directory" },
  { kind: "command", label: "cd", description: "Change the working directory" },
  { kind: "command", label: "pwd", description: "Print the working directory" },
  { kind: "command", label: "echo", description: "Print its arguments" },
  { kind: "command", label: "clear", description: "Clear the scrollback" },
  { kind: "command", label: "use", description: "Switch the terminal to another scope" },
];

const TOY_FILES: Record<string, string[]> = {
  "/": ["static", "workspace"],
  "/static": ["codemode"],
  "/workspace": ["AGENTS.md", "README.md", "drafts", "invoices.csv"],
};

function runToyCommand(
  line: string,
  cwd: string,
): { output: string; exitCode: number; nextCwd: string; clear: boolean } {
  const [name = "", ...args] = line.split(/\s+/u);
  const target = args[0] ? resolveToyPath(cwd, args[0]) : cwd;
  switch (name) {
    case "ls":
      return TOY_FILES[target]
        ? { output: TOY_FILES[target].join("\n"), exitCode: 0, nextCwd: cwd, clear: false }
        : {
            output: `ls: ${target}: No such file or directory`,
            exitCode: 1,
            nextCwd: cwd,
            clear: false,
          };
    case "cd":
      return TOY_FILES[target]
        ? { output: "", exitCode: 0, nextCwd: target, clear: false }
        : { output: `cd: ${target}: No such directory`, exitCode: 1, nextCwd: cwd, clear: false };
    case "pwd":
      return { output: cwd, exitCode: 0, nextCwd: cwd, clear: false };
    case "echo":
      return { output: args.join(" "), exitCode: 0, nextCwd: cwd, clear: false };
    case "clear":
      return { output: "", exitCode: 0, nextCwd: cwd, clear: true };
    default:
      return {
        output: `bash: ${name}: command not found`,
        exitCode: 127,
        nextCwd: cwd,
        clear: false,
      };
  }
}

function resolveToyPath(cwd: string, path: string) {
  const absolute = path.startsWith("/") ? path : `${cwd === "/" ? "" : cwd}/${path}`;
  const parts: string[] = [];
  for (const part of absolute.split("/")) {
    if (part === "..") {
      parts.pop();
    } else if (part && part !== ".") {
      parts.push(part);
    }
  }
  return `/${parts.join("/")}`;
}

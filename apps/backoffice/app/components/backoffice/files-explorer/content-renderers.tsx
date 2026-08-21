import { Tabs } from "@base-ui/react/tabs";
import {
  AlertTriangle,
  CalendarClock,
  Code2,
  ShieldCheck,
  Workflow as WorkflowIcon,
} from "lucide-react";
import type { ReactNode } from "react";
import { Streamdown } from "streamdown";

import { visualizeWorkflowSource } from "@fragno-dev/workflow-visualizer-tokens";

import type {
  AutomationEventMatcher,
  AutomationRouteDefinition,
} from "@/fragno/automation/routing";
import type { ResolvedWorkflowRuntimeToolCall } from "@/fragno/runtime-tools/workflow-catalog";
import { parseFrontmatter } from "@/lib/frontmatter";
import { formatTimestampInTimeZone } from "@/routes/backoffice/automations/formatting";
import { ScriptWorkflowGraph } from "@/routes/backoffice/automations/script-view/workflow-graph";

export type WorkflowFileRouting =
  | { status: "unavailable" }
  | { status: "loading" }
  | { status: "error"; message: string }
  | { status: "ready"; routes: readonly AutomationRouteDefinition[] };

export type FilesContentPreview = {
  title: string;
  contentType: string | null;
  metadata: Record<string, unknown> | null;
  textContent: string | null;
  workflowRouting: WorkflowFileRouting;
};

type FilesContentRenderer = {
  id: string;
  label: string;
  renderBefore?: (preview: FilesContentPreview) => ReactNode;
  render: (preview: FilesContentPreview) => ReactNode;
};

const EMPTY_WORKFLOW_RUNTIME_TOOL_CALLS: ReadonlyMap<
  string,
  readonly ResolvedWorkflowRuntimeToolCall[]
> = new Map();

const WorkflowRenderer: FilesContentRenderer = {
  id: "workflow",
  label: "Workflow preview",
  render(preview) {
    return <WorkflowFilePreview preview={preview} />;
  },
};

function WorkflowFilePreview({ preview }: { preview: FilesContentPreview }) {
  const source = preview.textContent ?? "";
  const visualization = visualizeWorkflowSource(preview.title, source, {
    fallbackName: preview.title.replace(/\.workflow\.js$/iu, ""),
  });

  return (
    <Tabs.Root defaultValue="graph" className="flex h-full min-h-0 flex-col">
      <Tabs.List
        aria-label="Workflow preview views"
        className="flex shrink-0 items-center gap-2 border-b border-[var(--bo-border)]"
      >
        <Tabs.Tab
          value="code"
          className="flex min-h-10 items-center gap-1.5 border-b-2 border-transparent px-1 font-mono text-[10px] font-semibold tracking-[0.18em] text-[var(--bo-muted)] uppercase transition-[scale,border-color,color] duration-150 ease-out outline-none hover:border-[color:var(--bo-border-strong)] hover:text-[var(--bo-fg)] focus-visible:ring-2 focus-visible:ring-[color:var(--bo-accent)]/30 active:scale-[0.96] data-[active]:border-[color:var(--bo-accent)] data-[active]:text-[var(--bo-accent-fg)]"
        >
          <Code2 className="size-3.5" aria-hidden="true" />
          Code
        </Tabs.Tab>
        <Tabs.Tab
          value="graph"
          className="flex min-h-10 items-center gap-1.5 border-b-2 border-transparent px-1 font-mono text-[10px] font-semibold tracking-[0.18em] text-[var(--bo-muted)] uppercase transition-[scale,border-color,color] duration-150 ease-out outline-none hover:border-[color:var(--bo-border-strong)] hover:text-[var(--bo-fg)] focus-visible:ring-2 focus-visible:ring-[color:var(--bo-accent)]/30 active:scale-[0.96] data-[active]:border-[color:var(--bo-accent)] data-[active]:text-[var(--bo-accent-fg)]"
        >
          <WorkflowIcon className="size-3.5" aria-hidden="true" />
          Graph
        </Tabs.Tab>
      </Tabs.List>

      <Tabs.Panel value="code" className="min-h-0 flex-1 pt-3">
        <pre
          aria-label="Workflow code"
          tabIndex={0}
          className="backoffice-scroll h-full overflow-auto overscroll-contain px-1 font-mono text-[12px] leading-6 whitespace-pre-wrap text-[var(--bo-fg)] focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-[color:var(--bo-accent)]"
        >
          <code>{source}</code>
        </pre>
      </Tabs.Panel>
      <Tabs.Panel value="graph" className="flex min-h-0 flex-1 flex-col pt-3">
        <WorkflowStartRouteSummary routing={preview.workflowRouting} />
        <div className="min-h-0 flex-1 [--bo-accent-bg:color-mix(in_srgb,var(--bo-blue-4)_24%,var(--bo-panel))] [--bo-accent-fg:var(--bo-blue-1)] [--bo-accent:var(--bo-blue-2)] dark:[--bo-accent-bg:color-mix(in_srgb,var(--bo-blue-1)_20%,var(--bo-panel))] dark:[--bo-accent-fg:var(--bo-blue-4)]">
          <ScriptWorkflowGraph
            visualization={visualization}
            detailMode="simple"
            runtimeToolCallsByStepId={EMPTY_WORKFLOW_RUNTIME_TOOL_CALLS}
            selectedRun={null}
            sourceCode={source}
            fillHeight
          />
        </div>
      </Tabs.Panel>
    </Tabs.Root>
  );
}

function WorkflowStartRouteSummary({ routing }: { routing: WorkflowFileRouting }) {
  if (routing.status === "unavailable") {
    return null;
  }
  if (routing.status === "loading") {
    return (
      <div className="mb-3 shrink-0 border border-dashed border-[color:var(--bo-border-strong)] bg-[var(--bo-panel)] px-3 py-2.5 text-xs text-[var(--bo-muted)]">
        Synchronizing workflow routes…
      </div>
    );
  }
  if (routing.status === "error") {
    return (
      <div
        role="alert"
        className="mb-3 flex shrink-0 items-start gap-2 border border-[color:var(--bo-failed)] bg-[var(--bo-failed-bg)] px-3 py-2.5 text-xs text-[var(--bo-failed)]"
      >
        <AlertTriangle className="mt-0.5 size-3.5 shrink-0" aria-hidden="true" />
        <span>Workflow routing unavailable: {routing.message}</span>
      </div>
    );
  }
  if (routing.routes.length === 0) {
    return (
      <div className="mb-3 shrink-0 border border-dashed border-[color:var(--bo-border-strong)] bg-[var(--bo-panel)] px-3 py-2.5 text-xs text-[var(--bo-muted)]">
        No configured route starts this workflow.
      </div>
    );
  }

  return (
    <section
      aria-label="Workflow start routes"
      className="backoffice-scroll mb-3 max-h-48 shrink-0 space-y-2 overflow-auto overscroll-contain"
    >
      {routing.routes.map((route) => (
        <div
          key={route.id}
          className="border border-[color:var(--bo-border)] bg-[var(--bo-panel)] px-3 py-2.5"
        >
          <div className="flex min-w-0 items-start justify-between gap-3">
            <div className="flex min-w-0 items-start gap-2.5">
              <span className="flex size-7 shrink-0 items-center justify-center bg-orange-500/10 text-orange-700 dark:text-orange-300">
                {route.trigger.kind === "event" ? (
                  <ShieldCheck className="size-3.5" aria-hidden="true" />
                ) : (
                  <CalendarClock className="size-3.5" aria-hidden="true" />
                )}
              </span>
              <div className="min-w-0">
                <p className="text-[9px] font-semibold tracking-[0.18em] text-orange-700 uppercase dark:text-orange-300">
                  {route.trigger.kind === "event" ? "Runs on" : "Scheduled"}
                  {route.enabled ? "" : " · Disabled"}
                </p>
                <p className="mt-1 font-mono text-xs font-semibold break-all text-[var(--bo-fg)]">
                  {workflowRouteTriggerText(route)}
                </p>
                {route.trigger.kind === "event" && route.trigger.matcher ? (
                  <p className="mt-1.5 font-mono text-[10px] leading-4 break-all text-[var(--bo-muted)]">
                    {automationEventMatcherText(route.trigger.matcher)}
                  </p>
                ) : null}
                {route.trigger.kind === "schedule" ? (
                  <p className="mt-1.5 font-mono text-[10px] leading-4 text-[var(--bo-muted)] tabular-nums">
                    Next ·{" "}
                    {route.nextOccurrenceAt ? (
                      <time dateTime={route.nextOccurrenceAt}>
                        {formatTimestampInTimeZone(
                          route.nextOccurrenceAt,
                          route.trigger.cadence.kind === "cron"
                            ? route.trigger.cadence.timeZone
                            : "UTC",
                        )}
                      </time>
                    ) : (
                      "None queued"
                    )}
                  </p>
                ) : null}
              </div>
            </div>
            <span className="max-w-48 shrink-0 truncate text-[9px] text-[var(--bo-muted-2)]">
              {route.name}
            </span>
          </div>
        </div>
      ))}
    </section>
  );
}

function workflowRouteTriggerText(route: AutomationRouteDefinition): string {
  if (route.trigger.kind === "event") {
    return `${route.trigger.source} / ${route.trigger.eventType}`;
  }
  if (route.trigger.cadence.kind === "once") {
    return `Once · ${route.trigger.cadence.at}`;
  }
  return `Cron · ${route.trigger.cadence.expression} · ${route.trigger.cadence.timeZone}`;
}

function automationEventMatcherText(matcher: AutomationEventMatcher): string {
  if ("all" in matcher) {
    return matcher.all.map(automationEventMatcherText).map(parenthesizeMatcherText).join(" and ");
  }
  if ("any" in matcher) {
    return matcher.any.map(automationEventMatcherText).map(parenthesizeMatcherText).join(" or ");
  }
  if ("not" in matcher) {
    return `not (${automationEventMatcherText(matcher.not)})`;
  }
  if ("actor" in matcher) {
    const actor = matcher.actor;
    return [
      `${actor.participation} actor`,
      actor.scope,
      actor.source,
      actor.type,
      actor.id,
      "role" in actor ? actor.role : undefined,
    ]
      .filter((value): value is string => Boolean(value))
      .join(" · ");
  }

  const operator =
    matcher.op === "eq"
      ? "equals"
      : matcher.op === "neq"
        ? "does not equal"
        : matcher.op === "startsWith"
          ? "starts with"
          : matcher.op;
  if (matcher.op === "exists") {
    return `${matcher.path} exists`;
  }
  return `${matcher.path} ${operator} ${formatMatcherValue(matcher.value)}`;
}

function parenthesizeMatcherText(value: string): string {
  return `(${value})`;
}

function formatMatcherValue(value: unknown): string {
  return JSON.stringify(value) ?? String(value);
}

const TextRenderer: FilesContentRenderer = {
  id: "text",
  label: "Text preview",
  render(preview) {
    return (
      <pre className="backoffice-scroll h-full overflow-auto font-mono text-[12px] leading-6 whitespace-pre-wrap text-[var(--bo-fg)]">
        {preview.textContent ?? ""}
      </pre>
    );
  },
};

const MarkdownRenderer: FilesContentRenderer = {
  id: "markdown",
  label: "Markdown preview",
  renderBefore(preview) {
    const { frontmatter } = readMarkdownDocument(preview);
    if (!frontmatter || Object.keys(frontmatter).length === 0) {
      return null;
    }

    return (
      <section className="bg-[var(--bo-panel-2)] p-3 shadow-[inset_0_0_0_1px_var(--bo-border)] md:p-4">
        <p className="font-mono text-[9px] font-semibold tracking-[0.2em] text-[var(--bo-muted-2)] uppercase">
          Frontmatter
        </p>
        <dl className="mt-3 divide-y divide-[var(--bo-border)] border-y border-[var(--bo-border)]">
          {Object.entries(frontmatter).map(([key, value]) => (
            <div key={key} className="grid gap-1 py-2.5 sm:grid-cols-[9rem_minmax(0,1fr)] sm:gap-4">
              <dt className="font-mono text-[10px] font-semibold text-[var(--bo-muted-2)]">
                {key}
              </dt>
              <dd className="min-w-0 text-sm leading-5 break-words text-[var(--bo-fg)]">
                {formatFrontmatterValue(value)}
              </dd>
            </div>
          ))}
        </dl>
      </section>
    );
  },
  render(preview) {
    const { body } = readMarkdownDocument(preview);

    return (
      <Streamdown
        mode="streaming"
        className="bo-file-markdown bo-session-markdown min-h-full text-sm leading-7 text-pretty"
        controls={{ code: true, table: true }}
        skipHtml
      >
        {body}
      </Streamdown>
    );
  },
};

function formatFrontmatterValue(value: unknown): string | undefined {
  if (typeof value === "string") {
    return value;
  }
  if (value === null) {
    return "null";
  }
  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }

  return JSON.stringify(value);
}

function readMarkdownDocument(preview: FilesContentPreview) {
  const content = preview.textContent ?? "";
  const parsed = parseFrontmatter<Record<string, unknown>>(content);

  return parsed.ok ? parsed.value : { frontmatter: null, body: content };
}

const ImageRenderer: FilesContentRenderer = {
  id: "image",
  label: "Image preview",
  render(preview) {
    const src = getImageSource(preview);
    if (!src) {
      return (
        <p className="text-sm text-[var(--bo-muted)]">
          No image preview source is available yet for this file. File metadata may provide a
          preview URL or data URL.
        </p>
      );
    }

    return (
      <img
        src={src}
        alt={preview.title}
        className="h-full max-h-full max-w-full bg-[var(--bo-panel)] object-contain outline outline-1 -outline-offset-1 outline-black/10 dark:outline-white/10"
      />
    );
  },
};

const FILES_CONTENT_RENDERERS_BY_CONTENT_TYPE = new Map<string, FilesContentRenderer>([
  ["text/plain", TextRenderer],
  ["text/markdown", MarkdownRenderer],
  ["text/x-shellscript", TextRenderer],
  ["text/typescript", TextRenderer],
  ["application/json", TextRenderer],
  ["image/png", ImageRenderer],
  ["image/jpeg", ImageRenderer],
  ["image/gif", ImageRenderer],
  ["image/webp", ImageRenderer],
  ["image/svg+xml", ImageRenderer],
]);

export function resolveFilesContentRenderer(
  preview: FilesContentPreview,
): FilesContentRenderer | null {
  if (preview.title.toLowerCase().endsWith(".workflow.js") && preview.textContent !== null) {
    return WorkflowRenderer;
  }

  const normalizedContentType = normalizeMediaType(preview.contentType);

  if (normalizedContentType) {
    const exactRenderer = FILES_CONTENT_RENDERERS_BY_CONTENT_TYPE.get(normalizedContentType);
    if (exactRenderer) {
      return exactRenderer;
    }
    if (normalizedContentType.startsWith("text/")) {
      return TextRenderer;
    }
    if (normalizedContentType.startsWith("image/")) {
      return ImageRenderer;
    }
  }

  return preview.textContent !== null ? TextRenderer : null;
}

function getImageSource(preview: FilesContentPreview): string | null {
  const candidates = [
    readString(preview.metadata, "previewUrl"),
    readString(preview.metadata, "dataUrl"),
    readString(preview.metadata, "src"),
    readString(preview.metadata, "url"),
  ];

  for (const candidate of candidates) {
    if (candidate && isAllowedImageSource(candidate)) {
      return candidate;
    }
  }
  if (normalizeMediaType(preview.contentType) === "image/svg+xml" && preview.textContent) {
    return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(preview.textContent)}`;
  }
  return null;
}

function normalizeMediaType(contentType: string | null): string | null {
  return contentType?.split(";", 1)[0]?.trim().toLowerCase() || null;
}

function isAllowedImageSource(candidate: string): boolean {
  if (candidate.startsWith("/") && !candidate.startsWith("//")) {
    return true;
  }
  if (/^data:image\/(?:png|jpeg|gif|webp|svg\+xml)(?:;[^,]*)?,/iu.test(candidate)) {
    return true;
  }
  if (typeof location === "undefined") {
    return false;
  }

  try {
    const url = new URL(candidate);
    return (
      (url.protocol === "http:" || url.protocol === "https:") && url.origin === location.origin
    );
  } catch {
    return false;
  }
}

function readString(value: Record<string, unknown> | null, key: string): string | null {
  const candidate = value?.[key];
  return typeof candidate === "string" && candidate.length > 0 ? candidate : null;
}

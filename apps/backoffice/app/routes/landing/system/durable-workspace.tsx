"use client";

import { useState } from "react";

import {
  FilesExplorerView,
  type FilesExplorerSource,
} from "@/components/backoffice/files-explorer";
import { createFileTree } from "@/file-collection/create-file-tree";

import rejotLogoSvg from "../../../../content/landing/rejot-logo.svg?raw";

const WORKSPACE_ROOT_PATH = "/workspace";
const SYSTEM_ROOT_PATH = "/system";
const WORKSPACE_FILE_CONTENT = new Map<string, string>([
  [
    `${WORKSPACE_ROOT_PATH}/AGENTS.md`,
    `# Workspace agents

## Operating rules

- Read MEMORY.md before starting work.
- Record durable decisions in workspace files.
- Use workflows for repeatable side effects.
- Never expose secret values in session output.`,
  ],
  [
    `${WORKSPACE_ROOT_PATH}/MEMORY.md`,
    `# Memory

## Current objective

Configure and maintain the organisation's speech-to-text integrations.

## Decisions

- Reson8 is the default transcription provider.
- Connection changes require verification before activation.`,
  ],
  [
    `${WORKSPACE_ROOT_PATH}/.pi/sessions/qtnojobzvxetnojobzvxetno.jsonl`,
    `{"type":"session","version":3,"id":"qtnojobzvxetnojobzvxetno","timestamp":"2026-08-21T15:09:58.233Z","cwd":"/workspace"}
{"type":"message","id":"interactive-chat-workflow:qtnojobzvxetnojobzvxetno:command:r13prao1wsgi13prao1wsgi1:entry-0","parentId":null,"timestamp":"2026-08-21T15:10:02.007Z","message":{"role":"user","content":[{"type":"text","text":"use codemode to create a bogus webhook endpoint. it doesnt have to be functioning"}],"timestamp":1787325002007}}`,
  ],
  [
    `${WORKSPACE_ROOT_PATH}/.pi/sessions/k2bdtz7342472bdtz7342472.jsonl`,
    `{"type":"session","version":3,"id":"k2bdtz7342472bdtz7342472","timestamp":"2026-08-20T10:46:39.831Z","cwd":"/workspace"}
{"type":"message","id":"interactive-chat-workflow:k2bdtz7342472bdtz7342472:command:jaydu2mfsa0aydu2mfsa0ayd:entry-0","parentId":null,"timestamp":"2026-08-20T10:46:40.536Z","message":{"role":"user","content":[{"type":"text","text":"connect to https://mcp.stripe.com"}],"timestamp":1787222800536}}`,
  ],
  [`${WORKSPACE_ROOT_PATH}/telegram/attachments/logo.svg`, rejotLogoSvg],
  [
    `${SYSTEM_ROOT_PATH}/SYSTEM.md`,
    `# Backoffice system

You operate inside a controlled workspace.

- Files are persistent workspace state.
- Workflows provide deterministic execution.
- External side effects are limited by integrations and permissions.
- Sessions are append-only JSONL records.`,
  ],
]);

const WORKSPACE_SOURCE: FilesExplorerSource = {
  tree: createFileTree([
    {
      kind: "file",
      path: "AGENTS.md",
      sizeBytes: 224,
      contentType: "text/markdown",
      updatedAt: "2026-08-24T14:30:00.000Z",
      metadata: { visibility: "workspace" },
    },
    {
      kind: "file",
      path: "MEMORY.md",
      sizeBytes: 238,
      contentType: "text/markdown",
      updatedAt: "2026-08-24T14:32:11.000Z",
      metadata: { visibility: "workspace" },
    },
    {
      kind: "file",
      path: ".pi/sessions/qtnojobzvxetnojobzvxetno.jsonl",
      sizeBytes: 291977,
      contentType: "application/x-ndjson",
      updatedAt: "2026-08-21T15:29:00.000Z",
      metadata: { version: 3, status: "complete", visibility: "internal" },
    },
    {
      kind: "file",
      path: ".pi/sessions/k2bdtz7342472bdtz7342472.jsonl",
      sizeBytes: 260488,
      contentType: "application/x-ndjson",
      updatedAt: "2026-08-20T10:55:00.000Z",
      metadata: { version: 3, status: "complete", visibility: "internal" },
    },
    {
      kind: "file",
      path: "telegram/attachments/logo.svg",
      sizeBytes: 5267,
      contentType: "image/svg+xml",
      updatedAt: "2026-08-24T15:12:00.000Z",
      metadata: { provider: "telegram", filename: "logo.svg", visibility: "workspace" },
    },
  ]),
  rootPath: WORKSPACE_ROOT_PATH,
  rootTitle: "Workspace",
  rootDescription:
    "Persistent files available to sessions, agents, and workflows in this workspace.",
  rootKind: "custom",
  persistence: "persistent",
  detailFields: [
    { label: "Scope", value: "Workspace" },
    { label: "Persistence", value: "Durable" },
  ],
};

const SYSTEM_SOURCE: FilesExplorerSource = {
  tree: createFileTree([
    {
      kind: "file",
      path: "SYSTEM.md",
      sizeBytes: 268,
      contentType: "text/markdown",
      updatedAt: "2026-08-24T12:00:00.000Z",
      metadata: { visibility: "system" },
    },
  ]),
  rootPath: SYSTEM_ROOT_PATH,
  rootTitle: "System",
  rootDescription: "Read-only instructions supplied by the Backoffice runtime.",
  rootKind: "static",
  persistence: "persistent",
  readOnly: true,
  detailFields: [
    { label: "Scope", value: "System" },
    { label: "Access", value: "Read-only" },
  ],
};

export function DurableWorkspace() {
  const [selectedPath, setSelectedPath] = useState(`${WORKSPACE_ROOT_PATH}/AGENTS.md`);
  const selectedText = WORKSPACE_FILE_CONTENT.get(selectedPath) ?? null;

  return (
    <section aria-labelledby="durable-artifacts-heading">
      <div className="grid gap-8 lg:grid-cols-[0.34fr_0.66fr] lg:items-end">
        <div>
          <h2
            id="durable-artifacts-heading"
            className="max-w-sm text-[clamp(2.25rem,4.4vw,4.25rem)] leading-[0.96] font-[560] tracking-[-0.055em] text-balance"
          >
            A file system per workspace.
          </h2>
        </div>
        <p className="max-w-xl text-sm leading-7 text-pretty text-[var(--bo-muted)] lg:justify-self-end">
          Each workspace includes a persistent file system shared by sessions, agents, and
          workflows. Agent instructions, memory, session logs, and generated artifacts remain
          available across runs.
        </p>
      </div>

      <div id="workspace-artifacts" className="mt-10 min-h-[500px] scroll-mt-8">
        <FilesExplorerView
          sources={[WORKSPACE_SOURCE, SYSTEM_SOURCE]}
          selectedPath={selectedPath}
          selectedContent={selectedText ? { path: selectedPath, text: selectedText } : null}
          loadError={null}
          buildNodeTo={() => ""}
          onNodeSelect={(node) => {
            if (node.kind === "file") {
              setSelectedPath(node.path);
            }
          }}
          treeAriaLabel="Workspace and system files"
          rootSelection="detail"
          detailHeadingLevel={3}
          workflowRouting={{ status: "unavailable" }}
        />
      </div>
    </section>
  );
}

# Backoffice chat

The chat with a Backoffice agent, as Backoffice shows it and as apps embed it. It renders the
messages `@fragno-private/backoffice-conversation` projects from the conversation with assistant-ui,
on the presentational chat components of `@fragno-private/design-system/agents`.

- `thread/`: the thread and its composer (`session-thread`), and the view options.
- `messages/`: user messages, the agent's turns with their activity, compactions, and notifications
  (`messages`), and how a turn splits into work and what was said (`agent-turn`).
- `tools/`: a tool call, a codemode run with its code, result, logs, and calls, and tool results,
  including generated interfaces.
- `workspace/`: the side workspace a turn's generated interfaces open in.

## Extensions

The conversation names things only the host can show: workspace files, workflow runs, subagents.
`ChatExtensionsProvider` gives the chat the host's components for them (`extensions`); without one,
the chat shows less, never something else. Backoffice provides all of them
(`apps/backoffice/app/routes/backoffice/agents/session-detail/backoffice-chat-extensions.tsx`).

A host's stylesheet imports `@fragno-private/backoffice-chat/styles.css` after the design system's
theme, so Tailwind sees the classes the chat uses.

Markdown renders through `backoffice-ui`'s `MarkdownTextProvider`, as generated interfaces do.
Backoffice's links workspace paths to their files; a host without files provides `MarkdownText` from
`messages/markdown`.

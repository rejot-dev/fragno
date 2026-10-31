# Telegram Channel

Telegram Channel installs two workflows and their managed automation routes:

- `/start`, sent in a private chat, links a Telegram user to a Backoffice user through an OTP
  identity claim.
- `/pi` reports which Pi agent the chat talks to.
- Ordinary non-command messages run a turn of the `telegram` agent as the sender's linked user and
  send its answer back to the chat.

Version 1.0.1 starts Pi workflows as the user linked to the trusted Telegram initiator and lets the
Telegram Pi route inherit that user's current permissions.

Version 1.1.0 sends replies through the `backoffice#telegram` integration, because the standalone
`telegram.*` tools and permissions were removed; earlier versions no longer install. The `/start`
route grants `integrations.execute` instead of `telegram.send`, and the Pi route's linked user needs
it.

Version 1.2.0 defines a `telegram` agent and sends every linked chat's messages to that agent,
because Pi sessions were replaced by defined agents and earlier versions no longer run. Chats in one
scope share the agent's conversation, so each message names its chat; each turn still runs with the
linked user's permissions.

Version 1.3.0 submits each message to the `telegram` agent and sleeps until its turn ends, because
`pi.runPrompt` was removed and earlier versions no longer answer. Its routes send the agent's
`turn.completed`, `turn.failed`, `turn.aborted`, and `queue.dropped` events back to the workflow run
that submitted the prompt. For a completed turn, the run reads the answer with `pi.listMessages` as
the linked user, who needs `pi.read`, and sends it to the chat.

Version 2.0.0 declares its routes in `.marketplace/installation.json`, so Backoffice keeps them in
sync with the installation and removes them on uninstall. Its install workflow only sets up the
`telegram` agent. Installing it approves `identity.resolve`, `integrations.execute`, `otp.create`,
`pi.manage`, `pi.read`, and `store.modify`.

Version 2.1.0 declares the `telegram` agent too, and has no install workflow. Installing it approves
`identity.resolve`, `integrations.execute`, `otp.create`, and `store.modify`; the agent answers with
each linked user's own permissions. Upgrading from 2.0.0 takes over the agent 2.0.0 defined, and
uninstalling deletes it.

Version 2.1.1 reads a completed turn's answer with `pi.getPrompt`, which keeps it however the
agent's context changes later. Earlier versions look it up by its entry in the agent's messages.

Version 3.0.0 links Telegram users instead of chats, because Backoffice now names the person who
sent a message rather than the chat it was sent in. A linked user's messages in groups run with that
user's permissions, and each prompt names both the chat and the sender. `/start` in a group asks the
sender to link in a private chat, where no one else sees the claim link. Links made with earlier
versions name chats and no longer apply; send `/start` again to link.

Install this item into an organization, project, or personal automation scope. Telegram connection
availability is configured separately.

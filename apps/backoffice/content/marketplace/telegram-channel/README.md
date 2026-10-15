# Telegram Channel

Telegram Channel installs two workflows and their managed automation routes:

- `/start` links a Telegram chat to a Backoffice user through an OTP identity claim.
- `/pi` reports which Pi agent the chat talks to.
- Ordinary non-command messages run a turn of the `telegram` agent and send its answer back to
  Telegram.

Version 1.0.1 starts Pi workflows as the user linked to the trusted Telegram initiator and lets the
Telegram Pi route inherit that user's current permissions.

Version 1.1.0 sends replies through the `backoffice#telegram` integration, because the standalone
`telegram.*` tools and permissions were removed; earlier versions no longer install. The `/start`
route grants `integrations.execute` instead of `telegram.send`, and the Pi route's linked user needs
it.

Version 1.2.0 installs `agents/telegram.md` and sends every linked chat's messages to that agent,
because Pi sessions were replaced by defined agents and earlier versions no longer run. Chats in one
scope share the agent's conversation, so each message names its chat; each turn still runs with the
linked user's permissions.

Install this item into an organization, project, or personal automation scope. Telegram connection
availability is configured separately.

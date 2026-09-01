# Telegram Channel

Telegram Channel installs two workflows and their managed automation routes:

- `/start` links a Telegram chat to a Backoffice user through an OTP identity claim.
- `/pi` creates or reports the chat user's Pi session.
- Ordinary non-command messages run a Pi turn and send the response back to Telegram.

Version 1.0.1 starts Pi workflows as the user linked to the trusted Telegram initiator and lets the
Telegram Pi route inherit that user's current permissions.

Install this item into an organization, project, or personal automation scope. Telegram connection
availability is configured separately.

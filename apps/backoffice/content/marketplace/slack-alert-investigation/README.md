# Slack alert investigation

Investigates every new top-level message in one Slack channel, such as the channel PagerDuty or
another alerting tool posts to, and replies in the message's thread:

1. a message that the investigation started;
2. the report, or a message that the investigation failed and why.

Investigations are read-only. They never change code, infrastructure or alerts.

## How it works

1. The workflow syncs your repository's `main` branch into a sandbox and pins the current commit.
2. It searches that commit for the alert's error text and stack frames.
3. When a Cloudflare account is linked and the alert names a Cloudflare Worker, it checks whether
   the repository deploys that Worker and reads the Worker's telemetry for the alert's time window.
4. The **alert-code-investigator** agent traces the error through the code. It is the only part that
   runs commands in the sandbox.
5. The **alert-investigator** agent correlates the code findings with the telemetry and writes the
   report. Its evidence is saved under `/workspace/investigations/alerts/<Slack timestamp>/`.
6. The sandbox is stopped when no other investigation still uses it.

## Before you install

- **Slack:** the `api#slack` connection, and a route that turns the channel's Slack webhooks into
  `slack` `message.received` events with `teamId`, `channelId` and the Slack `event` in their
  payload. This package does not create that route.
- **GitHub:** a connection that can read the repository and mint a read-only access token.
- **Cloudflare (optional):** the `mcp#cloudflare` connection, with read access to the account's
  Workers and Workers Observability.

## Settings

The install form asks for:

| Setting               | Example                                       |
| --------------------- | --------------------------------------------- |
| Slack workspace ID    | `T0123456789`                                 |
| Slack channel ID      | `C0123456789`                                 |
| GitHub repository     | `acme/app`                                    |
| GitHub connection     | `github#acme/app`                             |
| Cloudflare account ID | leave empty to investigate without Cloudflare |

Install the same version again to change them.

Every Slack message in the workspace starts a short workflow run, because route triggers cannot read
settings; runs for other channels end immediately.

# Telegram test command

This Marketplace item installs a durable workflow that responds to the `/test` Telegram command
after a three-second delay. Version 1.3.0 adds an installation interface for choosing the reply and
stores that message in the selected automation scope.

Version 1.4.0 sends the reply through the `backoffice#telegram` integration, because the standalone
`telegram.*` tools and permissions were removed; earlier versions no longer install. Its route
grants `integrations.execute` instead of `telegram.send`.

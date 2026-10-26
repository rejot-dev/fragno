# GitHub Channel

GitHub Channel creates automation event definitions and installs managed routes that classify
generic `webhook.received` events into automation-ready GitHub events:

- `issues.opened`
- `issue_comment.created`
- `pull_request.opened`
- `pull_request.synchronize`
- `push`

Version 1.1.0 declares its routes in `.marketplace/installation.json`, so Backoffice keeps them in
sync with the installation and removes them on uninstall. Installing it approves `events.manage` and
`events.read`, which its install workflow uses to define the events.

Install this item into an organization automation scope with a configured GitHub connection.

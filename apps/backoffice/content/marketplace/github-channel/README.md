# GitHub Channel

GitHub Channel defines automation events and installs managed routes that classify generic
`webhook.received` events into automation-ready GitHub events:

- `issues.opened`
- `issue_comment.created`
- `pull_request.opened`
- `pull_request.synchronize`
- `push`

Version 1.2.0 declares its event definitions and routes in `.marketplace/installation.json`, so
Backoffice keeps both in sync with the installation and removes them on uninstall. It needs no
permissions and has no install workflow. Upgrading from an earlier version takes over the event
definitions that version created, as long as nobody changed them.

Install this item into an organization workspace with a configured GitHub connection; GitHub
deliveries arrive there.

# About the Backoffice file system

> Status: outline · Documentation type: explanation

This document should explain the combined filesystem presented to codemode and the UI, including how
independent contributors are mounted into one namespace.

## Planned sections

- The master filesystem and mount routing.
- Standard mounts: `/static`, `/system`, `/workspace`, `/r2`, and `/r2-remote`.
- Product-owned, system-owned, user-editable, temporary, and remote files.
- Scope resolution, principals, ownership, groups, and permissions.
- Read-only mounts and write routing.
- Synthetic directories and path normalization.
- File contributors, lazy artifacts, and dynamic projections.
- Uploads, project workspaces, event history, and durable-hook files.
- Filesystem access through codemode state methods.

## Code references

- `apps/backoffice/app/files/interface.ts` — filesystem interface.
- `apps/backoffice/app/files/master-file-system.ts` — mount router.
- `apps/backoffice/app/files/create-file-system.ts` — scoped filesystem construction.
- `apps/backoffice/app/files/contributors/index.ts` — built-in contributors.
- `apps/backoffice/app/files/contributors/` — mount implementations.
- `apps/backoffice/app/files/permissions.ts` — permission model.
- `apps/backoffice/app/files/normalize-path.ts` — path rules.
- `apps/backoffice/app/file-collection/` — tree and collection projections.
- `apps/backoffice/app/fragno/codemode/master-file-system-state.ts` — codemode filesystem adapter.
- `apps/backoffice/app/routes/backoffice/files/` — file explorer and download routes.
- `apps/backoffice/content/static/codemode/state.d.ts` — filesystem methods visible to codemode.

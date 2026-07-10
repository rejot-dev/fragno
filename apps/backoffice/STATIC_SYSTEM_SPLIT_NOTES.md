# Static/System Filesystem Split Notes

This documents the important follow-up review points for the `/static` + `/system` filesystem split.

## Summary

The filesystem split is now:

- `/static`: product-owned, read-only, visible support files for all normal scopes.
- `/system`: admin/system-scope filesystem for system execution files only.
- `/workspace`: editable org/user/project workspace files.

Key implementation points:

- Static mount implementation: `app/files/contributors/static.ts`
- Static content bundle: `app/files/content/static.ts`
- System content bundle: `app/files/content/system.ts`
- Static automation content: `app/files/content/static-automations.ts`
- System automation content: `app/files/content/system-automations.ts`
- Built-in contributor registration: `app/files/contributors/index.ts`
- Mount ordering: `app/files/master-file-system.ts`

## Things to be aware of

### 1. `/static/codemode/**` is generated on demand

Codemode declarations are no longer persisted by a sync workflow. They are generated into the
`/static` mount when the filesystem is read.

Review:

- `app/fragno/codemode/static-codemode-artifacts.ts`
- `app/files/contributors/static.ts`
- `app/files/create-file-system.ts`
- `app/files/system-context.ts`
- `app/files/types.ts`

Call sites that provide generated static artifacts:

- `app/routes/backoffice/files/data.ts`
- `app/routes/backoffice/automations/data.server.ts`
- `app/routes/backoffice/terminal.server.ts`
- `app/routes/backoffice/pi-terminal-action.ts`
- `app/routes/dev/codemode.ts`
- `app/routes/dev/codemode-bash.ts`
- `app/routes/dev/codemode-system-md.ts`
- `app/fragno/pi/pi.ts`
- `app/fragno/automation/scenario.ts`

Potential follow-up: add request/session-level caching if repeated `/static/codemode` reads become
expensive.

### 2. `internal.codemode.types.sync` was removed

The old sync tool and refresh workflow/routes are gone because generated codemode files are now
read-time artifacts.

Review:

- Removed from `app/fragno/runtime-tools/families/internal.ts`
- Removed route definitions from `app/fragno/automation/content/starter-routing.ts`
- Removed static workflow from `app/files/content/static-automations.ts`
- Workspace initialization no longer calls it in `app/files/content/system-automations.ts`

Behavioral impact: capability/MCP changes no longer create “codemode refresh” workflow history. The
next read of `/static/codemode/**` reflects current config.

### 3. `/system` visibility is now restricted

`/system` is no longer the visible product content mount. Non-admin/user automation contexts should
use `/static`.

Review:

- Visibility gate: `app/files/contributors/static.ts`
- Automations default filesystem: `workers/automations.do.ts`
- Automation roots/layers: `app/fragno/automation/catalog.ts`

Important path moves:

- `/system/SYSTEM.md` → `/static/SYSTEM.md`
- `/system/skills/**` → `/static/skills/**`
- `/system/automations/project-files-configure.workflow.js` →
  `/static/automations/project-files-configure.workflow.js`
- `/system/automations/workspace-file-initialization.workflow.js` stays in `/system`

### 4. Workspace starter no longer seeds built-in skills

Built-in skills now live only in `/static/skills`. `/workspace/skills` remains supported for
user-authored custom skills, but built-ins are no longer copied there by starter seeding.

Review:

- `app/files/content/starter.ts`
- Pi skill lookup: `app/fragno/pi/pi-skills.ts`
- Prompt guidance: `app/files/content/static.ts`
- Connection skill guidance: `app/files/content/skills.ts`

### 5. Automation script layers now include `static`

Automation catalog layers are now:

- `static`
- `system`
- `workspace`

Review:

- `app/fragno/automation/catalog.ts`
- UI/data mapping: `app/routes/backoffice/automations/data.server.ts`
- Starter routes: `app/fragno/automation/content/starter-routing.ts`

### 6. Generated `.d.ts` ordering changed

`app/fragno/runtime-tools/reference.ts` now emits the provider type alias before detailed
input/output declarations. Tests pass, but this is a generated declaration ordering change and may
be worth a quick review.

Review:

- `app/fragno/runtime-tools/reference.ts`
- `app/fragno/runtime-tools/reference.test.ts`

## Validation already run

```bash
pnpm exec tsc --noEmit --pretty false --project apps/backoffice/tsconfig.json
```

Relevant Vitest suites passed: 17 files, 175 tests.

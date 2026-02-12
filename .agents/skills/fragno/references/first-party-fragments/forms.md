# Forms Fragment (@fragno-dev/forms)

## Summary

A complete form management system built on JSON Schema and JSON Forms, with admin routes for
creation and response management, and a public API for form rendering and submission.

## Use when

- You need schema-driven forms with validation and stored responses.
- You want admin-managed form lifecycle and content.
- You want to render with JSON Forms or shadcn/ui.

## Config

The fragment config controls lifecycle callbacks and static forms.

What you provide:

- `onFormCreated` (optional): callback when a new form is created.
- `onResponseSubmitted` (optional): callback when a response is submitted.
- `staticForms` (optional): array of code-defined forms that are versioned in source.

What the fragment needs via options:

- `databaseAdapter`: required for forms and submissions tables.
- `mountRoute` (optional): defaults to `/api/forms`.

## What you get

- Public routes to fetch and submit forms by slug.
- Admin routes for managing forms and submissions.
- Static forms defined in code or dynamic forms created via API.
- Hooks for lifecycle events such as `onFormCreated` and `onResponseSubmitted`.

## Docs (curl)

Main docs pages:

- `curl -L "https://fragno.dev/docs/forms/quickstart" -H "accept: text/markdown"`
- `curl -L "https://fragno.dev/docs/forms/hooks" -H "accept: text/markdown"`
- `curl -L "https://fragno.dev/docs/forms/static-forms" -H "accept: text/markdown"`

Search:

- `curl -s "https://fragno.dev/api/search?query=forms"`

## Prerequisites

- A database and `@fragno-dev/db` adapter.
- A JSON Forms renderer set or the shadcn/ui renderer.
- Middleware to secure `/admin/*` routes.

## Install

`npm install @fragno-dev/forms @fragno-dev/db`

## Server setup

1. Create a DB adapter.
2. Instantiate the fragment:
   - `createFormsFragment({ onFormCreated, onResponseSubmitted, staticForms? }, { databaseAdapter })`
3. Mount routes in your framework.
4. Generate migrations with `fragno-cli`.
5. Protect `/admin` routes using fragment middleware.

Example server module:

```ts
import { createFormsFragment } from "@fragno-dev/forms";
import { fragmentDbAdapter } from "./db";

export const formsFragment = createFormsFragment(
  {
    onFormCreated: async (form) => {
      console.log("Form created", form.id);
    },
    onResponseSubmitted: async (response) => {
      console.log("New response", response.id);
    },
    staticForms: [],
  },
  { databaseAdapter: fragmentDbAdapter },
);
```

## Database migrations

Generate schema/migrations:

- `npx fragno-cli db generate lib/forms.ts --format drizzle -o db/forms.schema.ts`
- `npx fragno-cli db generate lib/forms.ts --output migrations/001_forms.sql`

## Client setup

Create a client using the framework entrypoint, e.g. React:

```ts
import { createFormsFragmentClient } from "@fragno-dev/forms/react";

export const formsClient = createFormsFragmentClient({
  mountRoute: "/api/forms",
});
```

## Hooks

Public:

- `useForm`
- `useSubmitForm`

Admin:

- `useForms`
- `useFormById`
- `useCreateForm`
- `useUpdateForm`
- `useDeleteForm`
- `useSubmissions`
- `useSubmission`
- `useDeleteSubmission`

## Static vs dynamic forms

- Static forms are defined in code and versioned manually.
- Dynamic forms are created via admin API and versioned automatically.
- Both are served and submitted in the same way by clients.

## Rendering options

- JSON Forms renderer sets from the JSON Forms ecosystem.
- shadcn/ui renderer: `@fragno-dev/jsonforms-shadcn-renderers`.

## Security notes

- Use middleware to restrict `/admin/*` routes.
- Consider bot protection for public submissions using Turnstile.

## Common pitfalls

- Forgetting to generate DB schema/migrations before first run.
- Leaving admin routes unprotected.
- Not aligning the client `mountRoute` with server configuration.

## Next steps

- Add a form builder UI with shadcn/ui.
- Use static forms for versioned schemas in code.

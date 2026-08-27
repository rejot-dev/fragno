---
name: forms
description:
  Create, update, and inspect system Forms with runtime tools. Use when designing a JSON Schema
  form, changing its stored definition, reading submissions, or routing form lifecycle events.
---

# Forms

Backoffice Forms is available only in the global system scope.

## Schema reference

Before filling in `--data-schema-json` or `--ui-schema-json`, read
`/static/skills/forms/reference/schema-authoring.md` for the renderer-supported JSON Schema and JSON
Forms UI Schema vocabulary, rules, and complete examples.

## Create and verify

1. Design the response contract as JSON Schema.
2. Choose a stable lowercase slug.
3. Create the form with `forms.create`.
4. Keep the returned form ID; submission tools address forms by ID, not slug.
5. Run `forms.list` and verify the title, slug, status, schema, and version.

Create a draft contact form:

```bash
forms.create \
  --title "Contact form" \
  --slug contact \
  --description "Collect support requests" \
  --data-schema-json '{"type":"object","properties":{"email":{"type":"string","format":"email"},"message":{"type":"string","minLength":10}},"required":["email","message"]}' \
  --format json
```

`forms.create` accepts:

- `--title`: human-readable name;
- `--slug`: public identifier;
- `--description`: optional purpose;
- `--status`: `draft`, `open`, or `closed`; defaults to `draft`;
- `--data-schema-json`: required JSON Schema object;
- `--ui-schema-json`: optional JSON Forms UI Schema object.

Use `--status open` only when the form should accept responses immediately. Use `draft` while its
schema is still being reviewed.

Confirm the stored form and capture its `id`:

```bash
forms.list --format json
```

Creation is complete when `forms.list` contains exactly the intended slug, status, response
contract, and UI layout.

## Update and verify

Update selected fields using the form ID:

```bash
forms.update --form-id FORM_ID --status open --format json
```

`forms.update` accepts `--title`, `--slug`, `--description`, `--status`, `--data-schema-json`, and
`--ui-schema-json`. Only supplied fields change. Replacing the data schema increments the form
version, so verify the resulting definition with `forms.list --format json` before interpreting new
submissions.

## Read submissions

List a form's responses using the ID returned by `forms.create` or `forms.list`:

```bash
forms.submissions.list --form-id FORM_ID --format json
```

Responses are newest-first by default and are returned in bounded pages. Read them oldest-first or
choose a smaller page when reconstructing a timeline:

```bash
forms.submissions.list --form-id FORM_ID --sort-order asc --page-size 25 --format json
```

When `hasNextPage` is true, pass the returned `nextCursor` to continue:

```bash
forms.submissions.list --form-id FORM_ID --cursor NEXT_CURSOR --format json
```

An empty `submissions` array means no response has been stored for that form. Compare each
submission's `formVersion` with the current version from `forms.list` before interpreting data from
forms whose schema has changed.

## Schema guidance

Use an object-rooted `dataSchema` and start with the smallest response contract that collects the
required result. Treat `dataSchema` as validation and `uiSchema` as presentation; read the schema
reference before relying on a field type, layout, option, or conditional rule.

## Automation events

Use `forms / response.submitted` for automated processing and `forms.submissions.list` for
inspection or reconciliation. Forms events are durable and at-least-once, so key event-driven
effects by the event ID or the subject identifiers described in the event reference.

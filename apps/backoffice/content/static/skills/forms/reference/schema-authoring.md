# Forms schema authoring

Read this reference before writing `--data-schema-json` or `--ui-schema-json`. The data schema owns
validation and stored response meaning. The UI schema owns ordering, layout, control options, and
conditional presentation.

## Authoring boundary

Use an object at the root:

```json
{
  "type": "object",
  "additionalProperties": false,
  "properties": {},
  "required": []
}
```

- Put every submitted field under `properties`.
- Put a property name in `required` only when omission is invalid.
- Use `additionalProperties: false` when the response must contain only declared fields.
- Use stable property names. Labels and layout can change without changing stored data keys.
- Add `title` and `description` to field schemas for respondent-facing labels and help text.
- Encode validation in `dataSchema`; presentation hints in `uiSchema` do not validate submissions.

The Forms service converts `dataSchema` into its runtime validator when the form is created and
again when submissions are validated. A syntactically valid JSON object can still be rejected as an
unsupported or invalid JSON Schema.

## Predictably rendered field vocabulary

The current Backoffice public form renderer has dedicated controls for these schema shapes:

| Data schema                       | Rendered control         | Useful validation keywords                                   |
| --------------------------------- | ------------------------ | ------------------------------------------------------------ |
| `{ "type": "string" }`            | Single-line text input   | `minLength`, `maxLength`, `pattern`                          |
| String with `format: "email"`     | Email input              | Email format validation                                      |
| String with `format: "date"`      | Date input               | Date format validation                                       |
| String with `format: "time"`      | Time input               | Time format validation                                       |
| String with `format: "date-time"` | Date-time input          | Date-time format validation                                  |
| String or number with `enum`      | Select control           | `enum`                                                       |
| `{ "type": "number" }`            | Number input             | `minimum`, `maximum`, `exclusiveMinimum`, `exclusiveMaximum` |
| `{ "type": "integer" }`           | Whole-number input       | Numeric bounds                                               |
| `{ "type": "boolean" }`           | Checkbox                 | `const` when one value is required                           |
| `{ "type": "object" }`            | Nested group of controls | `properties`, `required`, `additionalProperties`             |

The renderer does not currently provide dedicated array, tuple, file, categorization/tab, or
composition (`oneOf`/`anyOf`/`allOf`) controls. Keep public form schemas within the vocabulary above
unless the renderer is extended and verified first.

## String fields

```json
{
  "type": "string",
  "title": "Work email",
  "description": "Use the address where we should send your invitation.",
  "format": "email",
  "maxLength": 320
}
```

Use `pattern` only when a structural rule cannot be expressed by a standard format. JSON Schema
patterns match anywhere unless the expression includes anchors:

```json
{
  "type": "string",
  "title": "Postal code",
  "pattern": "^[0-9]{5}$"
}
```

For multiline text, keep the data schema as a string and set the control's `multi` UI option.

## Enum fields

```json
{
  "type": "string",
  "title": "Team size",
  "enum": ["1-10", "11-50", "51-200", "201+"]
}
```

Enum values are stored exactly as declared. Choose durable machine values rather than decorative
phrasing when automations branch on the answer.

## Number and integer fields

```json
{
  "type": "integer",
  "title": "Expected seats",
  "minimum": 1,
  "maximum": 10000
}
```

Use `integer` when fractional values are invalid and `number` when they are meaningful. Bounds are
validated by the schema even when browser-native number controls permit intermediate invalid text.

## Boolean fields

```json
{
  "type": "boolean",
  "title": "Send me product updates",
  "description": "You can change this preference later."
}
```

A boolean property can be omitted unless it is listed in the root `required` array. Decide whether
"not answered" and `false` are meaningfully distinct before making it optional.

## Nested objects

```json
{
  "type": "object",
  "additionalProperties": false,
  "properties": {
    "contact": {
      "type": "object",
      "title": "Primary contact",
      "additionalProperties": false,
      "properties": {
        "name": { "type": "string", "minLength": 1 },
        "email": { "type": "string", "format": "email" }
      },
      "required": ["name", "email"]
    }
  },
  "required": ["contact"]
}
```

Nested values are stored as nested JSON objects. UI Schema scopes follow the complete property path,
for example `#/properties/contact/properties/email`.

## UI Schema vocabulary

Omit `uiSchema` when generated field order is sufficient. Use it when the form needs explicit order,
layout, grouping, placeholders, multiline controls, or conditional behavior.

### Control

```json
{
  "type": "Control",
  "scope": "#/properties/email"
}
```

A control's `scope` is a JSON pointer into `dataSchema`. A stale or misspelled scope does not create
a new field; it leaves the intended property without that control.

Supported control options:

```json
{
  "type": "Control",
  "scope": "#/properties/notes",
  "options": {
    "multi": true,
    "placeholder": "What would you like to automate?"
  }
}
```

- `multi: true` renders a string as a multiline textarea.
- `placeholder` supplies temporary input guidance and does not replace a field title or description.

### VerticalLayout

```json
{
  "type": "VerticalLayout",
  "elements": [
    { "type": "Control", "scope": "#/properties/name" },
    { "type": "Control", "scope": "#/properties/email" }
  ]
}
```

Use this as the default explicit layout.

### HorizontalLayout

```json
{
  "type": "HorizontalLayout",
  "elements": [
    { "type": "Control", "scope": "#/properties/firstName" },
    { "type": "Control", "scope": "#/properties/lastName" }
  ]
}
```

Backoffice renders horizontal layouts as a responsive two-column grid. Keep each horizontal group to
two closely related controls; it collapses naturally on narrow screens.

### Group

```json
{
  "type": "Group",
  "label": "Company",
  "elements": [
    { "type": "Control", "scope": "#/properties/company" },
    { "type": "Control", "scope": "#/properties/role" }
  ]
}
```

A group renders a labeled fieldset. Use the label to name a real concept shared by its controls.

## Conditional rules

A control or layout can carry a JSON Forms rule. The condition scope reads submitted data, not the
schema definition.

Show a follow-up field only when consent is true:

```json
{
  "type": "Control",
  "scope": "#/properties/phone",
  "rule": {
    "effect": "SHOW",
    "condition": {
      "scope": "#/properties/contactByPhone",
      "schema": { "const": true }
    }
  }
}
```

Rule effects are `SHOW`, `HIDE`, `ENABLE`, and `DISABLE`. A presentation rule does not make hidden
or disabled data valid. Align conditional validation with the same business rule when the response
contract requires it; otherwise keep the conditional field optional.

## Complete waitlist example

Data schema:

```json
{
  "type": "object",
  "additionalProperties": false,
  "properties": {
    "name": {
      "type": "string",
      "title": "Name",
      "minLength": 1,
      "maxLength": 120
    },
    "email": {
      "type": "string",
      "title": "Work email",
      "format": "email",
      "maxLength": 320
    },
    "company": {
      "type": "string",
      "title": "Company",
      "maxLength": 160
    },
    "teamSize": {
      "type": "string",
      "title": "Team size",
      "enum": ["1-10", "11-50", "51-200", "201+"]
    },
    "useCase": {
      "type": "string",
      "title": "What would you like to automate?",
      "minLength": 10,
      "maxLength": 2000
    },
    "productUpdates": {
      "type": "boolean",
      "title": "Send me product updates"
    }
  },
  "required": ["name", "email", "useCase"]
}
```

UI schema:

```json
{
  "type": "VerticalLayout",
  "elements": [
    {
      "type": "HorizontalLayout",
      "elements": [
        { "type": "Control", "scope": "#/properties/name" },
        { "type": "Control", "scope": "#/properties/email" }
      ]
    },
    {
      "type": "Group",
      "label": "Company",
      "elements": [
        {
          "type": "HorizontalLayout",
          "elements": [
            { "type": "Control", "scope": "#/properties/company" },
            { "type": "Control", "scope": "#/properties/teamSize" }
          ]
        }
      ]
    },
    {
      "type": "Control",
      "scope": "#/properties/useCase",
      "options": {
        "multi": true,
        "placeholder": "Describe the workflow and the result you need."
      }
    },
    { "type": "Control", "scope": "#/properties/productUpdates" }
  ]
}
```

Create command:

```bash
forms.create \
  --title "Waitlist" \
  --slug waitlist \
  --description "Request early access" \
  --status open \
  --data-schema-json 'PASTE_DATA_SCHEMA_AS_ONE_JSON_VALUE' \
  --ui-schema-json 'PASTE_UI_SCHEMA_AS_ONE_JSON_VALUE' \
  --format json
```

Before running the command, serialize each schema as one valid JSON argument. After creation,
compare the `dataSchema` and `uiSchema` returned by `forms.list --format json` with the intended
documents.

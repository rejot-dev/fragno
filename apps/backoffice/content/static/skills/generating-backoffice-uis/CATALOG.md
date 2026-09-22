# Production Component Catalog

This reference is generated from the definitions used by runtime validation and rendering. Props are
strict: use only the fields shown by each props type and satisfy every listed limit.

### `Stack`

Arranges generated Backoffice content vertically with a controlled gap.

Props type:

```ts
{
  gap: "sm" | "md" | "lg";
}
```

Children: May contain child element ids.

Example props:

```json
{
  "gap": "md"
}
```

### `Grid`

Arranges related report items in a responsive one-to-four-column grid.

Props type:

```ts
{
  columns: 1 | 2 | 3 | 4;
  gap: "sm" | "md" | "lg";
}
```

Children: May contain child element ids.

Example props:

```json
{
  "columns": 3,
  "gap": "md"
}
```

### `Section`

Groups related report content in a square-edged Backoffice panel.

Props type:

```ts
{
  label?: string;
  variant?: "neutral" | "accent" | "live" | "warning" | "failed";
}
```

Limits:

- label: 1-80 characters

Children: May contain child element ids.

Example props:

```json
{
  "label": "Operations",
  "variant": "neutral"
}
```

### `Divider`

Separates report sections with an optional compact label.

Props type:

```ts
{
  label?: string;
}
```

Limits:

- label: 1-80 characters

Children: Must use an empty children array.

Example props:

```json
{
  "label": "Details"
}
```

### `Heading`

Displays a compact level-two, level-three, or level-four report heading.

Props type:

```ts
{
  text: string;
  level?: 2 | 3 | 4;
}
```

Limits:

- text: 1-200 characters

Children: Must use an empty children array.

Example props:

```json
{
  "text": "Order summary",
  "level": 2
}
```

### `Text`

Displays concise body text with default or muted emphasis.

Props type:

```ts
{
  text: string;
  tone?: "default" | "muted";
}
```

Limits:

- text: at most 4000 characters

Children: Must use an empty children array.

Example props:

```json
{
  "text": "Orders processed during the current period.",
  "tone": "muted"
}
```

### `Code`

Displays bounded source or diagnostic text in a read-only code block.

Props type:

```ts
{
  code: string;
  label?: string;
  language?: string;
}
```

Limits:

- code: at most 20000 characters
- label: 1-80 characters
- language: 1-32 characters

Children: Must use an empty children array.

Example props:

```json
{
  "code": "const status = \"ready\";",
  "label": "Handler",
  "language": "typescript"
}
```

### `Callout`

Highlights a concise operational note with a semantic status variant.

Props type:

```ts
{
  title: string;
  text: string;
  variant: "neutral" | "accent" | "live" | "warning" | "failed";
}
```

Limits:

- title: 1-120 characters
- text: 1-2000 characters

Children: Must use an empty children array.

Example props:

```json
{
  "title": "Sync delayed",
  "text": "The latest provider update is still being processed.",
  "variant": "warning"
}
```

### `Metric`

Displays one labeled operational metric with optional context and status emphasis.

Props type:

```ts
{
  label: string;
  value: string;
  detail?: string;
  variant?: "neutral" | "accent" | "live" | "warning" | "failed";
}
```

Limits:

- label: 1-120 characters
- value: at most 240 characters
- detail: at most 240 characters

Children: Must use an empty children array.

Example props:

```json
{
  "label": "Orders",
  "value": "24",
  "detail": "+8 this week",
  "variant": "live"
}
```

### `Badge`

Displays a compact semantic status label.

Props type:

```ts
{
  label: string;
  variant: "neutral" | "accent" | "live" | "warning" | "failed";
}
```

Limits:

- label: 1-80 characters

Children: Must use an empty children array.

Example props:

```json
{
  "label": "Live",
  "variant": "live"
}
```

### `KeyValue`

Displays compact label-value facts in a one- or two-column definition list.

Props type:

```ts
{
  columns: 1 | 2;
  items: {
    key: string;
    label: string;
    value: string;
  }
  [];
}
```

Limits:

- items: at most 32 items
- items[].key: 1-200 characters
- items[].label: 1-120 characters
- items[].value: at most 1000 characters

Children: Must use an empty children array.

Example props:

```json
{
  "columns": 2,
  "items": [
    {
      "key": "environment",
      "label": "Environment",
      "value": "Production"
    },
    {
      "key": "region",
      "label": "Region",
      "value": "us-east-1"
    }
  ]
}
```

### `List`

Displays up to 64 operational records with optional semantic statuses.

Props type:

```ts
{
  items: ({
    key: string;
    title: string;
    detail?: string;
    status?: string;
    variant?: "neutral" | "accent" | "live" | "warning" | "failed";
  })[];
}
```

Limits:

- items: at most 64 items
- items[].key: 1-200 characters
- items[].title: 1-200 characters
- items[].detail: at most 1000 characters
- items[].status: 1-80 characters

Children: Must use an empty children array.

Example props:

```json
{
  "items": [
    {
      "key": "daily-synchronization",
      "title": "Daily synchronization",
      "detail": "Completed 24 records.",
      "status": "Live",
      "variant": "live"
    }
  ]
}
```

### `Table`

Displays up to 64 text-only rows in a horizontally scrollable table.

Props type:

```ts
{
  caption: string;
  columns: ({
    key: string;
    label: string;
    align?: "start" | "end";
  })[];
  rows: {
    [key: string]: string;
  }[];
}
```

Limits:

- caption: 1-160 characters
- columns: 1-12 items
- columns[].key: 1-80 characters
- columns[].label: 1-120 characters
- rows: at most 64 items
- rows[].\*: at most 2000 characters

Children: Must use an empty children array.

Example props:

```json
{
  "caption": "Recent orders",
  "columns": [
    {
      "key": "id",
      "label": "ID"
    },
    {
      "key": "status",
      "label": "Status"
    },
    {
      "key": "total",
      "label": "Total",
      "align": "end"
    }
  ],
  "rows": [
    {
      "id": "ord_42",
      "status": "Fulfilled",
      "total": "$120.00"
    }
  ]
}
```

### `Progress`

Displays completion from zero to one hundred percent with semantic status styling.

Props type:

```ts
{
  label: string;
  value: number;
  detail?: string;
  variant: "neutral" | "accent" | "live" | "warning" | "failed";
}
```

Limits:

- label: 1-120 characters
- value: 0-100 numeric value
- detail: at most 240 characters

Children: Must use an empty children array.

Example props:

```json
{
  "label": "Import progress",
  "value": 72,
  "detail": "72 of 100 records",
  "variant": "accent"
}
```

### `TextInput`

Collects a short text value. Bind value with {$bindState: '/path'} so edits update UI state. Set
secret to true for sensitive values such as API keys.

Props type:

```ts
{
  label: string;
  value: string;
  placeholder?: string;
  description?: string;
  required?: boolean;
  disabled?: boolean;
  secret?: boolean;
}
```

Limits:

- label: 1-120 characters
- value: at most 4000 characters
- placeholder: at most 240 characters
- description: at most 500 characters

Children: Must use an empty children array.

Example props:

```json
{
  "label": "Reference",
  "value": {
    "$bindState": "/response/reference"
  },
  "placeholder": "Enter a reference"
}
```

### `TextArea`

Collects a longer text value. Bind value with {$bindState: '/path'} so edits update UI state.

Props type:

```ts
{
  label: string;
  value: string;
  placeholder?: string;
  description?: string;
  required?: boolean;
  disabled?: boolean;
  rows?: number;
}
```

Limits:

- label: 1-120 characters
- value: at most 12000 characters
- placeholder: at most 240 characters
- description: at most 500 characters
- rows: 2-12 numeric value

Children: Must use an empty children array.

Example props:

```json
{
  "label": "Reason",
  "value": {
    "$bindState": "/response/reason"
  },
  "rows": 4
}
```

### `Select`

Collects one value from a bounded list. Bind value with {$bindState: '/path'} so edits update UI
state.

Props type:

```ts
{
  label: string;
  value: string;
  options: {
    label: string;
    value: string;
  }[];
  description?: string;
  required?: boolean;
  disabled?: boolean;
}
```

Limits:

- label: 1-120 characters
- value: at most 500 characters
- options: 1-50 items
- options[].label: 1-120 characters
- options[].value: at most 500 characters
- description: at most 500 characters

Children: Must use an empty children array.

Example props:

```json
{
  "label": "Decision",
  "value": {
    "$bindState": "/response/decision"
  },
  "options": [
    {
      "label": "Approve",
      "value": "approve"
    },
    {
      "label": "Reject",
      "value": "reject"
    }
  ]
}
```

### `Checkbox`

Collects a boolean choice. Bind checked with {$bindState: '/path'} so edits update UI state.

Props type:

```ts
{
  label: string;
  checked: boolean;
  description?: string;
  required?: boolean;
  disabled?: boolean;
}
```

Limits:

- label: 1-240 characters
- description: at most 500 characters

Children: Must use an empty children array.

Example props:

```json
{
  "label": "I confirm this operation",
  "checked": {
    "$bindState": "/response/confirmed"
  }
}
```

### `FileUpload`

Uploads one private file as a prepared Upload draft. Use the current workflow context or a declared
org, project, or personal scope. Bind value with {$bindState: '/path'}; state receives one
serializable prepared-upload reference.

Props type:

```ts
{
  label: string;
  scope: {
    kind: "current";
  } | {
    kind: "org";
    orgId: string;
  } | {
    kind: "user";
    userId: string;
  } | {
    kind: "project";
    orgId: string;
    projectId: string;
  };
  value: {
    kind: "prepared-upload";
    scope: {
      kind: "org";
      orgId: string;
    } | {
      kind: "user";
      userId: string;
    } | {
      kind: "project";
      orgId: string;
      projectId: string;
    };
    uploadId: string;
    provider: string;
    fileKey: string;
    filename: string;
    sizeBytes: number;
    contentType: string;
    /** ISO 8601 datetime string. */
    expiresAt: string;
  } | null;
  description?: string;
  accept?: string[];
  maxSizeBytes?: number;
  required?: boolean;
  disabled?: boolean;
}
```

Limits:

- label: 1-120 characters
- description: at most 500 characters
- accept: 1-20 items
- accept[]: 1-120 characters
- maxSizeBytes: at most 9007199254740991 numeric value

Children: Must use an empty children array.

Example props:

```json
{
  "label": "Supporting document",
  "scope": {
    "kind": "current"
  },
  "value": {
    "$bindState": "/response/attachment"
  },
  "accept": [".pdf", "image/png", "image/jpeg"],
  "maxSizeBytes": 26214400,
  "required": true
}
```

### `WorkflowEventButton`

Sends payload to the current workflow waitForEvent step. Use only in durable workflow step UI, set
eventType to the exact awaited type, and read the complete payload from UI state with {$state:
'/path'}.

Props type:

```ts
{
  label: string;
  eventType: string;
  payload: unknown;
  variant?: "primary" | "danger";
  confirmation?: string;
}
```

Limits:

- label: 1-120 characters
- eventType: 1-128 characters
- confirmation: 1-500 characters

Children: Must use an empty children array.

Example props:

```json
{
  "label": "Submit decision",
  "eventType": "approval",
  "payload": {
    "$state": "/response"
  },
  "variant": "primary"
}
```

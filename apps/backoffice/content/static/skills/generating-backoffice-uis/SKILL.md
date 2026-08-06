---
name: generating-backoffice-uis
description:
  "Generate Backoffice interfaces for presenting grounded data or collecting durable workflow input."
---

# Generating Backoffice UIs

## Steps

1. **Ground.** Resolve the source data used by the interface. Use input, retrieved data, or
   persisted output already available to the current return path. Complete when every displayed
   operational value, record, status, and identifier traces to one of those sources.
2. **Compose.** Read `/static/skills/generating-backoffice-uis/CATALOG.md`, then derive a flat
   element graph from the grounded result. Complete when every component and prop matches the
   catalog and every spec invariant passes.
3. **Return.** Return one result object with `$ui` beside any ordinary fields needed by the user or
   later code. Complete when `$ui.version` is `1`, later code consumes ordinary fields rather than
   `$ui.state`, and follow-up prose does not restate rendered fields.

## Branches

- When returning `$ui` from `step.do` or as workflow output, read
  `/static/skills/workflows/SKILL.md` and `/static/skills/generating-backoffice-uis/WORKFLOWS.md`
  before authoring the workflow.
- When the interface contains `FileUpload`, read `/static/skills/using-prepared-uploads/SKILL.md`
  before composing it.

## Result contract

The immediate result must have an own top-level `$ui` field with `version: 1`:

```ts
type StateVisibilityCondition = {
  $state: string;
  eq?: unknown;
  neq?: unknown;
  gt?: number | { $state: string };
  gte?: number | { $state: string };
  lt?: number | { $state: string };
  lte?: number | { $state: string };
  not?: true;
};

type VisibilityCondition =
  | boolean
  | StateVisibilityCondition
  | StateVisibilityCondition[]
  | { $and: VisibilityCondition[] }
  | { $or: VisibilityCondition[] };

type BackofficeUiResult = {
  [ordinaryField: string]: unknown;
  $ui: {
    version: 1;
    state: Record<string, unknown>;
    spec: {
      root: string;
      elements: Record<
        string,
        {
          type: CatalogComponentName;
          props: Record<string, unknown>;
          children: string[];
          visible?: VisibilityCondition;
        }
      >;
    };
  };
};
```

Ordinary sibling fields remain part of the result. Preserve retrieved records, identifiers, and
calculated summaries there when they remain useful to the user or later code.

## Spec invariants

The installed json-render shape is a flat element graph:

- `root` names an element in `elements`.
- Every child names an element in the same `elements` record.
- Every element contains exactly `type`, `props`, and `children`, plus optional `visible`.
- Component and prop names are case-sensitive and match the production catalog.
- Component props may use read expressions such as `{ "$state": "/path" }` at any depth, including
  inside array items and object fields.
- Use `{ "$bindState": "/path" }` only as the complete top-level value of an editable component's
  natural value prop.
- `visible` may be a boolean or a state visibility condition. A state condition uses exactly one of
  `eq`, `neq`, `gt`, `gte`, `lt`, or `lte`; omitting the comparison checks truthiness. `not: true`
  inverts it. Arrays and `$and` are AND; `$or` is OR.
- Every root and child reference resolves, and the child graph is acyclic.
- The graph stays within 128 elements, 32 children per element, 512 total child references, and 24
  levels of depth.

## Immediate example

```js
async () => {
  const eventCatalog = await events.catalogList({});
  const sourceCount = new Set(eventCatalog.map((event) => event.source)).size;
  const summary = {
    eventTypeCount: eventCatalog.length,
    sourceCount,
  };

  return {
    eventCatalog,
    summary,
    $ui: {
      version: 1,
      state: {
        eventTypeCount: String(summary.eventTypeCount),
        sourceCount: String(summary.sourceCount),
      },
      spec: {
        root: "report",
        elements: {
          report: {
            type: "Stack",
            props: { gap: "md" },
            children: ["heading", "description", "event-types", "sources"],
          },
          heading: {
            type: "Heading",
            props: { text: "Event catalog" },
            children: [],
          },
          description: {
            type: "Text",
            props: { text: "Live capabilities retrieved from Backoffice." },
            children: [],
          },
          "event-types": {
            type: "Metric",
            props: {
              label: "Event types",
              value: { $state: "/eventTypeCount" },
            },
            children: [],
          },
          sources: {
            type: "Metric",
            props: {
              label: "Sources",
              value: { $state: "/sourceCount" },
            },
            children: [],
          },
        },
      },
    },
  };
};
```

## Presentation boundaries

Render content through catalog props as plain text. Raw HTML, scripts, iframes, embeds, arbitrary
URLs, class names, styles, and presentation colors are invalid. Let the rendered interface carry the
primary presentation rather than repeating it in Markdown.

import { backofficeUiComponentDefinitions } from "./catalog";
import { parseBackofficeUiResult, type BackofficeUiResultV1 } from "./result";

export type BackofficeUiDemoCategory = "Layout" | "Content" | "Data" | "Input";

export type BackofficeUiComponentDemo = {
  component: keyof typeof backofficeUiComponentDefinitions;
  category: BackofficeUiDemoCategory;
  description: string;
  result: BackofficeUiResultV1;
};

type DemoElement = {
  type: keyof typeof backofficeUiComponentDefinitions;
  props: Record<string, unknown>;
  children: string[];
};

type ComponentDemoInput = {
  component: keyof typeof backofficeUiComponentDefinitions;
  category: BackofficeUiDemoCategory;
  props: Record<string, unknown>;
  children?: Record<string, DemoElement>;
};

const componentDemoInputs: ComponentDemoInput[] = [
  {
    component: "Stack",
    category: "Layout",
    props: { gap: "sm" },
    children: {
      "stack-first": {
        type: "Text",
        props: { text: "First stacked item", tone: "default" },
        children: [],
      },
      "stack-second": {
        type: "Text",
        props: { text: "Second stacked item", tone: "muted" },
        children: [],
      },
    },
  },
  {
    component: "Grid",
    category: "Layout",
    props: { columns: 3, gap: "sm" },
    children: {
      "grid-one": {
        type: "Badge",
        props: { label: "One", variant: "neutral" },
        children: [],
      },
      "grid-two": {
        type: "Badge",
        props: { label: "Two", variant: "accent" },
        children: [],
      },
      "grid-three": {
        type: "Badge",
        props: { label: "Three", variant: "live" },
        children: [],
      },
    },
  },
  {
    component: "Section",
    category: "Layout",
    props: { label: "Operations", variant: "neutral" },
    children: {
      "section-copy": {
        type: "Text",
        props: { text: "A bordered group for related generated content.", tone: "muted" },
        children: [],
      },
    },
  },
  {
    component: "Divider",
    category: "Layout",
    props: { label: "Details" },
  },
  {
    component: "Heading",
    category: "Content",
    props: { text: "Operational summary", level: 2 },
  },
  {
    component: "Text",
    category: "Content",
    props: {
      text: "Supporting copy uses restrained Backoffice typography and readable line height.",
      tone: "muted",
    },
  },
  {
    component: "Code",
    category: "Content",
    props: {
      code: 'return { status: "delivered", attempts: 1 };',
      label: "Handler result",
      language: "javascript",
    },
  },
  {
    component: "Callout",
    category: "Content",
    props: {
      title: "Sync delayed",
      text: "The latest provider update is still being processed.",
      variant: "warning",
    },
  },
  {
    component: "Metric",
    category: "Data",
    props: {
      label: "Success rate",
      value: "99.8%",
      detail: "Past 24 hours",
      variant: "live",
    },
  },
  {
    component: "Badge",
    category: "Data",
    props: { label: "Live", variant: "live" },
  },
  {
    component: "KeyValue",
    category: "Data",
    props: {
      columns: 2,
      items: [
        { key: "environment", label: "Environment", value: "Production" },
        { key: "region", label: "Region", value: "us-east-1" },
      ],
    },
  },
  {
    component: "List",
    category: "Data",
    props: {
      items: [
        {
          key: "provider-catalog-synchronized",
          title: "Provider catalog synchronized",
          detail: "All capability declarations were refreshed.",
          status: "Live",
          variant: "live",
        },
        {
          key: "workflow-replay-scheduled",
          title: "Workflow replay scheduled",
          detail: "Seven instances remain queued.",
          status: "Waiting",
          variant: "warning",
        },
      ],
    },
  },
  {
    component: "Table",
    category: "Data",
    props: {
      caption: "Recent deliveries",
      columns: [
        { key: "id", label: "ID" },
        { key: "status", label: "Status" },
        { key: "duration", label: "Duration", align: "end" },
      ],
      rows: [
        { id: "evt_1042", status: "Delivered", duration: "128 ms" },
        { id: "evt_1041", status: "Delivered", duration: "142 ms" },
      ],
    },
  },
  {
    component: "Progress",
    category: "Data",
    props: {
      label: "Replay completion",
      value: 72,
      detail: "72 of 100 events",
      variant: "accent",
    },
  },
  {
    component: "TextInput",
    category: "Input",
    props: {
      label: "API key",
      value: "sk_example",
      placeholder: "Enter an API key",
      secret: true,
    },
  },
  {
    component: "TextArea",
    category: "Input",
    props: { label: "Reason", value: "Ready for approval.", rows: 3 },
  },
  {
    component: "Select",
    category: "Input",
    props: {
      label: "Decision",
      value: "approve",
      options: [
        { label: "Approve", value: "approve" },
        { label: "Reject", value: "reject" },
      ],
    },
  },
  {
    component: "Checkbox",
    category: "Input",
    props: { label: "I confirm this operation", checked: true },
  },
  {
    component: "FileUpload",
    category: "Input",
    props: {
      label: "Supporting document",
      scope: { kind: "project", orgId: "org-demo", projectId: "project-demo" },
      value: null,
      accept: [".pdf", "image/*"],
      maxSizeBytes: 26_214_400,
      required: true,
    },
  },
  {
    component: "WorkflowEventButton",
    category: "Input",
    props: {
      label: "Submit decision",
      eventType: "approval",
      payload: { decision: "approve" },
      variant: "primary",
    },
  },
];

export const BACKOFFICE_UI_COMPONENT_DEMOS = componentDemoInputs.map(
  ({ component, category, props, children = {} }): BackofficeUiComponentDemo => {
    const childIds = Object.keys(children);
    const parsedResult = parseBackofficeUiResult({
      component,
      $ui: {
        version: 1,
        state: {},
        spec: {
          root: "demo",
          elements: {
            demo: { type: component, props, children: childIds },
            ...children,
          },
        },
      },
    });

    if (parsedResult.kind !== "valid") {
      const validationFailure =
        parsedResult.kind === "invalid"
          ? `${parsedResult.code}: ${parsedResult.message}`
          : "the fixture was not recognized as a tagged generated UI result";
      throw new Error(`${component} demo must remain valid: ${validationFailure}`);
    }

    return {
      component,
      category,
      description: backofficeUiComponentDefinitions[component].description,
      result: parsedResult.value,
    };
  },
);

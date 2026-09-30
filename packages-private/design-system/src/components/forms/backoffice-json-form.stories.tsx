import { type ReactNode, useState } from "react";

import type { JsonSchema } from "@jsonforms/core";

import { BackofficeJsonForm } from "./backoffice-json-form";

export default { title: "Forms/JSON form" };

const schema: JsonSchema = {
  type: "object",
  required: ["name", "email"],
  properties: {
    name: { type: "string", minLength: 2 },
    email: { type: "string", format: "email" },
    plan: { type: "string", enum: ["free", "team", "enterprise"] },
    seats: { type: "integer", minimum: 1 },
    newsletter: { type: "boolean" },
    notes: { type: "string" },
  },
};

const uiSchema = {
  type: "VerticalLayout",
  elements: [
    { type: "Control", scope: "#/properties/name" },
    { type: "Control", scope: "#/properties/email" },
    {
      type: "HorizontalLayout",
      elements: [
        { type: "Control", scope: "#/properties/plan" },
        { type: "Control", scope: "#/properties/seats" },
      ],
    },
    { type: "Control", scope: "#/properties/newsletter" },
    { type: "Control", scope: "#/properties/notes", options: { multi: true } },
  ],
};

// Echoes the last submission so validation and the submitted shape are visible in the viewer.
function SubmissionEcho({
  children,
}: {
  children: (onSubmit: (data: unknown) => void) => ReactNode;
}) {
  const [submitted, setSubmitted] = useState<unknown>(null);
  return (
    <div className="max-w-xl space-y-4">
      {children(setSubmitted)}
      <pre className="border border-[color:var(--bo-border)] bg-[var(--bo-panel-2)] p-3 text-xs">
        {submitted === null ? "Not submitted yet" : JSON.stringify(submitted, null, 2)}
      </pre>
    </div>
  );
}

export function Editable() {
  return (
    <SubmissionEcho>
      {(onSubmit) => (
        <BackofficeJsonForm
          schema={schema}
          uiSchema={uiSchema}
          submitLabel="Create customer"
          onSubmit={onSubmit}
        />
      )}
    </SubmissionEcho>
  );
}

export function ReadOnly() {
  return (
    <div className="max-w-xl">
      <BackofficeJsonForm
        schema={schema}
        uiSchema={uiSchema}
        readOnly
        initialData={{ name: "Ada", email: "ada@example.com", plan: "team", seats: 4 }}
      />
    </div>
  );
}

export function GeneratedLayout() {
  return (
    <SubmissionEcho>
      {(onSubmit) => <BackofficeJsonForm schema={schema} onSubmit={onSubmit} />}
    </SubmissionEcho>
  );
}

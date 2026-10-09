import {
  createFormInputSchema,
  formOutputSchema,
  listFormSubmissionsInputSchema,
  listFormSubmissionsOutputSchema,
  updateFormInputSchema,
} from "@fragno-dev/backoffice-api/v0/forms";
import { z } from "zod";

import { defineCliArgsParser, defineNoInputArgsParser } from "@/fragno/runtime-tools/bash-cli";
import type { FormsRuntime } from "@/fragno/runtime-tools/families/forms-runtime";

import { normalizeRuntimeOutput } from "../output-schemas";
import {
  backofficeApiOperationToolFields,
  defineBackofficeRuntimeTool,
  defineBackofficeRuntimeToolFamily,
  type BackofficeToolContext,
} from "../runtime-tools";

type FormsToolContext = BackofficeToolContext<{ forms?: FormsRuntime }>;

function requireFormsRuntime(runtime: FormsRuntime | undefined): FormsRuntime {
  if (!runtime) {
    throw new Error("Forms runtime is only available in system scope.");
  }
  return runtime;
}

const parseFormsList = defineNoInputArgsParser("forms.list");
const parseFormsSubmissionsList = defineCliArgsParser<
  z.input<typeof listFormSubmissionsInputSchema>
>("forms.submissions.list", {
  formId: { required: true, option: "form-id" },
  sortOrder: { option: "sort-order" },
  pageSize: { option: "page-size" },
  cursor: {},
});

const formDefinitionCliOptions = {
  title: {},
  slug: {},
  description: {},
  status: {},
  dataSchema: { option: "data-schema-json", kind: "json" },
  uiSchema: { option: "ui-schema-json", kind: "json" },
} as const;

const parseFormsCreate = defineCliArgsParser<z.input<typeof createFormInputSchema>>(
  "forms.create",
  {
    title: { required: true },
    slug: { required: true },
    description: {},
    status: {},
    dataSchema: { required: true, option: "data-schema-json", kind: "json" },
    uiSchema: { option: "ui-schema-json", kind: "json" },
  },
);
const parseFormsUpdate = defineCliArgsParser<z.input<typeof updateFormInputSchema>>(
  "forms.update",
  {
    formId: { required: true, option: "form-id" },
    ...formDefinitionCliOptions,
  },
);

const listFormsTool = defineBackofficeRuntimeTool({
  ...backofficeApiOperationToolFields("forms.list"),
  namespace: "forms",
  name: "listForms",
  execute: async (_input, context: FormsToolContext) => {
    const forms = await requireFormsRuntime(context.runtimes.forms).listForms();
    return z.object({ forms: z.array(formOutputSchema) }).parse(
      normalizeRuntimeOutput({
        forms: forms.map((form) => ({
          ...form,
          uiSchema: form.uiSchema ?? null,
        })),
      }),
    );
  },
  adapters: {
    bash: {
      command: "forms.list",
      help: {
        summary: "forms.list lists forms in the global system scope.",
        options: [],
        examples: ["forms.list", "forms.list --format json"],
      },
      parse: parseFormsList,
      format: (data) => ({ data }),
    },
  },
});

const listFormSubmissionsTool = defineBackofficeRuntimeTool({
  ...backofficeApiOperationToolFields("forms.submissions.list"),
  namespace: "forms",
  name: "listSubmissions",
  execute: async (input, context: FormsToolContext) => {
    const page = await requireFormsRuntime(context.runtimes.forms).listSubmissions(input);
    return listFormSubmissionsOutputSchema.parse(normalizeRuntimeOutput(page));
  },
  adapters: {
    bash: {
      command: "forms.submissions.list",
      help: {
        summary: "forms.submissions.list lists responses submitted to a system form.",
        options: [
          { name: "form-id", required: true, valueRequired: true, description: "Form ID" },
          {
            name: "sort-order",
            valueRequired: true,
            description: "Submission order: asc or desc (default: desc)",
          },
          {
            name: "page-size",
            valueRequired: true,
            description: "Responses per page from 1 to 100 (default: 25)",
          },
          {
            name: "cursor",
            valueRequired: true,
            description: "Opaque nextCursor returned by the previous page",
          },
        ],
        examples: [
          "forms.submissions.list --form-id form_123",
          "forms.submissions.list --form-id form_123 --sort-order asc --page-size 50 --format json",
          "forms.submissions.list --form-id form_123 --cursor NEXT_CURSOR --format json",
        ],
      },
      parse: parseFormsSubmissionsList,
      format: (data) => ({ data }),
    },
  },
});

const updateFormTool = defineBackofficeRuntimeTool({
  ...backofficeApiOperationToolFields("forms.update"),
  namespace: "forms",
  name: "updateForm",
  execute: async ({ formId, ...input }, context: FormsToolContext) =>
    await requireFormsRuntime(context.runtimes.forms).updateForm(formId, input),
  adapters: {
    bash: {
      command: "forms.update",
      help: {
        summary: "forms.update changes selected fields on an existing system form.",
        options: [
          { name: "form-id", required: true, valueRequired: true, description: "Form ID" },
          { name: "title", valueRequired: true, description: "New form title" },
          { name: "slug", valueRequired: true, description: "New unique form slug" },
          { name: "description", valueRequired: true, description: "New form description" },
          {
            name: "status",
            valueRequired: true,
            description: "New status: draft, open, or closed",
          },
          {
            name: "data-schema-json",
            valueRequired: true,
            description: "Replacement JSON Schema object used to validate responses",
          },
          {
            name: "ui-schema-json",
            valueRequired: true,
            description: "Replacement JSON Forms UI schema object",
          },
        ],
        examples: [
          "forms.update --form-id form_123 --status open",
          `forms.update --form-id form_123 --data-schema-json '{"type":"object","properties":{"message":{"type":"string"}}}'`,
        ],
      },
      parse: parseFormsUpdate,
      format: (data) => ({ data }),
    },
  },
});

const createFormTool = defineBackofficeRuntimeTool({
  ...backofficeApiOperationToolFields("forms.create"),
  namespace: "forms",
  name: "createForm",
  execute: async (input, context: FormsToolContext) =>
    await requireFormsRuntime(context.runtimes.forms).createForm(input),
  adapters: {
    bash: {
      command: "forms.create",
      help: {
        summary: "forms.create creates a system form from JSON Schema.",
        options: [
          { name: "title", required: true, valueRequired: true, description: "Form title" },
          { name: "slug", required: true, valueRequired: true, description: "Unique form slug" },
          { name: "description", valueRequired: true, description: "Optional form description" },
          {
            name: "status",
            valueRequired: true,
            description: "Initial status: draft, open, or closed (default: draft)",
          },
          {
            name: "data-schema-json",
            required: true,
            valueRequired: true,
            description: "JSON Schema object used to validate responses",
          },
          {
            name: "ui-schema-json",
            valueRequired: true,
            description: "Optional JSON Forms UI schema object",
          },
        ],
        examples: [
          `forms.create --title "Contact" --slug contact --data-schema-json '{"type":"object","properties":{"message":{"type":"string"}}}'`,
        ],
      },
      parse: parseFormsCreate,
      format: (data) => ({ data }),
    },
  },
});

export const formsRuntimeTools = [
  listFormsTool,
  createFormTool,
  updateFormTool,
  listFormSubmissionsTool,
] as const;

export const formsToolFamily = defineBackofficeRuntimeToolFamily({
  namespace: "forms",
  tools: formsRuntimeTools,
  isAvailable: (context: FormsToolContext) => !!context.runtimes.forms,
});

export type { FormsRuntime };

import { z } from "zod";

import type { BackofficeCapability } from "@/fragno/backoffice-capabilities/backoffice-capabilities";

export const FORMS_AUTOMATION_SOURCE = "forms" as const;
export const FORMS_AUTOMATION_EVENT_FORM_CREATED = "form.created" as const;
export const FORMS_AUTOMATION_EVENT_FORM_UPDATED = "form.updated" as const;
export const FORMS_AUTOMATION_EVENT_FORM_DELETED = "form.deleted" as const;
export const FORMS_AUTOMATION_EVENT_RESPONSE_SUBMITTED = "response.submitted" as const;

const formCreatedPayloadSchema = z.object({
  form: z.object({
    id: z.string().trim().min(1),
    title: z.string(),
    description: z.string().nullable().optional(),
    slug: z.string().trim().min(1),
    status: z.enum(["draft", "open", "closed", "static"]),
    dataSchema: z.record(z.string(), z.unknown()),
    uiSchema: z.record(z.string(), z.unknown()).nullable().optional(),
    createdAt: z.iso.datetime(),
  }),
});

const storedFormPayloadSchema = formCreatedPayloadSchema.extend({
  form: formCreatedPayloadSchema.shape.form.extend({
    version: z.number().int().positive(),
    createdAt: z.iso.datetime(),
    updatedAt: z.iso.datetime(),
  }),
});

const responseSubmittedPayloadSchema = z.object({
  response: z.object({
    id: z.string().trim().min(1),
    formId: z.string().trim().min(1),
    formVersion: z.number().int().positive(),
    data: z.record(z.string(), z.unknown()),
    submittedAt: z.iso.datetime(),
    ip: z.string().nullable(),
    userAgent: z.string().nullable(),
  }),
});

const formSubjectSchema = z.object({ formId: z.string().trim().min(1) });
const responseSubjectSchema = formSubjectSchema.extend({
  responseId: z.string().trim().min(1),
});

export const formsCapability: BackofficeCapability = {
  id: "forms",
  label: "Forms",
  objectBinding: "FORMS",
  contributions: {
    connection: null,
    eventSources: [
      {
        source: FORMS_AUTOMATION_SOURCE,
        label: "Forms",
        description: "System form lifecycle and response submission events.",
      },
    ],
    actionProviders: ["forms"],
    hookScopes: [
      {
        id: "forms",
        label: "Forms",
        getRepository: ({ objects }) => objects.forms.singleton().getDurableHookRepository(),
      },
    ],
    skillPaths: ["skills/forms/SKILL.md"],
    externalEntities: [],
    automationEvents: [
      {
        source: FORMS_AUTOMATION_SOURCE,
        eventType: FORMS_AUTOMATION_EVENT_FORM_CREATED,
        label: "Form created",
        description: "Fires after a system form is created.",
        payloadSchema: formCreatedPayloadSchema,
        subjectSchema: formSubjectSchema,
        example: {
          form: {
            id: "form_123",
            title: "Contact form",
            description: null,
            slug: "contact",
            status: "draft",
            dataSchema: { type: "object", properties: {} },
            createdAt: "2026-01-01T00:00:00.000Z",
          },
        },
      },
      {
        source: FORMS_AUTOMATION_SOURCE,
        eventType: FORMS_AUTOMATION_EVENT_FORM_UPDATED,
        label: "Form updated",
        description: "Fires after a system form is updated.",
        payloadSchema: storedFormPayloadSchema,
        subjectSchema: formSubjectSchema,
        example: {
          form: {
            id: "form_123",
            title: "Contact form",
            description: "Updated contact form",
            slug: "contact",
            status: "open",
            dataSchema: { type: "object", properties: {} },
            version: 2,
            createdAt: "2026-01-01T00:00:00.000Z",
            updatedAt: "2026-01-02T00:00:00.000Z",
          },
        },
      },
      {
        source: FORMS_AUTOMATION_SOURCE,
        eventType: FORMS_AUTOMATION_EVENT_FORM_DELETED,
        label: "Form deleted",
        description: "Fires after a system form is deleted.",
        payloadSchema: storedFormPayloadSchema,
        subjectSchema: formSubjectSchema,
        example: {
          form: {
            id: "form_123",
            title: "Contact form",
            description: null,
            slug: "contact",
            status: "closed",
            dataSchema: { type: "object", properties: {} },
            version: 2,
            createdAt: "2026-01-01T00:00:00.000Z",
            updatedAt: "2026-01-02T00:00:00.000Z",
          },
        },
      },
      {
        source: FORMS_AUTOMATION_SOURCE,
        eventType: FORMS_AUTOMATION_EVENT_RESPONSE_SUBMITTED,
        label: "Form response submitted",
        description: "Fires after a response is stored for a system form.",
        payloadSchema: responseSubmittedPayloadSchema,
        subjectSchema: responseSubjectSchema,
        example: {
          response: {
            id: "response_123",
            formId: "form_123",
            formVersion: 1,
            data: { message: "Hello" },
            submittedAt: "2026-01-01T00:00:00.000Z",
            ip: null,
            userAgent: null,
          },
        },
      },
    ],
  },
};

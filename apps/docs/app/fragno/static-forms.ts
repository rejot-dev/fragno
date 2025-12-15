import type { StaticForm } from "@fragno-dev/forms";
import { RuleEffect } from "@jsonforms/core";

export const SURVEY_FORM_ID = "static_form_survey";
export const SURVEY_FORM_SLUG = "form-survey";

export const surveyForm: StaticForm = {
  id: SURVEY_FORM_ID,
  slug: SURVEY_FORM_SLUG,
  title: "A Form about Forms",
  description: "Tell us about your form needs. (REAL FORM, NOT A DEMO!)",
  dataSchema: {
    type: "object",
    properties: {
      // Question 1: Multi-select features
      featureVisualBuilder: { type: "boolean", title: "Visual Form Builder" },
      featureReports: { type: "boolean", title: "Aggregated Reports" },
      featureCustomFields: { type: "boolean", title: "Custom form fields" },
      featureFileUploads: { type: "boolean", title: "File Uploads" },
      featureAIForms: { type: "boolean", title: "Create forms with AI" },
      featureOther: { type: "boolean", title: "Other" },
      featureOtherDescription: { type: "string", title: "Please describe", maxLength: 500 },

      // Question 2: Hosting preference
      hostingPreference: {
        type: "string",
        title: "What is your preferred hosting method?",
        oneOf: [
          { const: "integrated", title: "Integrated in my application" },
          { const: "self-hosted-app", title: "Self-host as a separate application" },
          { const: "managed", title: "Hosted for me" },
          { const: "whatever", title: "Don't care" },
        ],
      },

      // Question 3: Email updates
      email: {
        type: "string",
        format: "email",
        title: "Stay updated",
        description:
          "We'll message you only about forms and won't share your email address with others.",
      },
    },
    required: ["hostingPreference"],
  },
  uiSchema: {
    type: "VerticalLayout",
    elements: [
      {
        type: "Group",
        label: "What features would you like to see?",
        elements: [
          {
            type: "HorizontalLayout",
            elements: [
              { type: "Control", scope: "#/properties/featureVisualBuilder" },
              { type: "Control", scope: "#/properties/featureReports" },
              { type: "Control", scope: "#/properties/featureCustomFields" },
            ],
          },
          {
            type: "HorizontalLayout",
            elements: [
              { type: "Control", scope: "#/properties/featureFileUploads" },
              { type: "Control", scope: "#/properties/featureAIForms" },
              { type: "Control", scope: "#/properties/featureOther" },
            ],
          },
          {
            type: "Control",
            scope: "#/properties/featureOtherDescription",
            options: { multi: true },
            rule: {
              effect: RuleEffect.SHOW,
              condition: {
                scope: "#/properties/featureOther",
                schema: { const: true },
              },
            },
          },
        ],
      },
      {
        type: "Control",
        scope: "#/properties/hostingPreference",
        options: { format: "radio" },
      },
      {
        type: "Group",
        elements: [
          {
            type: "Control",
            scope: "#/properties/email",
            options: { placeholder: "you@example.com" },
          },
        ],
      },
    ],
  },
  version: 1,
};

export const STATIC_FORMS: StaticForm[] = [surveyForm];

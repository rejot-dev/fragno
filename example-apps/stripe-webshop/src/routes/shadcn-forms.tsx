import { createFileRoute } from "@tanstack/react-router";
import { JsonForms } from "@jsonforms/react";
import { useState } from "react";
import { RuleEffect, type JsonSchema, type UISchemaElement } from "@jsonforms/core";
import { shadcnRenderers, shadcnCells } from "@fragno-dev/jsonforms-shadcn-renderers";

export const Route = createFileRoute("/shadcn-forms")({
  component: ShadcnFormPage,
});

const dataSchema: JsonSchema = {
  type: "object",
  properties: {
    name: {
      type: "string",
      title: "Full Name",
      description: "Your legal full name",
      maxLength: 150,
    },
    bio: {
      type: "string",
      title: "Biography",
      description: "you",
    },
    birthDate: {
      type: "string",
      format: "date",
      title: "Date of Birth",
      description: "Used to verify your age",
    },
    preferredTime: {
      type: "string",
      format: "time",
      title: "Preferred Contact Time",
      description: "When should we contact you?",
    },
    appointmentDateTime: {
      type: "string",
      format: "date-time",
      title: "Schedule Appointment",
      description: "Select a date and time for your appointment",
    },
    newsletter: {
      type: "boolean",
      title: "Subscribe to newsletter",
      description: "Receive weekly updates about our products",
    },
    darkMode: {
      type: "boolean",
      title: "Dark mode",
      description: "Enable dark mode for the application",
    },
    age: {
      type: "integer",
      title: "Age",
      description: "Your age in years",
      minimum: 0,
      maximum: 150,
    },
    status: {
      type: "string",
      enum: ["pending", "active", "completed", "cancelled"],
      title: "Status",
      description: "Select the current status",
    },
    priority: {
      type: "string",
      enum: ["low", "medium", "high"],
      title: "Priority",
      description: "Select priority level (radio buttons)",
    },
    country: {
      oneOf: [
        { const: "us", title: "United States" },
        { const: "uk", title: "United Kingdom" },
        { const: "de", title: "Germany" },
        { const: "fr", title: "France" },
      ],
      title: "Country",
      description: "Select your country (oneOf enum)",
    },
    showDetails: {
      type: "boolean",
      title: "Show additional details",
      description: "Toggle to reveal more fields",
    },
    additionalDetails: {
      type: "string",
      title: "Additional Details",
      description: "This field appears when the toggle is on",
    },
    satisfaction: {
      type: "integer",
      title: "Satisfaction",
      description: "How satisfied are you? (Slider control)",
      minimum: 0,
      maximum: 10,
      default: 5,
    },
  },
};

const uiSchema: UISchemaElement = {
  type: "VerticalLayout",
  elements: [
    {
      type: "Group",
      label: "Personal Information",
      elements: [
        {
          type: "Control",
          scope: "#/properties/name",
        },
        {
          type: "HorizontalLayout",
          elements: [
            {
              type: "Control",
              scope: "#/properties/birthDate",
            },
            {
              type: "Control",
              scope: "#/properties/age",
            },
          ],
        },
        {
          type: "Control",
          scope: "#/properties/bio",
          options: {
            multi: true,
          },
        },
      ],
    },
    {
      type: "Group",
      label: "Scheduling",
      elements: [
        {
          type: "VerticalLayout",
          elements: [
            {
              type: "Control",
              scope: "#/properties/preferredTime",
            },
            {
              type: "Control",
              scope: "#/properties/appointmentDateTime",
            },
          ],
        },
      ],
    },
    {
      type: "Group",
      label: "Preferences",
      elements: [
        {
          type: "HorizontalLayout",
          elements: [
            {
              type: "Control",
              scope: "#/properties/newsletter",
            },
            {
              type: "Control",
              scope: "#/properties/darkMode",
              options: {
                toggle: true,
              },
            },
          ],
        },
        {
          type: "HorizontalLayout",
          elements: [
            {
              type: "Control",
              scope: "#/properties/status",
            },
            {
              type: "Control",
              scope: "#/properties/priority",
              options: {
                format: "radio",
              },
            },
          ],
        },
        {
          type: "Control",
          scope: "#/properties/country",
        },
        {
          type: "Control",
          scope: "#/properties/satisfaction",
          options: {
            slider: true,
          },
        },
      ],
    },
    {
      type: "Group",
      label: "Rules",
      elements: [
        {
          type: "Control",
          scope: "#/properties/showDetails",
          options: {
            toggle: true,
          },
        },
        {
          type: "Control",
          scope: "#/properties/additionalDetails",
          options: {
            multi: true,
          },
          rule: {
            effect: RuleEffect.SHOW,
            condition: {
              scope: "#/properties/showDetails",
              schema: { const: true },
            },
          },
        },
      ],
    },
  ],
};

// Multi-step form schema
const multiStepSchema: JsonSchema = {
  type: "object",
  properties: {
    fullName: {
      type: "string",
      title: "Full Name",
    },
    email: {
      type: "string",
      title: "Email Address",
    },
    address: {
      type: "string",
      title: "Shipping Address",
    },
    shippingMethod: {
      type: "string",
      enum: ["standard", "express", "overnight"],
      title: "Shipping Method",
    },
    cardNumber: {
      type: "string",
      title: "Card Number",
    },
    savePaymentInfo: {
      type: "boolean",
      title: "Save payment info",
    },
  },
};

// Tabs variant (default) - no options needed
const tabsUiSchema: UISchemaElement = {
  type: "Categorization",
  elements: [
    {
      type: "Category",
      label: "Personal Info",
      elements: [
        { type: "Control", scope: "#/properties/fullName" },
        { type: "Control", scope: "#/properties/email" },
      ],
    },
    {
      type: "Category",
      label: "Shipping",
      elements: [
        { type: "Control", scope: "#/properties/address" },
        {
          type: "Control",
          scope: "#/properties/shippingMethod",
          options: { format: "radio" },
        },
      ],
    },
    {
      type: "Category",
      label: "Payment",
      elements: [
        { type: "Control", scope: "#/properties/cardNumber" },
        {
          type: "Control",
          scope: "#/properties/savePaymentInfo",
          options: { toggle: true },
        },
      ],
    },
  ],
};

const stepperUiSchema: UISchemaElement = {
  ...tabsUiSchema,
  options: { variant: "stepper" },
};

// Notification Settings Example (replicating shadcn FieldGroup example)
const notificationSchema: JsonSchema = {
  type: "object",
  properties: {
    responsesPush: {
      type: "boolean",
      title: "Push notifications",
    },
    tasksPush: {
      type: "boolean",
      title: "Push notifications",
    },
    tasksEmail: {
      type: "boolean",
      title: "Email notifications",
    },
  },
};

const notificationUiSchema: UISchemaElement = {
  type: "VerticalLayout",
  elements: [
    {
      type: "Group",
      label: "Responses",
      options: {
        description:
          "Get notified when ChatGPT responds to requests that take time, like research or image generation.",
      },
      elements: [{ type: "Control", scope: "#/properties/responsesPush" }],
    },
    {
      type: "Group",
      label: "Tasks",
      options: {
        description: "Get notified when tasks you've created have updates.",
      },
      elements: [
        { type: "Control", scope: "#/properties/tasksPush" },
        { type: "Control", scope: "#/properties/tasksEmail" },
      ],
    },
  ],
};

function ShadcnFormPage() {
  const [data, setData] = useState({});
  const [tabsData, setTabsData] = useState({});
  const [stepperData, setStepperData] = useState({});
  const [notificationData, setNotificationData] = useState({ responsesPush: true });

  return (
    <div className="flex min-h-svh w-full flex-col items-center gap-6 p-6 md:p-10">
      <div className="w-full max-w-xl space-y-6">
        <h1 className="text-2xl font-bold">Shadcn JSON Forms Test Page</h1>
        <p className="text-muted-foreground">Testing shadcn/ui components with JSON Forms.</p>

        <div className="rounded-lg border p-6">
          <JsonForms
            schema={dataSchema}
            uischema={uiSchema}
            data={data}
            renderers={shadcnRenderers}
            cells={shadcnCells}
            onChange={({ data }) => setData(data)}
          />
        </div>

        <div className="bg-muted/50 rounded-lg border p-4">
          <h2 className="mb-2 font-semibold">Current Data:</h2>
          <pre className="overflow-auto text-sm">{JSON.stringify(data, null, 2)}</pre>
        </div>

        {/* Tabs Example */}
        <div className="border-t pt-8">
          <h2 className="text-xl font-bold">Tabs</h2>
          <p className="text-muted-foreground mb-4">Categorization layout rendered as tabs.</p>

          <JsonForms
            schema={multiStepSchema}
            uischema={tabsUiSchema}
            data={tabsData}
            renderers={shadcnRenderers}
            cells={shadcnCells}
            onChange={({ data }) => setTabsData(data)}
          />
        </div>

        {/* Stepper Categorization Example */}
        <div className="border-t pt-8">
          <h2 className="text-xl font-bold">Stepper</h2>
          <p className="text-muted-foreground mb-4">
            Categorization layout rendered as multi-step.
          </p>
          <JsonForms
            schema={multiStepSchema}
            uischema={stepperUiSchema}
            data={stepperData}
            renderers={shadcnRenderers}
            cells={shadcnCells}
            onChange={({ data }) => setStepperData(data)}
          />
        </div>

        {/* Notification Settings Example */}
        <div className="border-t pt-8">
          <h2 className="text-xl font-bold">Notification Settings</h2>
          <p className="text-muted-foreground mb-4">
            Groups with descriptions and checkbox fields.
          </p>
          <JsonForms
            schema={notificationSchema}
            uischema={notificationUiSchema}
            data={notificationData}
            renderers={shadcnRenderers}
            cells={shadcnCells}
            onChange={({ data }) => setNotificationData(data)}
          />
        </div>
      </div>
    </div>
  );
}

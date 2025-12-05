import { config } from "dotenv";
import { formsFragment } from "@/lib/forms";

// Load environment variables
config({ quiet: true });

const basicFormSchema = {
  type: "object",
  properties: {
    name: {
      type: "string",
      minLength: 3,
      description: "Please enter your name",
    },
    vegetarian: {
      type: "boolean",
    },
    birthDate: {
      type: "string",
      format: "date",
    },
    nationality: {
      type: "string",
      enum: ["DE", "IT", "JP", "US", "RU", "Other"],
    },
    personalData: {
      type: "object",
      properties: {
        age: {
          type: "integer",
          description: "Please enter your age.",
        },
        height: {
          type: "number",
        },
        drivingSkill: {
          type: "number",
          maximum: 10,
          minimum: 1,
          default: 7,
        },
      },
      required: ["age", "height"],
    },
    occupation: {
      type: "string",
    },
    postalCode: {
      type: "string",
      maxLength: 5,
    },
  },
  required: ["occupation", "nationality"],
};

const basicFormUiSchema = {
  type: "VerticalLayout",
  elements: [
    {
      type: "HorizontalLayout",
      elements: [
        { type: "Control", scope: "#/properties/name" },
        { type: "Control", scope: "#/properties/personalData/properties/age" },
        { type: "Control", scope: "#/properties/birthDate" },
      ],
    },
    {
      type: "Label",
      text: "Additional Information",
    },
    {
      type: "HorizontalLayout",
      elements: [
        { type: "Control", scope: "#/properties/personalData/properties/height" },
        { type: "Control", scope: "#/properties/nationality" },
        {
          type: "Control",
          scope: "#/properties/occupation",
          options: {
            suggestion: [
              "Accountant",
              "Engineer",
              "Freelancer",
              "Journalism",
              "Physician",
              "Student",
              "Teacher",
              "Other",
            ],
          },
        },
      ],
    },
  ],
};

async function seed() {
  console.log("Seeding forms...");

  const existingForms = await formsFragment.services.listForms();
  const existingBasicForm = existingForms.find((f) => f.slug === "basic-example");

  if (existingBasicForm) {
    console.log("✓ Basic example form was already created");
    return;
  }

  const formId = await formsFragment.services.createForm({
    title: "Basic Example Form",
    description: "A basic example form from jsonforms.io demonstrating various input types",
    slug: "basic-example",
    dataSchema: basicFormSchema,
    uiSchema: basicFormUiSchema,
    status: "open",
  });

  if (formId) {
    console.log("✓ Basic example form seeded successfully!", formId);
  } else {
    throw new Error("Failed to create basic example form");
  }
}

await seed();

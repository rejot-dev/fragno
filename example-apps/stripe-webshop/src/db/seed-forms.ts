import { config } from "dotenv";
import { formsFragment } from "@/lib/forms";

// Load environment variables
config({ quiet: true });

const basicFormSchema = {
  type: "object",
  properties: {
    firstName: {
      type: "string",
      minLength: 3,
      description: "Please enter your first name",
    },
    secondName: {
      type: "string",
      minLength: 3,
      description: "Please enter your second name",
    },
    vegetarian: {
      type: "boolean",
    },
    birthDate: {
      type: "string",
      format: "date",
      description: "Please enter your birth date.",
    },
    nationality: {
      type: "string",
      enum: ["DE", "IT", "JP", "US", "RU", "Other"],
    },
    provideAddress: {
      type: "boolean",
    },
    address: {
      type: "object",
      properties: {
        street: {
          type: "string",
        },
        streetNumber: {
          type: "string",
        },
        city: {
          type: "string",
        },
        postalCode: {
          type: "string",
          maxLength: 5,
        },
      },
    },
    vegetarianOptions: {
      type: "object",
      properties: {
        vegan: {
          type: "boolean",
        },
        favoriteVegetable: {
          type: "string",
          enum: ["Tomato", "Potato", "Salad", "Aubergine", "Cucumber", "Other"],
        },
        otherFavoriteVegetable: {
          type: "string",
        },
      },
    },
  },
};

const basicFormUiSchema = {
  type: "Categorization",
  elements: [
    {
      type: "Category",
      label: "First Category",
      elements: [
        {
          type: "HorizontalLayout",
          elements: [
            {
              type: "Control",
              scope: "#/properties/firstName",
            },
            {
              type: "Control",
              scope: "#/properties/secondName",
            },
          ],
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
              scope: "#/properties/nationality",
            },
          ],
        },
        {
          type: "Control",
          scope: "#/properties/provideAddress",
        },
        {
          type: "Control",
          scope: "#/properties/vegetarian",
        },
      ],
    },
    {
      type: "Category",
      i18n: "address",
      elements: [
        {
          type: "HorizontalLayout",
          elements: [
            {
              type: "Control",
              scope: "#/properties/address/properties/street",
            },
            {
              type: "Control",
              scope: "#/properties/address/properties/streetNumber",
            },
          ],
        },
        {
          type: "HorizontalLayout",
          elements: [
            {
              type: "Control",
              scope: "#/properties/address/properties/city",
            },
            {
              type: "Control",
              scope: "#/properties/address/properties/postalCode",
            },
          ],
        },
      ],
      rule: {
        effect: "SHOW",
        condition: {
          scope: "#/properties/provideAddress",
          schema: {
            const: true,
          },
        },
      },
    },
    {
      type: "Category",
      label: "Additional",
      elements: [
        {
          type: "Control",
          scope: "#/properties/vegetarianOptions/properties/vegan",
        },
        {
          type: "Control",
          scope: "#/properties/vegetarianOptions/properties/favoriteVegetable",
        },
        {
          type: "Control",
          scope: "#/properties/vegetarianOptions/properties/otherFavoriteVegetable",
          rule: {
            effect: "SHOW",
            condition: {
              scope: "#/properties/vegetarianOptions/properties/favoriteVegetable",
              schema: {
                const: "Other",
              },
            },
          },
        },
      ],
      rule: {
        effect: "SHOW",
        condition: {
          scope: "#/properties/vegetarian",
          schema: {
            const: true,
          },
        },
      },
    },
  ],
  options: {
    variant: "stepper",
    showNavButtons: true,
  },
};

async function seed() {
  console.log("Seeding forms...");

  const formData = {
    title: "Example Form",
    description: "An example form, dynamically loaded from the database.",
    slug: "basic-example",
    dataSchema: basicFormSchema,
    uiSchema: basicFormUiSchema,
    status: "open" as const,
  };

  const existingForms = await formsFragment.services.listForms();
  console.log("Existing forms:", existingForms);
  const existingBasicForm = existingForms.find((f) => f.slug === "basic-example");

  if (existingBasicForm) {
    const { success } = await formsFragment.services.updateForm(existingBasicForm.id, formData);
    if (success) {
      console.log("✓ Basic example form updated successfully!", existingBasicForm.id);
    } else {
      throw new Error("Failed to update basic example form");
    }
    return;
  }

  const formId = await formsFragment.services.createForm(formData);

  if (formId) {
    console.log("✓ Basic example form seeded successfully!", formId);
  } else {
    throw new Error("Failed to create basic example form");
  }
}

await seed();

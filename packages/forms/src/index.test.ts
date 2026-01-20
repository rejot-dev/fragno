import { describe, test, expect, afterAll, assert } from "vitest";
import { buildDatabaseFragmentsTest } from "@fragno-dev/test";
import { instantiate } from "@fragno-dev/core";
import { formsFragmentDef, routes } from "./index";

// Example JSON Schema from jsonforms.io - Person form
const personDataSchema = {
  type: "object",
  properties: {
    name: {
      type: "string",
      minLength: 1,
    },
    email: {
      type: "string",
      format: "email",
    },
    age: {
      type: "integer",
      minimum: 0,
    },
    bio: {
      type: "string",
    },
  },
  required: ["name", "email"],
};

const personUiSchema = {
  type: "VerticalLayout",
  elements: [
    {
      type: "Control",
      scope: "#/properties/name",
    },
    {
      type: "Control",
      scope: "#/properties/email",
    },
    {
      type: "Control",
      scope: "#/properties/age",
    },
    {
      type: "Control",
      scope: "#/properties/bio",
      options: {
        multi: true,
      },
    },
  ],
};

// Example JSON Schema - Address form with nested object
const addressDataSchema = {
  type: "object",
  properties: {
    street: { type: "string" },
    city: { type: "string" },
    state: { type: "string" },
    zip: { type: "string", pattern: "^[0-9]{5}$" },
    country: {
      type: "string",
      enum: ["US", "CA", "MX"],
    },
  },
  required: ["street", "city", "country"],
};

const addressUiSchema = {
  type: "VerticalLayout",
  elements: [
    { type: "Control", scope: "#/properties/street" },
    {
      type: "HorizontalLayout",
      elements: [
        { type: "Control", scope: "#/properties/city" },
        { type: "Control", scope: "#/properties/state" },
        { type: "Control", scope: "#/properties/zip" },
      ],
    },
    { type: "Control", scope: "#/properties/country" },
  ],
};

// Example JSON Schema - Survey with categorization
const surveyDataSchema = {
  type: "object",
  properties: {
    satisfaction: {
      type: "integer",
      minimum: 1,
      maximum: 5,
    },
    recommend: {
      type: "boolean",
    },
    feedback: {
      type: "string",
    },
    contactMe: {
      type: "boolean",
    },
    contactEmail: {
      type: "string",
      format: "email",
    },
  },
};

const surveyUiSchema = {
  type: "Categorization",
  elements: [
    {
      type: "Category",
      label: "Rating",
      elements: [
        { type: "Control", scope: "#/properties/satisfaction" },
        { type: "Control", scope: "#/properties/recommend" },
      ],
    },
    {
      type: "Category",
      label: "Feedback",
      elements: [
        { type: "Control", scope: "#/properties/feedback", options: { multi: true } },
        { type: "Control", scope: "#/properties/contactMe" },
        {
          type: "Control",
          scope: "#/properties/contactEmail",
          rule: {
            effect: "SHOW",
            condition: {
              scope: "#/properties/contactMe",
              schema: { const: true },
            },
          },
        },
      ],
    },
  ],
};

describe("Forms Fragment", () => {
  describe("Form CRUD Operations", async () => {
    const { fragments, test: testCtx } = await buildDatabaseFragmentsTest()
      .withTestAdapter({ type: "kysely-sqlite" })
      .withFragment("forms", instantiate(formsFragmentDef).withConfig({}).withRoutes(routes))
      .build();

    const formsFragment = fragments.forms;

    afterAll(async () => {
      await testCtx.cleanup();
    });

    test("should create a form with person schema", async () => {
      const response = await formsFragment.callRoute("POST", "/admin/forms", {
        body: {
          title: "Contact Form",
          slug: "contact-form",
          description: "A simple contact form",
          status: "draft",
          dataSchema: personDataSchema,
          uiSchema: personUiSchema,
        },
      });

      assert(response.type === "json");
      expect(response.status).toBe(200);
      // Response is now just the ID string
      expect(response.data).toEqual(expect.any(String));
    });

    test("should create a form with address schema", async () => {
      const response = await formsFragment.callRoute("POST", "/admin/forms", {
        body: {
          title: "Shipping Address",
          slug: "shipping-address",
          description: null,
          status: "draft",
          dataSchema: addressDataSchema,
          uiSchema: addressUiSchema,
        },
      });

      assert(response.type === "json");
      expect(response.status).toBe(200);
      // Response is now just the ID string
      expect(response.data).toEqual(expect.any(String));
    });

    test("should list all forms", async () => {
      const response = await formsFragment.callRoute("GET", "/admin/forms");

      assert(response.type === "json");
      expect(response.status).toBe(200);
      expect(response.data).toHaveLength(2);
      expect(response.data.map((f: { title: string }) => f.title)).toContain("Contact Form");
      expect(response.data.map((f: { title: string }) => f.title)).toContain("Shipping Address");
    });

    test("should get a single form by slug", async () => {
      // First create a form
      const createResponse = await formsFragment.callRoute("POST", "/admin/forms", {
        body: {
          title: "Survey Form",
          slug: "survey",
          description: null,
          status: "draft",
          dataSchema: surveyDataSchema,
          uiSchema: surveyUiSchema,
        },
      });
      assert(createResponse.type === "json");

      // Then get it (public route uses slug)
      const response = await formsFragment.callRoute("GET", "/:slug", {
        pathParams: { slug: "survey" },
      });

      assert(response.type === "json");
      expect(response.status).toBe(200);
      expect(response.data.title).toBe("Survey Form");
      expect(response.data.dataSchema).toEqual(surveyDataSchema);
    });

    test("should update a form", async () => {
      // Create a form
      const createResponse = await formsFragment.callRoute("POST", "/admin/forms", {
        body: {
          title: "Test Form",
          slug: "test-form",
          description: null,
          status: "draft",
          dataSchema: { type: "object", properties: {} },
          uiSchema: { type: "VerticalLayout", elements: [] },
        },
      });
      assert(createResponse.type === "json");
      // Response is now just the ID string
      const formId = createResponse.data;

      // Update it via direct db (UnitOfWork with .check() doesn't work in test adapter)
      const form = await formsFragment.db.findFirst("form", (b) =>
        b.whereIndex("primary", (eb) => eb("id", "=", formId)),
      );
      assert(form);

      await formsFragment.db.update("form", form.id, (b) =>
        b.set({
          title: "Updated Test Form",
          description: "Now with a description",
          version: form.version + 1,
          updatedAt: new Date(),
        }),
      );

      // Verify update via GET (public route uses slug)
      const getResponse = await formsFragment.callRoute("GET", "/:slug", {
        pathParams: { slug: "test-form" },
      });

      assert(getResponse.type === "json");
      expect(getResponse.status).toBe(200);
      expect(getResponse.data.title).toBe("Updated Test Form");
      expect(getResponse.data.description).toBe("Now with a description");
      expect(getResponse.data.version).toBe(2);
    });

    test("should delete a form", async () => {
      // Create a form
      const createResponse = await formsFragment.callRoute("POST", "/admin/forms", {
        body: {
          title: "To Delete",
          slug: "to-delete",
          description: null,
          status: "draft",
          dataSchema: { type: "object" },
          uiSchema: { type: "VerticalLayout", elements: [] },
        },
      });
      assert(createResponse.type === "json");
      // Response is now just the ID string
      const formId = createResponse.data;

      // Delete it
      const deleteResponse = await formsFragment.callRoute("DELETE", "/admin/forms/:id", {
        pathParams: { id: formId },
      });

      assert(deleteResponse.type === "json");
      expect(deleteResponse.status).toBe(200);
      // Response is now just boolean
      expect(deleteResponse.data).toBe(true);

      // Verify it's gone (public route uses slug)
      const getResponse = await formsFragment.callRoute("GET", "/:slug", {
        pathParams: { slug: "to-delete" },
      });

      assert(getResponse.type === "error");
      expect(getResponse.status).toBe(404);
    });

    test("should return 404 for non-existent form", async () => {
      const response = await formsFragment.callRoute("GET", "/:slug", {
        pathParams: { slug: "non-existent-slug" },
      });

      assert(response.type === "error");
      expect(response.status).toBe(404);
      expect(response.error.code).toBe("NOT_FOUND");
    });

    test("should reject form creation with invalid JSON Schema", async () => {
      const response = await formsFragment.callRoute("POST", "/admin/forms", {
        body: {
          title: "Invalid Schema Form",
          slug: "invalid-schema-form",
          description: null,
          status: "draft",
          dataSchema: {
            type: "invalid-type-that-does-not-exist",
          },
          uiSchema: { type: "VerticalLayout", elements: [] },
        },
      });

      assert(response.type === "error");
      expect(response.status).toBe(400);
      expect(response.error.code).toBe("INVALID_JSON_SCHEMA");
    });

    test("should reject form update with invalid JSON Schema", async () => {
      // First create a valid form
      const createResponse = await formsFragment.callRoute("POST", "/admin/forms", {
        body: {
          title: "Valid Form",
          slug: "valid-form-for-update",
          description: null,
          status: "draft",
          dataSchema: { type: "object", properties: {} },
          uiSchema: { type: "VerticalLayout", elements: [] },
        },
      });
      assert(createResponse.type === "json");
      const formId = createResponse.data;

      // Try to update with invalid schema
      const updateResponse = await formsFragment.callRoute("PUT", "/admin/forms/:id", {
        pathParams: { id: formId },
        body: {
          dataSchema: {
            type: "not-a-valid-json-schema-type",
          },
        },
      });

      assert(updateResponse.type === "error");
      expect(updateResponse.status).toBe(400);
      expect(updateResponse.error.code).toBe("INVALID_JSON_SCHEMA");
    });
  });

  describe("Form Submission", async () => {
    const { fragments, test: testCtx } = await buildDatabaseFragmentsTest()
      .withTestAdapter({ type: "kysely-sqlite" })
      .withFragment("forms", instantiate(formsFragmentDef).withConfig({}).withRoutes(routes))
      .build();

    const formsFragment = fragments.forms;
    let publishedFormId: string;

    afterAll(async () => {
      await testCtx.cleanup();
    });

    test("should not allow submission to draft form", async () => {
      // Create a draft form
      const createResponse = await formsFragment.callRoute("POST", "/admin/forms", {
        body: {
          title: "Draft Form",
          slug: "draft-form",
          description: null,
          status: "draft",
          dataSchema: personDataSchema,
          uiSchema: personUiSchema,
        },
      });
      assert(createResponse.type === "json");
      // Try to submit
      const submitResponse = await formsFragment.callRoute("POST", "/:slug/submit", {
        pathParams: { slug: "draft-form" },
        body: {
          data: { name: "John", email: "john@example.com" },
        },
      });

      assert(submitResponse.type === "error");
      expect(submitResponse.status).toBe(400);
      expect(submitResponse.error.code).toBe("FORM_NOT_OPEN");
    });

    test("should allow submission to published form", async () => {
      // Create and publish a form
      const createResponse = await formsFragment.callRoute("POST", "/admin/forms", {
        body: {
          title: "Published Form",
          slug: "published-form",
          description: null,
          status: "draft",
          dataSchema: personDataSchema,
          uiSchema: personUiSchema,
        },
      });
      assert(createResponse.type === "json");
      // Response is now just the ID string
      const formId = createResponse.data;

      // Publish it by updating status
      await formsFragment.db.update(
        "form",
        (await formsFragment.db.findFirst("form", (b) =>
          b.whereIndex("primary", (eb) => eb("id", "=", formId)),
        ))!.id,
        (b) => b.set({ status: "open" }),
      );

      publishedFormId = formId;

      // Submit (public route uses slug)
      const submitResponse = await formsFragment.callRoute("POST", "/:slug/submit", {
        pathParams: { slug: "published-form" },
        body: {
          data: {
            name: "Jane Doe",
            email: "jane@example.com",
            age: 30,
            bio: "Software developer",
          },
        },
      });

      assert(submitResponse.type === "json");
      expect(submitResponse.status).toBe(200);
      // Response is now just the response ID string
      expect(submitResponse.data).toEqual(expect.any(String));
    });

    test("should submit address form data", async () => {
      // Create and publish address form
      const createResponse = await formsFragment.callRoute("POST", "/admin/forms", {
        body: {
          title: "Address Collection",
          slug: "address-collection",
          description: null,
          status: "draft",
          dataSchema: addressDataSchema,
          uiSchema: addressUiSchema,
        },
      });
      assert(createResponse.type === "json");
      // Response is now just the ID string
      const formId = createResponse.data;

      // Publish it
      await formsFragment.db.update(
        "form",
        (await formsFragment.db.findFirst("form", (b) =>
          b.whereIndex("primary", (eb) => eb("id", "=", formId)),
        ))!.id,
        (b) => b.set({ status: "open" }),
      );

      // Submit (public route uses slug)
      const submitResponse = await formsFragment.callRoute("POST", "/:slug/submit", {
        pathParams: { slug: "address-collection" },
        body: {
          data: {
            street: "123 Main St",
            city: "Anytown",
            state: "CA",
            zip: "12345",
            country: "US",
          },
        },
      });

      assert(submitResponse.type === "json");
      expect(submitResponse.status).toBe(200);
      // Response is now just the response ID string
      expect(submitResponse.data).toEqual(expect.any(String));
    });

    test("should list submissions for a form", async () => {
      // Submit another response to the published form (public route uses slug)
      await formsFragment.callRoute("POST", "/:slug/submit", {
        pathParams: { slug: "published-form" },
        body: {
          data: { name: "Bob Smith", email: "bob@example.com" },
        },
      });

      // List submissions
      const response = await formsFragment.callRoute("GET", "/admin/forms/:id/submissions", {
        pathParams: { id: publishedFormId },
      });

      assert(response.type === "json");
      expect(response.status).toBe(200);
      expect(response.data.length).toBeGreaterThanOrEqual(2);
    });

    test("should get a single submission by ID", async () => {
      // First create a submission
      const form = await formsFragment.db.findFirst("form", (b) =>
        b.whereIndex("primary", (eb) => eb("id", "=", publishedFormId)),
      );
      assert(form);

      const submissionId = await formsFragment.db.create("response", {
        formId: form.id.externalId,
        formVersion: form.version,
        data: { name: "Test User", email: "test@test.com" },
      });

      // Get it
      const response = await formsFragment.callRoute("GET", "/admin/submissions/:id", {
        pathParams: { id: submissionId.valueOf() },
      });

      assert(response.type === "json");
      expect(response.status).toBe(200);
      expect(response.data.data).toEqual({ name: "Test User", email: "test@test.com" });
    });

    test("should delete a submission", async () => {
      // Create a submission
      const form = await formsFragment.db.findFirst("form", (b) =>
        b.whereIndex("primary", (eb) => eb("id", "=", publishedFormId)),
      );
      assert(form);

      const submissionId = await formsFragment.db.create("response", {
        formId: form.id.externalId,
        formVersion: form.version,
        data: { name: "To Delete", email: "delete@test.com" },
      });

      // Delete it
      const deleteResponse = await formsFragment.callRoute("DELETE", "/admin/submissions/:id", {
        pathParams: { id: submissionId.valueOf() },
      });

      assert(deleteResponse.type === "json");
      expect(deleteResponse.status).toBe(200);
      // Response is now just boolean
      expect(deleteResponse.data).toBe(true);

      // Verify it's gone
      const getResponse = await formsFragment.callRoute("GET", "/admin/submissions/:id", {
        pathParams: { id: submissionId.valueOf() },
      });

      assert(getResponse.type === "error");
      expect(getResponse.status).toBe(404);
    });

    test("should return 404 when submitting to non-existent form", async () => {
      const response = await formsFragment.callRoute("POST", "/:slug/submit", {
        pathParams: { slug: "non-existent-form" },
        body: {
          data: { name: "Test" },
        },
      });

      assert(response.type === "error");
      expect(response.status).toBe(404);
      expect(response.error.code).toBe("NOT_FOUND");
    });
  });

  describe("Services", async () => {
    const { fragments, test: testCtx } = await buildDatabaseFragmentsTest()
      .withTestAdapter({ type: "kysely-sqlite" })
      .withFragment("forms", instantiate(formsFragmentDef).withConfig({}).withRoutes(routes))
      .build();

    const formsFragment = fragments.forms;

    afterAll(async () => {
      await testCtx.cleanup();
    });

    test("should create form via service", async () => {
      const formId = await formsFragment.services.createForm({
        title: "Service Created Form",
        slug: "service-form",
        description: null,
        status: "draft",
        dataSchema: surveyDataSchema,
        uiSchema: surveyUiSchema,
      });

      // createForm now returns just the ID string
      expect(formId).toEqual(expect.any(String));
    });

    test("should get form via service", async () => {
      const createdId = await formsFragment.services.createForm({
        title: "Get Test",
        slug: "get-test",
        description: null,
        status: "draft",
        dataSchema: { type: "object" },
        uiSchema: { type: "VerticalLayout", elements: [] },
      });
      assert(createdId);

      const form = await formsFragment.services.getForm(createdId);
      expect(form?.title).toBe("Get Test");
    });

    test("should list forms via service", async () => {
      const forms = await formsFragment.services.listForms();
      expect(forms.length).toBeGreaterThanOrEqual(2);
    });

    test("should update form via service", async () => {
      const createdId = await formsFragment.services.createForm({
        title: "Update Test",
        slug: "update-test",
        description: null,
        status: "draft",
        dataSchema: { type: "object" },
        uiSchema: { type: "VerticalLayout", elements: [] },
      });
      assert(createdId);

      // Update via direct db (UnitOfWork with .check() doesn't work in test adapter)
      const form = await formsFragment.db.findFirst("form", (b) =>
        b.whereIndex("primary", (eb) => eb("id", "=", createdId)),
      );
      assert(form);

      await formsFragment.db.update("form", form.id, (b) =>
        b.set({
          title: "Updated Title",
          version: form.version + 1,
          updatedAt: new Date(),
        }),
      );

      // Verify via getForm service
      const updated = await formsFragment.services.getForm(createdId);
      expect(updated?.title).toBe("Updated Title");
      expect(updated?.version).toBe(2);
    });

    test("should delete form via service", async () => {
      const createdId = await formsFragment.services.createForm({
        title: "Delete Test",
        slug: "delete-test",
        description: null,
        status: "draft",
        dataSchema: { type: "object" },
        uiSchema: { type: "VerticalLayout", elements: [] },
      });
      assert(createdId);

      // deleteForm returns void
      await formsFragment.services.deleteForm(createdId);

      const form = await formsFragment.services.getForm(createdId);
      expect(form).toBeNull();
    });

    test("should validate data against JSON schema", () => {
      // Valid data
      const validResult = formsFragment.services.validateData(personDataSchema, {
        name: "John",
        email: "john@example.com",
      });
      expect(validResult.success).toBe(true);

      // Invalid data - missing required field
      const invalidResult = formsFragment.services.validateData(personDataSchema, {
        name: "John",
      });
      expect(invalidResult.success).toBe(false);
      if (invalidResult.success === false) {
        expect(invalidResult.error.errors[0]).toStrictEqual({
          instancePath: "/email",
          message: "Invalid input: expected string, received undefined",
        });
      }
    });
  });
});

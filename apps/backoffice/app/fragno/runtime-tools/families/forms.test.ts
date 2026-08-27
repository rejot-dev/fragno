import { assert, describe, expect, test, vi } from "vitest";

import {
  createTrustedSystemBackofficeToolContext,
  executeBackofficeRuntimeTool,
  getAvailableRuntimeTools,
} from "../runtime-tools";
import { formsRuntimeTools, formsToolFamily } from "./forms";

describe("Forms runtime tools", () => {
  test("exposes form and submission commands only with the system Forms runtime", () => {
    expect(formsRuntimeTools.map((tool) => tool.adapters?.bash?.command)).toEqual([
      "forms.list",
      "forms.create",
      "forms.update",
      "forms.submissions.list",
    ]);

    const available = getAvailableRuntimeTools({
      families: [formsToolFamily],
      context: createTrustedSystemBackofficeToolContext({
        runtimes: {
          forms: {
            listForms: vi.fn(),
            createForm: vi.fn(),
            updateForm: vi.fn(),
            listSubmissions: vi.fn(),
          },
        },
      }),
    });
    expect(available.map((tool) => tool.id)).toEqual([
      "forms.list",
      "forms.create",
      "forms.update",
      "forms.submissions.list",
    ]);
  });

  test("parses JSON Schema input and creates a draft form", async () => {
    const createForm = vi.fn().mockResolvedValue({ id: "form-1" });
    const createTool = formsRuntimeTools[1];
    assert(createTool.id === "forms.create");

    const input = createTool.inputSchema.parse(
      createTool.adapters!.bash!.parse([
        "--title",
        "Contact",
        "--slug",
        "contact",
        "--data-schema-json",
        '{"type":"object","properties":{"message":{"type":"string"}}}',
      ]),
    );
    const result = await createTool.execute(
      input,
      createTrustedSystemBackofficeToolContext({
        runtimes: {
          forms: { listForms: vi.fn(), createForm, updateForm: vi.fn(), listSubmissions: vi.fn() },
        },
      }),
    );

    expect(createForm).toHaveBeenCalledWith({
      title: "Contact",
      slug: "contact",
      status: "draft",
      dataSchema: { type: "object", properties: { message: { type: "string" } } },
    });
    expect(result).toEqual({ id: "form-1" });
  });

  test("updates selected form fields by ID", async () => {
    const updateForm = vi.fn().mockResolvedValue({ updated: true });
    const updateTool = formsRuntimeTools[2];
    assert(updateTool.id === "forms.update");

    const input = updateTool.inputSchema.parse(
      updateTool.adapters!.bash!.parse([
        "--form-id",
        "form-1",
        "--status",
        "open",
        "--data-schema-json",
        '{"type":"object","required":["message"]}',
      ]),
    );
    const result = await updateTool.execute(
      input,
      createTrustedSystemBackofficeToolContext({
        runtimes: {
          forms: {
            listForms: vi.fn(),
            createForm: vi.fn(),
            updateForm,
            listSubmissions: vi.fn(),
          },
        },
      }),
    );

    expect(updateForm).toHaveBeenCalledWith("form-1", {
      status: "open",
      dataSchema: { type: "object", required: ["message"] },
    });
    expect(result).toEqual({ updated: true });
  });

  test("leaves status unchanged when updating other form fields", async () => {
    const updateForm = vi.fn().mockResolvedValue({ updated: true });
    const updateTool = formsRuntimeTools[2];
    assert(updateTool.id === "forms.update");

    const input = updateTool.inputSchema.parse(
      updateTool.adapters!.bash!.parse(["--form-id", "form-1", "--title", "Renamed"]),
    );
    await updateTool.execute(
      input,
      createTrustedSystemBackofficeToolContext({
        runtimes: {
          forms: {
            listForms: vi.fn(),
            createForm: vi.fn(),
            updateForm,
            listSubmissions: vi.fn(),
          },
        },
      }),
    );

    expect(updateForm).toHaveBeenCalledWith("form-1", { title: "Renamed" });
  });

  test("normalizes nullable UI schemas and timestamps for codemode output", async () => {
    const listForms = vi.fn().mockResolvedValue([
      {
        id: "form-1",
        title: "Contact",
        description: null,
        slug: "contact",
        status: "open",
        dataSchema: { type: "object" },
        uiSchema: null,
        version: 1,
        createdAt: "2026-08-25T12:00:00.000Z",
        updatedAt: new Date("2026-08-26T12:00:00.000Z"),
      },
    ]);
    const listTool = formsRuntimeTools[0];
    assert(listTool.id === "forms.list");

    const result = await executeBackofficeRuntimeTool(
      listTool,
      {},
      createTrustedSystemBackofficeToolContext({
        runtimes: {
          forms: { listForms, createForm: vi.fn(), updateForm: vi.fn(), listSubmissions: vi.fn() },
        },
      }),
    );

    expect(result).toEqual({
      forms: [
        expect.objectContaining({
          id: "form-1",
          uiSchema: null,
          createdAt: "2026-08-25T12:00:00.000Z",
          updatedAt: "2026-08-26T12:00:00.000Z",
        }),
      ],
    });
  });

  test("lists form submissions newest first by default", async () => {
    const submittedAt = new Date("2026-08-25T12:00:00.000Z");
    const listSubmissions = vi.fn().mockResolvedValue({
      submissions: [
        {
          id: "response-1",
          formId: "form-1",
          formVersion: 1,
          data: { message: "Hello" },
          submittedAt,
          ip: null,
          userAgent: null,
        },
      ],
      nextCursor: "next-page",
      hasNextPage: true,
    });
    const listTool = formsRuntimeTools[3];
    assert(listTool.id === "forms.submissions.list");

    const input = listTool.inputSchema.parse(
      listTool.adapters!.bash!.parse(["--form-id", "form-1"]),
    );
    const result = await executeBackofficeRuntimeTool(
      listTool,
      input,
      createTrustedSystemBackofficeToolContext({
        runtimes: {
          forms: { listForms: vi.fn(), createForm: vi.fn(), updateForm: vi.fn(), listSubmissions },
        },
      }),
    );

    expect(listSubmissions).toHaveBeenCalledWith({
      formId: "form-1",
      sortOrder: "desc",
      pageSize: 25,
      cursor: null,
    });
    expect(result).toEqual({
      submissions: [
        expect.objectContaining({
          id: "response-1",
          data: { message: "Hello" },
          submittedAt: "2026-08-25T12:00:00.000Z",
        }),
      ],
      nextCursor: "next-page",
      hasNextPage: true,
    });
  });
});

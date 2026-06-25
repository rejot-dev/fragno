import { describe, expect, test, vi, assert } from "vitest";

import type { BackofficeObjectRegistry } from "@/backoffice-runtime/object-registry";
import { seedWorkspaceStarterFiles } from "@/files/seed-workspace-starter-files";

describe("workspace starter file seeding", () => {
  test("copies missing starter files without resolving them as folders", async () => {
    const requests: Array<{ method: string; pathname: string }> = [];
    const writtenMetadata: Array<Record<string, unknown>> = [];
    const uploadDo = {
      getAdminConfig: vi.fn(async () => ({
        configured: true,
        defaultProvider: "database",
        providers: { database: { configured: true } },
      })),
      fetch: vi.fn(async (request: Request) => {
        const url = new URL(request.url);
        requests.push({ method: request.method, pathname: url.pathname });

        if (request.method === "POST" && url.pathname === "/api/upload/files") {
          const form = await request.clone().formData();
          const metadata = form.get("metadata");
          if (typeof metadata === "string") {
            writtenMetadata.push(JSON.parse(metadata) as Record<string, unknown>);
          }
        }

        if (request.method === "GET" && url.pathname === "/api/upload/files") {
          return new Response("folder resolution should not be used during starter copy", {
            status: 500,
          });
        }

        if (request.method === "GET" && url.pathname === "/api/upload/files/by-key/content") {
          return new Response("missing", { status: 404 });
        }

        if (request.method === "GET" && url.pathname === "/api/upload/files/by-key") {
          return new Response(JSON.stringify({ message: "missing" }), { status: 404 });
        }

        if (request.method === "POST" && url.pathname === "/api/upload/files") {
          return new Response(JSON.stringify({ ok: true }), {
            status: 200,
            headers: { "content-type": "application/json" },
          });
        }

        return new Response("unexpected", { status: 500 });
      }),
    };
    const objects = {
      upload: {
        forOrg: vi.fn(() => uploadDo),
      },
    } as unknown as BackofficeObjectRegistry;

    await expect(seedWorkspaceStarterFiles({ objects, orgId: "org-1" })).resolves.toMatchObject({
      provider: "database",
      created: expect.arrayContaining(["/workspace/AGENTS.md"]),
    });

    expect(uploadDo.getAdminConfig).toHaveBeenCalledOnce();
    expect(requests).not.toContainEqual({ method: "GET", pathname: "/api/upload/files" });
    assert(requests.some((request) => request.method === "POST"));

    // Starter files must be group-owned by the org (not root), so org members can
    // edit them afterwards instead of hitting EACCES on the read-only "other" bits.
    assert(writtenMetadata.length > 0);
    for (const metadata of writtenMetadata) {
      expect(metadata.__docsFs).toMatchObject({ group: { kind: "org", orgId: "org-1" } });
    }
  });
});

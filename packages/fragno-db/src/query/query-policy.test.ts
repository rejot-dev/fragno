import { assert, expect, test } from "vitest";

import { SQLocalKysely } from "sqlocal/kysely";
import { z } from "zod";

import { defineFragment, defineRoutes, instantiate } from "@fragno-dev/core";

import { SQLocalDriverConfig } from "../adapters/generic-sql/driver-config";
import { SqlAdapter } from "../adapters/generic-sql/generic-sql-adapter";
import { InMemoryAdapter } from "../adapters/in-memory";
import { column, idColumn, referenceColumn, schema } from "../schema/create";
import { withDatabase } from "../with-database";
import {
  applyReadQueryPolicies,
  createQueryPolicyController,
  QueryPolicySet,
} from "./query-policy";

const policySchema = schema("query_policy", (s) =>
  s
    .addTable("organizations", (t) =>
      t
        .addColumn("id", idColumn())
        .addColumn("name", column("string"))
        .createIndex("organizations_name_idx", ["name"]),
    )
    .addTable("documents", (t) =>
      t
        .addColumn("id", idColumn())
        .addColumn("organizationId", referenceColumn({ table: "organizations" }))
        .addColumn("ownerId", column("string"))
        .addColumn("title", column("string"))
        .createIndex("documents_organization_idx", ["organizationId"])
        .createIndex("documents_owner_idx", ["ownerId"]),
    )
    .addTable("comments", (t) =>
      t
        .addColumn("id", idColumn())
        .addColumn("documentId", referenceColumn({ table: "documents" }))
        .addColumn("ownerId", column("string"))
        .addColumn("body", column("string"))
        .createIndex("comments_document_idx", ["documentId"])
        .createIndex("comments_owner_idx", ["ownerId"]),
    ),
);

const policyFragmentDefinition = defineFragment("query-policy")
  .extend(withDatabase(policySchema))
  .providesService("documents", ({ defineService }) =>
    defineService({
      list() {
        return this.serviceTx(policySchema)
          .retrieve((uow) => uow.find("documents", (documents) => documents.whereIndex("primary")))
          .transformRetrieve(([documents]) => documents.map((document) => document.title))
          .build();
      },
    }),
  )
  .build();

const documentsOutputSchema = z.object({
  documents: z.array(z.string()),
  nestedDocuments: z.array(z.string()),
  documentCount: z.number(),
});
const documentCursorOutputSchema = z.object({
  documents: z.array(z.string()),
  hasNextPage: z.boolean(),
  cursor: z.string().nullable(),
});

const policyRoutes = defineRoutes(policyFragmentDefinition).create(({ defineRoute }) => [
  defineRoute({
    method: "GET",
    path: "/documents",
    outputSchema: documentsOutputSchema,
    handler: async function (_input, { json }) {
      const [documents, organizations, documentCount] = await this.handlerTx()
        .retrieve(({ forSchema }) =>
          forSchema(policySchema)
            .find("documents", (documents) => documents.whereIndex("primary"))
            .find("organizations", (organizations) =>
              organizations
                .whereIndex("primary")
                .joinMany("documents", "documents", (documents) =>
                  documents
                    .onIndex("documents_organization_idx", (eb) =>
                      eb("organizationId", "=", eb.parent("id")),
                    )
                    .select(["title"]),
                ),
            )
            .find("documents", (documents) => documents.whereIndex("primary").selectCount()),
        )
        .execute();

      return json({
        documents: documents.map((document) => document.title),
        nestedDocuments: organizations.flatMap((organization) =>
          organization.documents.map((document) => document.title),
        ),
        documentCount,
      });
    },
  }),
  defineRoute({
    method: "GET",
    path: "/documents/owner-a",
    outputSchema: z.array(z.string()),
    handler: async function (_input, { json }) {
      const [documents] = await this.handlerTx()
        .retrieve(({ forSchema }) =>
          forSchema(policySchema).find("documents", (documents) =>
            documents.whereIndex("documents_owner_idx", (eb) => eb("ownerId", "=", "owner-a")),
          ),
        )
        .execute();
      return json(documents.map((document) => document.title));
    },
  }),
  defineRoute({
    method: "GET",
    path: "/documents/first",
    outputSchema: z.string().nullable(),
    handler: async function (_input, { json }) {
      const [document] = await this.handlerTx()
        .retrieve(({ forSchema }) =>
          forSchema(policySchema).findFirst("documents", (documents) =>
            documents.whereIndex("primary"),
          ),
        )
        .execute();
      return json(document?.title ?? null);
    },
  }),
  defineRoute({
    method: "GET",
    path: "/documents/count-owner-a",
    outputSchema: z.number(),
    handler: async function (_input, { json }) {
      const [count] = await this.handlerTx()
        .retrieve(({ forSchema }) =>
          forSchema(policySchema).find("documents", (documents) =>
            documents
              .whereIndex("documents_owner_idx", (eb) => eb("ownerId", "=", "owner-a"))
              .selectCount(),
          ),
        )
        .execute();
      return json(count);
    },
  }),
  defineRoute({
    method: "GET",
    path: "/documents/tree",
    outputSchema: z.array(
      z.object({
        title: z.string(),
        comments: z.array(z.string()),
      }),
    ),
    handler: async function (_input, { json }) {
      const [organizations] = await this.handlerTx()
        .retrieve(({ forSchema }) =>
          forSchema(policySchema).find("organizations", (organizations) =>
            organizations
              .whereIndex("primary")
              .joinMany("documents", "documents", (documents) =>
                documents
                  .onIndex("documents_organization_idx", (eb) =>
                    eb("organizationId", "=", eb.parent("id")),
                  )
                  .joinMany("comments", "comments", (comments) =>
                    comments.onIndex("comments_document_idx", (eb) =>
                      eb("documentId", "=", eb.parent("id")),
                    ),
                  ),
              ),
          ),
        )
        .execute();
      return json(
        organizations.flatMap((organization) =>
          organization.documents.map((document) => ({
            title: document.title,
            comments: document.comments.map((comment) => comment.body),
          })),
        ),
      );
    },
  }),
  defineRoute({
    method: "GET",
    path: "/documents/cursor",
    outputSchema: documentCursorOutputSchema,
    handler: async function (_input, { json }) {
      const [page] = await this.handlerTx()
        .retrieve(({ forSchema }) =>
          forSchema(policySchema).findWithCursor("documents", (documents) =>
            documents.whereIndex("primary").pageSize(1),
          ),
        )
        .execute();
      return json({
        documents: page.items.map((document) => document.title),
        hasNextPage: page.hasNextPage,
        cursor: page.cursor?.encode() ?? null,
      });
    },
  }),
]);

async function seedPolicyDocuments(fragment: ReturnType<typeof instantiatePolicyFragment>) {
  let organizationId = "";
  let visibleDocumentId = "";
  let hiddenDocumentId = "";
  let visibleCommentId = "";
  let hiddenCommentId = "";
  let hiddenDocumentCommentId = "";
  await fragment.inContext(async function () {
    await this.handlerTx()
      .mutate(({ forSchema }) => {
        const uow = forSchema(policySchema);
        const createdOrganizationId = uow.create("organizations", { name: "Fragno" });
        const createdVisibleDocumentId = uow.create("documents", {
          organizationId: createdOrganizationId,
          ownerId: "owner-a",
          title: "Visible",
        });
        const createdHiddenDocumentId = uow.create("documents", {
          organizationId: createdOrganizationId,
          ownerId: "owner-b",
          title: "Hidden",
        });
        const createdVisibleCommentId = uow.create("comments", {
          documentId: createdVisibleDocumentId,
          ownerId: "owner-a",
          body: "Visible comment",
        });
        const createdHiddenCommentId = uow.create("comments", {
          documentId: createdVisibleDocumentId,
          ownerId: "owner-b",
          body: "Hidden comment",
        });
        const createdHiddenDocumentCommentId = uow.create("comments", {
          documentId: createdHiddenDocumentId,
          ownerId: "owner-b",
          body: "Hidden document comment",
        });
        organizationId = createdOrganizationId.externalId;
        visibleDocumentId = createdVisibleDocumentId.externalId;
        hiddenDocumentId = createdHiddenDocumentId.externalId;
        visibleCommentId = createdVisibleCommentId.externalId;
        hiddenCommentId = createdHiddenCommentId.externalId;
        hiddenDocumentCommentId = createdHiddenDocumentCommentId.externalId;
      })
      .execute();
  });
  return {
    organizationId,
    visibleDocumentId,
    hiddenDocumentId,
    visibleCommentId,
    hiddenCommentId,
    hiddenDocumentCommentId,
  };
}

function instantiatePolicyFragment(
  databaseAdapter: InMemoryAdapter | SqlAdapter = new InMemoryAdapter(),
) {
  return instantiate(policyFragmentDefinition)
    .withConfig({})
    .withRoutes([policyRoutes])
    .withOptions({ databaseAdapter })
    .build();
}

test("middleware read query policies apply to roots, counts, and query-tree children", async () => {
  const fragment = instantiatePolicyFragment();
  await seedPolicyDocuments(fragment);

  let standaloneDocumentTitles: string[] = [];
  fragment.withMiddleware(async (_input, { deps }) => {
    deps.queryPolicies.addRead("documents", (eb) => eb("ownerId", "=", "owner-a"));

    const standaloneUow = deps.createUnitOfWork();
    const [standaloneDocuments] = await standaloneUow
      .forSchema(policySchema)
      .find("documents", (documents) => documents.whereIndex("primary"))
      .executeRetrieve();
    standaloneDocumentTitles = standaloneDocuments.map((document) => document.title);
  });

  const response = await fragment.callRoute("GET", "/documents");
  assert(response.type === "json");
  expect(response.data).toEqual({
    documents: ["Visible"],
    nestedDocuments: ["Visible"],
    documentCount: 1,
  });
  expect(standaloneDocumentTitles).toEqual(["Visible"]);
});

test("read query policies reject predicates on unindexed columns", () => {
  const controller = createQueryPolicyController(policySchema, null, () => new QueryPolicySet());

  expect(() =>
    controller.addRead("documents", (eb) => eb("title" as "ownerId", "=", "Visible")),
  ).toThrow('Column "title" is not indexed');
});

test("existing query predicates compose with read policies using AND", async () => {
  const fragment = instantiatePolicyFragment();
  await seedPolicyDocuments(fragment);
  fragment.withMiddleware((_input, { deps }) => {
    deps.queryPolicies.addRead("documents", (eb) => eb("ownerId", "=", "owner-b"));
  });

  const response = await fragment.callRoute("GET", "/documents/owner-a");
  assert(response.type === "json");
  expect(response.data).toEqual([]);
});

test("multiple read policies for one table compose using AND", async () => {
  const fragment = instantiatePolicyFragment();
  const { organizationId } = await seedPolicyDocuments(fragment);
  fragment.withMiddleware((_input, { deps }) => {
    deps.queryPolicies.addRead("documents", (eb) => eb("ownerId", "=", "owner-a"));
    deps.queryPolicies.addRead("documents", (eb) => eb("organizationId", "=", organizationId));
  });

  const response = await fragment.callRoute("GET", "/documents");
  assert(response.type === "json");
  expect(response.data.documents).toEqual(["Visible"]);
});

test("read policies do not leak between sequential requests", async () => {
  const adapter = new InMemoryAdapter();
  const ownerAFragment = instantiatePolicyFragment(adapter);
  const ownerBFragment = instantiatePolicyFragment(adapter);
  await seedPolicyDocuments(ownerAFragment);
  ownerAFragment.withMiddleware((_input, { deps }) => {
    deps.queryPolicies.addRead("documents", (eb) => eb("ownerId", "=", "owner-a"));
  });
  ownerBFragment.withMiddleware((_input, { deps }) => {
    deps.queryPolicies.addRead("documents", (eb) => eb("ownerId", "=", "owner-b"));
  });

  const ownerAResponse = await ownerAFragment.callRoute("GET", "/documents");
  const ownerBResponse = await ownerBFragment.callRoute("GET", "/documents");
  assert(ownerAResponse.type === "json");
  assert(ownerBResponse.type === "json");
  expect(ownerAResponse.data.documents).toEqual(["Visible"]);
  expect(ownerBResponse.data.documents).toEqual(["Hidden"]);
});

test("read policies remain isolated between concurrent requests on one adapter", async () => {
  const adapter = new InMemoryAdapter();
  const ownerAFragment = instantiatePolicyFragment(adapter);
  const ownerBFragment = instantiatePolicyFragment(adapter);
  await seedPolicyDocuments(ownerAFragment);
  ownerAFragment.withMiddleware(async (_input, { deps }) => {
    deps.queryPolicies.addRead("documents", (eb) => eb("ownerId", "=", "owner-a"));
    await Promise.resolve();
  });
  ownerBFragment.withMiddleware(async (_input, { deps }) => {
    deps.queryPolicies.addRead("documents", (eb) => eb("ownerId", "=", "owner-b"));
    await Promise.resolve();
  });

  const [ownerAResponse, ownerBResponse] = await Promise.all([
    ownerAFragment.callRoute("GET", "/documents"),
    ownerBFragment.callRoute("GET", "/documents"),
  ]);
  assert(ownerAResponse.type === "json");
  assert(ownerBResponse.type === "json");
  expect(ownerAResponse.data.documents).toEqual(["Visible"]);
  expect(ownerBResponse.data.documents).toEqual(["Hidden"]);
});
test("read policies remain isolated between schemas with identically named tables", () => {
  const otherSchema = schema("other_query_policy", (s) =>
    s.addTable("documents", (t) =>
      t
        .addColumn("id", idColumn())
        .addColumn("ownerId", column("string"))
        .createIndex("documents_owner_idx", ["ownerId"]),
    ),
  );
  const policies = new QueryPolicySet();
  createQueryPolicyController(policySchema, null, () => policies).addRead("documents", (eb) =>
    eb("ownerId", "=", "owner-a"),
  );

  expect(policies.getRead(policySchema, null, "documents")).toHaveLength(1);
  expect(policies.getRead(otherSchema, null, "documents")).toEqual([]);
});

test("read policies remain isolated between namespaces of the same schema", () => {
  const policies = new QueryPolicySet();
  createQueryPolicyController(policySchema, "tenant-a", () => policies).addRead("documents", (eb) =>
    eb("ownerId", "=", "owner-a"),
  );

  expect(policies.getRead(policySchema, "tenant-a", "documents")).toHaveLength(1);
  expect(policies.getRead(policySchema, "tenant-b", "documents")).toEqual([]);
  expect(policies.getRead(policySchema, null, "documents")).toEqual([]);
});

test("read policies propagate through serviceTx reads", async () => {
  const fragment = instantiatePolicyFragment();
  await seedPolicyDocuments(fragment);

  const titles = await fragment.inContext(async () => {
    fragment.$internal.deps.queryPolicies.addRead("documents", (eb) =>
      eb("ownerId", "=", "owner-a"),
    );
    return await fragment.callServices(() => fragment.services.documents.list());
  });

  expect(titles).toEqual(["Visible"]);
});

test("read policies propagate through service-composed transactions", async () => {
  const fragment = instantiatePolicyFragment();
  await seedPolicyDocuments(fragment);

  const [titles] = await fragment.inContext(async function () {
    fragment.$internal.deps.queryPolicies.addRead("documents", (eb) =>
      eb("ownerId", "=", "owner-a"),
    );
    return await this.handlerTx()
      .withServiceCalls(() => [fragment.services.documents.list()] as const)
      .execute();
  });

  expect(titles).toEqual(["Visible"]);
});

test("read policies propagate through nested handlerTx reads", async () => {
  const fragment = instantiatePolicyFragment();
  await seedPolicyDocuments(fragment);

  const titles = await fragment.inContext(async function () {
    fragment.$internal.deps.queryPolicies.addRead("documents", (eb) =>
      eb("ownerId", "=", "owner-a"),
    );
    return await this.handlerTx()
      .transform(async () => {
        const [documents] = await this.handlerTx()
          .retrieve(({ forSchema }) =>
            forSchema(policySchema).find("documents", (builder) => builder.whereIndex("primary")),
          )
          .execute();
        return documents.map((document) => document.title);
      })
      .execute();
  });

  expect(titles).toEqual(["Visible"]);
});

test("read policies propagate to child units of work created during transaction execution", async () => {
  const fragment = instantiatePolicyFragment();
  await seedPolicyDocuments(fragment);
  let titles: string[] = [];
  fragment.withMiddleware(async (_input, { deps }) => {
    deps.queryPolicies.addRead("documents", (eb) => eb("ownerId", "=", "owner-a"));
    const parentUow = deps.createUnitOfWork();
    const childQuery = parentUow
      .restrict()
      .forSchema(policySchema)
      .find("documents", (builder) => builder.whereIndex("primary"));
    await parentUow.executeRetrieve();
    const [documents] = await childQuery.retrievalPhase;
    titles = documents.map((document) => document.title);
  });

  await fragment.callRoute("GET", "/documents");
  expect(titles).toEqual(["Visible"]);
});
test("a standalone unit of work observes policies added after it was created", async () => {
  const fragment = instantiatePolicyFragment();
  await seedPolicyDocuments(fragment);
  let titles: string[] = [];
  fragment.withMiddleware(async (_input, { deps }) => {
    const uow = deps.createUnitOfWork();
    deps.queryPolicies.addRead("documents", (eb) => eb("ownerId", "=", "owner-a"));
    const [documents] = await uow
      .forSchema(policySchema)
      .find("documents", (builder) => builder.whereIndex("primary"))
      .executeRetrieve();
    titles = documents.map((document) => document.title);
  });

  await fragment.callRoute("GET", "/documents");
  expect(titles).toEqual(["Visible"]);
});

test("requests without read policies remain unrestricted", async () => {
  const fragment = instantiatePolicyFragment();
  await seedPolicyDocuments(fragment);

  const response = await fragment.callRoute("GET", "/documents");
  assert(response.type === "json");
  expect(response.data.documents).toEqual(expect.arrayContaining(["Visible", "Hidden"]));
  expect(response.data.documents).toHaveLength(2);
});

test("read policies apply to findFirst", async () => {
  const fragment = instantiatePolicyFragment();
  await seedPolicyDocuments(fragment);
  fragment.withMiddleware((_input, { deps }) => {
    deps.queryPolicies.addRead("documents", (eb) => eb("ownerId", "=", "owner-b"));
  });

  const response = await fragment.callRoute("GET", "/documents/first");
  assert(response.type === "json");
  assert(response.data === "Hidden");
});

test("read policies filter findWithCursor results before pagination", async () => {
  const fragment = instantiatePolicyFragment();
  await seedPolicyDocuments(fragment);
  fragment.withMiddleware((_input, { deps }) => {
    deps.queryPolicies.addRead("documents", (eb) => eb("ownerId", "=", "owner-b"));
  });

  const response = await fragment.callRoute("GET", "/documents/cursor");
  assert(response.type === "json");
  expect(response.data.documents).toEqual(["Hidden"]);
});

test("read policies produce authorized findWithCursor cursors and hasNextPage values", async () => {
  const fragment = instantiatePolicyFragment();
  await seedPolicyDocuments(fragment);
  fragment.withMiddleware((_input, { deps }) => {
    deps.queryPolicies.addRead("documents", (eb) => eb("ownerId", "=", "owner-a"));
  });

  const response = await fragment.callRoute("GET", "/documents/cursor");
  assert(response.type === "json");
  expect(response.data).toEqual({
    documents: ["Visible"],
    hasNextPage: false,
    cursor: null,
  });
});
test("read policies compose with existing count predicates", async () => {
  const fragment = instantiatePolicyFragment();
  await seedPolicyDocuments(fragment);
  fragment.withMiddleware((_input, { deps }) => {
    deps.queryPolicies.addRead("documents", (eb) => eb("ownerId", "=", "owner-b"));
  });

  const response = await fragment.callRoute("GET", "/documents/count-owner-a");
  assert(response.type === "json");
  assert(response.data === 0);
});

test("read policies apply recursively to query-tree grandchildren", async () => {
  const fragment = instantiatePolicyFragment();
  await seedPolicyDocuments(fragment);
  fragment.withMiddleware((_input, { deps }) => {
    deps.queryPolicies.addRead("comments", (eb) => eb("ownerId", "=", "owner-a"));
  });

  const response = await fragment.callRoute("GET", "/documents/tree");
  assert(response.type === "json");
  expect(response.data).toEqual(
    expect.arrayContaining([
      { title: "Visible", comments: ["Visible comment"] },
      { title: "Hidden", comments: [] },
    ]),
  );
});

test("read policies apply to query-tree roots and children in the same retrieval", async () => {
  const fragment = instantiatePolicyFragment();
  await seedPolicyDocuments(fragment);
  fragment.withMiddleware((_input, { deps }) => {
    deps.queryPolicies.addRead("organizations", (eb) => eb("name", "=", "Fragno"));
    deps.queryPolicies.addRead("documents", (eb) => eb("ownerId", "=", "owner-a"));
    deps.queryPolicies.addRead("comments", (eb) => eb("ownerId", "=", "owner-a"));
  });

  const response = await fragment.callRoute("GET", "/documents/tree");
  assert(response.type === "json");
  expect(response.data).toEqual([{ title: "Visible", comments: ["Visible comment"] }]);
});

test("query-tree children use policies from their explicit schema and namespace", () => {
  const otherSchema = schema("query_policy_child", (s) =>
    s.addTable("documents", (t) =>
      t
        .addColumn("id", idColumn())
        .addColumn("ownerId", column("string"))
        .createIndex("documents_owner_idx", ["ownerId"]),
    ),
  );
  const policies = new QueryPolicySet();
  createQueryPolicyController(otherSchema, "child-namespace", () => policies).addRead(
    "documents",
    (eb) => eb("ownerId", "=", "owner-a"),
  );
  const rootUow = new InMemoryAdapter().createUnitOfWork(policySchema, "root-namespace");
  rootUow.find("documents", (builder) => builder.whereIndex("primary"));
  const operation = rootUow.getRetrievalOperations()[0];
  assert(operation?.type === "find");
  assert(operation.options.queryTree);
  const explicitChild = {
    ...operation.options.queryTree,
    kind: "child" as const,
    alias: "explicitDocuments",
    schema: otherSchema,
    namespace: "child-namespace",
    cardinality: "many" as const,
    onIndexName: "documents_owner_idx",
    onIndex: undefined,
    table: otherSchema.tables.documents,
    select: true as const,
    children: [],
  };
  const operationWithChild = {
    ...operation,
    options: {
      ...operation.options,
      queryTree: { ...operation.options.queryTree, children: [explicitChild] },
    },
  };

  const applied = applyReadQueryPolicies(operationWithChild, policies);
  assert(applied.type === "find");
  expect(applied.options.queryTree?.children[0]?.where).toBeDefined();
});
test("a read policy that compiles to true adds no restriction", () => {
  const policies = new QueryPolicySet();
  const controller = createQueryPolicyController(policySchema, null, () => policies);

  controller.addRead("documents", () => true);

  expect(policies.getRead(policySchema, null, "documents")).toEqual([]);
});

test("a read policy that compiles to true does not acquire the request policy set", () => {
  let acquisitions = 0;
  const controller = createQueryPolicyController(policySchema, null, () => {
    acquisitions += 1;
    return new QueryPolicySet();
  });

  controller.addRead("documents", () => true);

  expect(acquisitions).toBe(0);
});

test("a read policy that compiles to false throws the documented error", () => {
  const controller = createQueryPolicyController(policySchema, null, () => new QueryPolicySet());

  expect(() => controller.addRead("documents", () => false)).toThrow(
    'Read query policy for table "documents" cannot compile to false. Reject the request in middleware instead.',
  );
});

test("adding a read policy outside a database request context throws the documented error", () => {
  const fragment = instantiatePolicyFragment();

  expect(() =>
    fragment.$internal.deps.queryPolicies.addRead("documents", (eb) =>
      eb("ownerId", "=", "owner-a"),
    ),
  ).toThrow("Query policies can only be added within a database request context.");
});

test("read policy controllers reject unknown tables at runtime", () => {
  const controller = createQueryPolicyController(policySchema, null, () => new QueryPolicySet());

  expect(() =>
    controller.addRead("missing" as "documents", (eb) => eb("ownerId", "=", "owner-a")),
  ).toThrow("Table missing not found in schema");
});

test("read policies support complex predicates over indexed columns", () => {
  const policies = new QueryPolicySet();
  const controller = createQueryPolicyController(policySchema, null, () => policies);

  controller.addRead("documents", (eb) =>
    eb.and(
      eb.or(eb("ownerId", "=", "owner-a"), eb("ownerId", "=", "owner-b")),
      eb.not(eb("organizationId", "is", null)),
      eb("ownerId", "in", ["owner-a", "owner-b"]),
    ),
  );

  expect(policies.getRead(policySchema, null, "documents")).toHaveLength(1);
});
test("read policy types reject predicates on unindexed columns", () => {
  const controller = createQueryPolicyController(policySchema, null, () => new QueryPolicySet());

  expect(() =>
    controller.addRead("documents", (eb) => {
      // @ts-expect-error title is not part of any documents index
      return eb("title", "=", "Visible");
    }),
  ).toThrow('Column "title" is not indexed');
});

test("read policies do not affect create, update, or delete operations", async () => {
  const adapter = new InMemoryAdapter();
  const protectedFragment = instantiatePolicyFragment(adapter);
  const unrestrictedFragment = instantiatePolicyFragment(adapter);
  const { organizationId, visibleDocumentId, hiddenDocumentId, hiddenDocumentCommentId } =
    await seedPolicyDocuments(protectedFragment);

  protectedFragment.withMiddleware(async (_input, { deps }) => {
    deps.queryPolicies.addRead("documents", (eb) => eb("ownerId", "=", "owner-a"));
    const uow = deps.createUnitOfWork().forSchema(policySchema);
    uow.update("documents", visibleDocumentId, (builder) => builder.set({ title: "Updated" }));
    uow.delete("comments", hiddenDocumentCommentId);
    uow.delete("documents", hiddenDocumentId);
    uow.create("documents", {
      organizationId,
      ownerId: "owner-b",
      title: "Created",
    });
    await uow.executeMutations();
  });

  await protectedFragment.callRoute("GET", "/documents/first");
  const response = await unrestrictedFragment.callRoute("GET", "/documents");
  assert(response.type === "json");
  expect(response.data.documents).toEqual(expect.arrayContaining(["Updated", "Created"]));
  expect(response.data.documents).not.toContain("Hidden");
  expect(response.data.documents).toHaveLength(2);
});

test("read policies apply when the original query has no condition", () => {
  const adapter = new InMemoryAdapter();
  const uow = adapter.createUnitOfWork(policySchema, "query_policy");
  uow.find("documents", (builder) => builder.whereIndex("primary").selectCount());
  const operation = uow.getRetrievalOperations()[0];
  assert(operation);
  const policies = new QueryPolicySet();
  createQueryPolicyController(policySchema, "query_policy", () => policies).addRead(
    "documents",
    (eb) => eb("ownerId", "=", "owner-a"),
  );

  const applied = applyReadQueryPolicies(operation, policies);

  expect(applied.options.where).toBeDefined();
});

test("applying read policies does not mutate the original retrieval operation or query tree", () => {
  const adapter = new InMemoryAdapter();
  const uow = adapter.createUnitOfWork(policySchema, "query_policy");
  uow.find("organizations", (organizations) =>
    organizations
      .whereIndex("primary")
      .joinMany("documents", "documents", (documents) =>
        documents.onIndex("documents_organization_idx", (eb) =>
          eb("organizationId", "=", eb.parent("id")),
        ),
      ),
  );
  const operation = uow.getRetrievalOperations()[0];
  assert(operation?.type === "find");
  assert(operation.options.queryTree);
  const originalTree = operation.options.queryTree;
  const originalChild = originalTree.children[0];
  const policies = new QueryPolicySet();
  createQueryPolicyController(policySchema, "query_policy", () => policies).addRead(
    "documents",
    (eb) => eb("ownerId", "=", "owner-a"),
  );

  const applied = applyReadQueryPolicies(operation, policies);

  assert(applied.type === "find");
  expect(applied).not.toBe(operation);
  expect(applied.options.queryTree).not.toBe(originalTree);
  expect(operation.options.queryTree).toBe(originalTree);
  expect(operation.options.queryTree.children[0]).toBe(originalChild);
  expect(operation.options.queryTree.children[0]?.where).toBeUndefined();
});

test("an empty policy set preserves retrieval operation identity", () => {
  const adapter = new InMemoryAdapter();
  const uow = adapter.createUnitOfWork(policySchema, "query_policy");
  uow.find("documents", (builder) => builder.whereIndex("primary"));
  const operation = uow.getRetrievalOperations()[0];
  assert(operation);

  expect(applyReadQueryPolicies(operation, new QueryPolicySet())).toBe(operation);
});

async function createSqlPolicyFragment() {
  const { dialect } = new SQLocalKysely(":memory:");
  const adapter = new SqlAdapter({
    dialect,
    driverConfig: new SQLocalDriverConfig(),
  });
  await adapter.prepareMigrations(policySchema, "query_policy").execute(0, policySchema.version, {
    updateVersionInMigration: false,
  });
  return { adapter, fragment: instantiatePolicyFragment(adapter) };
}

test("read policies compile and execute through a SQL adapter", async () => {
  const { adapter, fragment } = await createSqlPolicyFragment();
  try {
    await seedPolicyDocuments(fragment);
    fragment.withMiddleware((_input, { deps }) => {
      deps.queryPolicies.addRead("documents", (eb) => eb("ownerId", "=", "owner-b"));
    });

    const response = await fragment.callRoute("GET", "/documents/first");
    assert(response.type === "json");
    assert(response.data === "Hidden");
  } finally {
    await adapter.close();
  }
});

test("SQL adapter read policies apply to finds, counts, and nested joins", async () => {
  const { adapter, fragment } = await createSqlPolicyFragment();
  try {
    await seedPolicyDocuments(fragment);
    fragment.withMiddleware((_input, { deps }) => {
      deps.queryPolicies.addRead("documents", (eb) => eb("ownerId", "=", "owner-a"));
    });

    const response = await fragment.callRoute("GET", "/documents");
    assert(response.type === "json");
    expect(response.data).toEqual({
      documents: ["Visible"],
      nestedDocuments: ["Visible"],
      documentCount: 1,
    });
  } finally {
    await adapter.close();
  }
});

import { column, idColumn, schema, type AnySchema } from "@fragno-dev/db/schema";
import { commentSchema, upvoteSchema } from "@fragno-dev/fragno-db-library/schema";

import { defineLocalProjection, type AnyLofiLocalProjection } from "@fragno-dev/lofi";

const projectUsageSchema = schema("local_project_usage", (s) =>
  s
    .addTable("project_usage", (t) =>
      t
        .addColumn("id", idColumn())
        .addColumn("reference", column("string"))
        .addColumn("latestCommentTitle", column("string").nullable())
        .addColumn("latestCommentContent", column("string").nullable())
        .addColumn("ratingTotal", column("integer").nullable())
        .createIndex("idx_project_reference", ["reference"], { unique: true }),
    )
    .addTable("comment_projection_state", (t) =>
      t
        .addColumn("id", idColumn())
        .addColumn("reference", column("string"))
        .addColumn("title", column("string").nullable())
        .addColumn("content", column("string").nullable()),
    )
    .addTable("upvote_total_projection_state", (t) =>
      t.addColumn("id", idColumn()).addColumn("reference", column("string")),
    ),
);

const projectUsageProjection = defineLocalProjection({
  name: "project-usage",
  retrieve: ({ match, read }) => {
    const commentMutations = match.all(commentSchema, "comment", ["create", "update"]);
    const totalMutations = match.all(upvoteSchema, "upvote_total", ["create", "update"]);

    return {
      comments: read
        .each(commentMutations)
        .map((mutation) => {
          const values = mutation.op === "create" ? mutation.values : mutation.set;
          const reference = values["postReference"];
          const title = values["title"];
          const content = values["content"];
          return {
            mutation,
            reference: typeof reference === "string" ? reference : undefined,
            title: typeof title === "string" ? title : undefined,
            content: typeof content === "string" ? content : undefined,
          };
        })
        .get(projectUsageSchema, "comment_projection_state", ({ mutation }) => mutation.externalId),
      commentProjectUsage: read
        .each(commentMutations)
        .map((mutation) => {
          const values = mutation.op === "create" ? mutation.values : mutation.set;
          const reference = values["postReference"];
          return typeof reference === "string" ? { mutation, reference } : undefined;
        })
        .get(projectUsageSchema, "project_usage", ({ reference }) => reference),
      totals: read
        .each(totalMutations)
        .map((mutation) => {
          const values = mutation.op === "create" ? mutation.values : mutation.set;
          const reference = values["reference"];
          const total = values["total"];
          return {
            mutation,
            reference: typeof reference === "string" ? reference : undefined,
            total: typeof total === "number" ? total : undefined,
          };
        })
        .get(
          projectUsageSchema,
          "upvote_total_projection_state",
          ({ mutation }) => mutation.externalId,
        ),
      totalProjectUsage: read
        .each(totalMutations)
        .map((mutation) => {
          const values = mutation.op === "create" ? mutation.values : mutation.set;
          const reference = values["reference"];
          return typeof reference === "string" ? { mutation, reference } : undefined;
        })
        .get(projectUsageSchema, "project_usage", ({ reference }) => reference),
    };
  },
  mutate: ({ retrieved, tx }) => {
    const projectUsage = tx.forSchema(projectUsageSchema);
    const commentProjectUsageByMutationId = new Map(
      retrieved.commentProjectUsage.map(({ item, row }) => [item.mutation.externalId, row]),
    );
    const totalProjectUsageByMutationId = new Map(
      retrieved.totalProjectUsage.map(({ item, row }) => [item.mutation.externalId, row]),
    );

    for (const { item, row: previous } of retrieved.comments) {
      const mutationId = item.mutation.externalId;
      const reference = item.reference ?? previous?.reference;
      if (!reference) {
        continue;
      }

      const title = item.title ?? previous?.title ?? null;
      const content = item.content ?? previous?.content ?? null;
      if (previous) {
        projectUsage.update("comment_projection_state", mutationId, (b) =>
          b.set({ reference, title, content }),
        );
      } else {
        projectUsage.create("comment_projection_state", {
          id: mutationId,
          reference,
          title,
          content,
        });
      }

      const existing = commentProjectUsageByMutationId.get(mutationId);
      const values = { latestCommentTitle: title, latestCommentContent: content };
      if (existing || !commentProjectUsageByMutationId.has(mutationId)) {
        projectUsage.update("project_usage", reference, (b) => b.set(values));
      } else {
        projectUsage.create("project_usage", { id: reference, reference, ...values });
      }
    }

    for (const { item, row: previous } of retrieved.totals) {
      const mutationId = item.mutation.externalId;
      const reference = item.reference ?? previous?.reference;
      if (!reference || item.total === undefined) {
        continue;
      }

      if (!previous) {
        projectUsage.create("upvote_total_projection_state", {
          id: mutationId,
          reference,
        });
      }

      const existing = totalProjectUsageByMutationId.get(mutationId);
      const values = { ratingTotal: item.total };
      if (existing || !totalProjectUsageByMutationId.has(mutationId)) {
        projectUsage.update("project_usage", reference, (b) => b.set(values));
      } else {
        projectUsage.create("project_usage", { id: reference, reference, ...values });
      }
    }
  },
});

export const LOCAL_SCHEMAS = [projectUsageSchema];
export const LOCAL_PROJECTIONS: AnyLofiLocalProjection[] = [projectUsageProjection];

export const SCHEMA_REGISTRY = new Map<string, AnySchema>([
  [commentSchema.name, commentSchema],
  [upvoteSchema.name, upvoteSchema],
]);
export const REGISTERED_SCHEMAS = [...SCHEMA_REGISTRY.values()];

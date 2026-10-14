import type {
  SandboxImage,
  SandboxInstanceType,
} from "@fragno-apps/cf-sandbox-bridge/sandbox/sandbox-container-contract";
import { column, idColumn, schema, type Column } from "@fragno-dev/db/schema";

/** A container snapshot of the sandbox's last workspace, restored by its next start. */
export type SandboxWorkspaceSnapshot = {
  id: string;
  size: number;
  expiresAt: string;
};

export const sandboxManagerFragmentSchema = schema("sandbox-manager", (s) =>
  s
    .addTable("sandbox_instance", (t) =>
      t
        .addColumn("id", idColumn())
        .addColumn("provider", column("string"))
        .addColumn("status", column("string"))
        .addColumn("workflowInstanceId", column("string").nullable())
        .addColumn("keepAlive", column("bool"))
        .addColumn("sleepAfter", column("json").nullable())
        .addColumn("startupCommand", column("text"))
        .addColumn("startupTimeoutMs", column("integer").nullable())
        .addColumn("startedAt", column("timestamp").nullable())
        .addColumn("expectedStopAt", column("timestamp").nullable())
        .addColumn("stoppedAt", column("timestamp").nullable())
        .addColumn("lastError", column("text").nullable())
        .addColumn(
          "createdAt",
          column("timestamp").defaultTo((b) => b.now()),
        )
        .addColumn(
          "updatedAt",
          column("timestamp").defaultTo((b) => b.now()),
        )
        .createIndex("idx_sandbox_instance_provider", ["provider"])
        .createIndex("idx_sandbox_instance_status", ["status"])
        .createIndex("idx_sandbox_instance_workflowInstanceId", ["workflowInstanceId"]),
    )
    .alterTable("sandbox_instance", (t) =>
      t
        // Sandboxes created before image selection ran the image now named "workspace".
        .addColumn(
          "image",
          column("string").defaultTo("workspace") as Column<"string", SandboxImage, SandboxImage>,
        )
        .addColumn(
          "instanceType",
          column("string").defaultTo("lite") as Column<
            "string",
            SandboxInstanceType,
            SandboxInstanceType
          >,
        )
        .addColumn(
          "workspaceSnapshot",
          column("json").nullable() as Column<
            "json",
            SandboxWorkspaceSnapshot | null,
            SandboxWorkspaceSnapshot | null
          >,
        ),
    ),
);

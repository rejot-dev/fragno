import { describe, expect, it } from "vitest";
import { column, idColumn, schema } from "../../../schema/create";
import { Cursor } from "../../../query/cursor";
import type { Condition } from "../../../query/condition-builder";
import { NodePostgresDriverConfig } from "../driver-config";
import { buildCursorCondition } from "./cursor-utils";

const testSchema = schema((s) => {
  return s.addTable("workflow_step", (t) => {
    return t
      .addColumn("id", idColumn())
      .addColumn("workflowName", column("string"))
      .addColumn("instanceId", column("string"))
      .addColumn("runNumber", column("integer"))
      .addColumn("createdAt", column("timestamp"));
  });
});

const table = testSchema.tables.workflow_step;
const indexColumns = [
  table.columns.workflowName,
  table.columns.instanceId,
  table.columns.runNumber,
  table.columns.createdAt,
];

type NormalizedCondition =
  | { type: "compare"; column: string; operator: string; value: unknown }
  | { type: "and" | "or"; items: NormalizedCondition[] }
  | { type: "not"; item: NormalizedCondition };

const normalizeCondition = (condition?: Condition): NormalizedCondition | null => {
  if (!condition) {
    return null;
  }

  switch (condition.type) {
    case "compare":
      return {
        type: "compare",
        column: condition.a.ormName,
        operator: condition.operator,
        value: condition.b,
      };
    case "and":
    case "or":
      return {
        type: condition.type,
        items: condition.items.map((item) => normalizeCondition(item) as NormalizedCondition),
      };
    case "not":
      return {
        type: "not",
        item: normalizeCondition(condition.item) as NormalizedCondition,
      };
    default: {
      const exhaustiveCheck: never = condition;
      throw new Error(`Unsupported condition type: ${JSON.stringify(exhaustiveCheck)}`);
    }
  }
};

describe("buildCursorCondition", () => {
  it("builds lexicographic conditions for composite asc cursors", () => {
    const createdAt = new Date("2024-01-01T00:00:00.000Z");
    const cursor = new Cursor({
      indexName: "idx_workflow_step_history_createdAt",
      orderDirection: "asc",
      pageSize: 10,
      indexValues: {
        workflowName: "wf",
        instanceId: "inst",
        runNumber: 2,
        createdAt,
      },
    });

    const condition = buildCursorCondition(
      cursor,
      indexColumns,
      "asc",
      true,
      new NodePostgresDriverConfig(),
    );

    expect(normalizeCondition(condition)).toEqual({
      type: "or",
      items: [
        {
          type: "compare",
          column: "workflowName",
          operator: ">",
          value: "wf",
        },
        {
          type: "and",
          items: [
            {
              type: "compare",
              column: "workflowName",
              operator: "=",
              value: "wf",
            },
            {
              type: "compare",
              column: "instanceId",
              operator: ">",
              value: "inst",
            },
          ],
        },
        {
          type: "and",
          items: [
            {
              type: "compare",
              column: "workflowName",
              operator: "=",
              value: "wf",
            },
            {
              type: "compare",
              column: "instanceId",
              operator: "=",
              value: "inst",
            },
            {
              type: "compare",
              column: "runNumber",
              operator: ">",
              value: 2,
            },
          ],
        },
        {
          type: "and",
          items: [
            {
              type: "compare",
              column: "workflowName",
              operator: "=",
              value: "wf",
            },
            {
              type: "compare",
              column: "instanceId",
              operator: "=",
              value: "inst",
            },
            {
              type: "compare",
              column: "runNumber",
              operator: "=",
              value: 2,
            },
            {
              type: "compare",
              column: "createdAt",
              operator: ">",
              value: createdAt,
            },
          ],
        },
      ],
    });
  });

  it("builds lexicographic conditions for composite desc cursors", () => {
    const createdAt = new Date("2024-01-01T00:00:00.000Z");
    const cursor = new Cursor({
      indexName: "idx_workflow_step_history_createdAt",
      orderDirection: "desc",
      pageSize: 10,
      indexValues: {
        workflowName: "wf",
        instanceId: "inst",
        runNumber: 2,
        createdAt,
      },
    });

    const condition = buildCursorCondition(
      cursor,
      indexColumns,
      "desc",
      true,
      new NodePostgresDriverConfig(),
    );

    expect(normalizeCondition(condition)).toEqual({
      type: "or",
      items: [
        {
          type: "compare",
          column: "workflowName",
          operator: "<",
          value: "wf",
        },
        {
          type: "and",
          items: [
            {
              type: "compare",
              column: "workflowName",
              operator: "=",
              value: "wf",
            },
            {
              type: "compare",
              column: "instanceId",
              operator: "<",
              value: "inst",
            },
          ],
        },
        {
          type: "and",
          items: [
            {
              type: "compare",
              column: "workflowName",
              operator: "=",
              value: "wf",
            },
            {
              type: "compare",
              column: "instanceId",
              operator: "=",
              value: "inst",
            },
            {
              type: "compare",
              column: "runNumber",
              operator: "<",
              value: 2,
            },
          ],
        },
        {
          type: "and",
          items: [
            {
              type: "compare",
              column: "workflowName",
              operator: "=",
              value: "wf",
            },
            {
              type: "compare",
              column: "instanceId",
              operator: "=",
              value: "inst",
            },
            {
              type: "compare",
              column: "runNumber",
              operator: "=",
              value: 2,
            },
            {
              type: "compare",
              column: "createdAt",
              operator: "<",
              value: createdAt,
            },
          ],
        },
      ],
    });
  });
});

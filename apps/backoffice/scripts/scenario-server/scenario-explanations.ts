import type { BackofficeContextScope } from "@fragno-dev/backoffice-api/v0/shared/scope";
import {
  FRAGNO_OUTBOX_PAGE_SIZE,
  type OutboxEntry,
  type OutboxOperation,
} from "@fragno-dev/db/outbox";

import { BackofficeKernel } from "../../app/backoffice-runtime/kernel";
import { backofficeContextScopeRoutePath } from "../../app/backoffice-runtime/scope-codec";
import type {
  BackofficeScenarioContext,
  BackofficeScenarioDefinition,
  BackofficeScenarioStep,
} from "../../app/fragno/automation/scenario";
import type { ScenarioViewChange, ScenarioViewExplanation } from "./scenario-view-protocol";

/** A step built when it runs, from what earlier steps captured and the runtime's clock. */
export type ScenarioLaterStep = (
  label: string,
  build: (ctx: BackofficeScenarioContext) => BackofficeScenarioStep,
) => BackofficeScenarioStep;

/**
 * Records what each step of a scenario does: the step it runs, and what it changes in the
 * Automations of the organizations the scenario knows, as their outboxes record it. Explanations
 * are by the step's place in the scenario's journal.
 */
export function createScenarioExplanations() {
  const explanations = new Map<number, ScenarioViewExplanation>();
  let explaining: ScenarioViewExplanation | null = null;
  // The step `later` built for the step being explained, whose drain policy applies.
  let built: BackofficeScenarioStep | null = null;

  function explained(step: BackofficeScenarioStep, defaultDrain: boolean): BackofficeScenarioStep {
    return {
      ...step,
      // The explanation drains itself, so it sees what draining changes too.
      drain: false,
      run: async (ctx) => {
        const explanation: ScenarioViewExplanation = {
          does: { type: step.type, label: step.label },
          changes: [],
        };
        // `runStep` records the step at the journal's end once it ran.
        explanations.set(ctx.journal.entries.length, explanation);
        explaining = explanation;
        const before = await outboxCursors(ctx);
        try {
          await step.run(ctx);
          if ((built ?? step).drain ?? defaultDrain) {
            await ctx.drain();
          }
        } finally {
          explaining = null;
          built = null;
          explanation.changes = await changesSince(ctx, before);
        }
      },
    };
  }

  const later: ScenarioLaterStep = (label, build) => ({
    type: "scenario-server.later",
    label,
    run: async (ctx) => {
      const step = build(ctx);
      built = step;
      if (explaining) {
        explaining.does = { type: step.type, label: step.label };
      }
      await step.run(ctx);
    },
  });

  return {
    later,
    /** The scenario with its steps explained. */
    explain(definition: BackofficeScenarioDefinition): BackofficeScenarioDefinition {
      const { setup, steps } = definition;
      const defaultDrain = definition.options?.drain ?? true;
      return {
        ...definition,
        ...(setup
          ? { setup: (builders) => setup(builders).map((step) => explained(step, defaultDrain)) }
          : {}),
        steps: (builders) => steps(builders).map((step) => explained(step, defaultDrain)),
      };
    },
    explanation: (index: number) => explanations.get(index) ?? null,
  };
}

function organizationScopes(ctx: BackofficeScenarioContext): BackofficeContextScope[] {
  return ctx.files.listOrgIds().map((orgId) => ({ kind: "org", orgId, jurisdiction: null }));
}

async function readOutbox<T>(
  ctx: BackofficeScenarioContext,
  scope: BackofficeContextScope,
  path: string,
): Promise<T> {
  const kernel = new BackofficeKernel(ctx.runtime.services);
  const automations = kernel.scoped("AUTOMATIONS", scope, ctx.runtime.objects.automations);
  const response = await automations.http.fetch(
    new Request(`http://scenario.local/api/automations${path}`),
  );
  if (!response.ok) {
    throw new Error(`Reading ${path} returned ${response.status}: ${await response.text()}`);
  }
  return (await response.json()) as T;
}

async function outboxCursors(ctx: BackofficeScenarioContext): Promise<Map<string, string | null>> {
  const cursors = new Map<string, string | null>();
  for (const scope of organizationScopes(ctx)) {
    const description = await readOutbox<{ currentVersionstamp: string | null }>(
      ctx,
      scope,
      "/_internal",
    );
    cursors.set(backofficeContextScopeRoutePath(scope), description.currentVersionstamp);
  }
  return cursors;
}

/** The changes after each scope's cursor; scopes that appeared since are read from their start. */
async function changesSince(
  ctx: BackofficeScenarioContext,
  cursors: Map<string, string | null>,
): Promise<ScenarioViewChange[]> {
  const changes: ScenarioViewChange[] = [];
  for (const scope of organizationScopes(ctx)) {
    const routePath = backofficeContextScopeRoutePath(scope);
    let after = cursors.get(routePath) ?? null;
    for (;;) {
      const query = new URLSearchParams({ limit: String(FRAGNO_OUTBOX_PAGE_SIZE) });
      if (after !== null) {
        query.set("afterVersionstamp", after);
      }
      const entries = await readOutbox<OutboxEntry[]>(ctx, scope, `/_internal/outbox?${query}`);
      for (const entry of entries) {
        const { operations } = entry.payload.json as { operations: OutboxOperation[] };
        changes.push(...operations.map((operation) => change(routePath, operation)));
      }
      const last = entries.at(-1);
      if (!last || entries.length < FRAGNO_OUTBOX_PAGE_SIZE) {
        break;
      }
      after = last.versionstamp;
    }
  }
  return changes;
}

function change(scope: string, operation: OutboxOperation): ScenarioViewChange {
  const table = operation.namespace ? `${operation.namespace}.${operation.table}` : operation.table;
  const { op } = operation;
  return op === "create"
    ? { scope, op, table, id: operation.externalId, values: operation.values }
    : op === "update"
      ? { scope, op, table, id: operation.externalId, values: operation.set }
      : op === "delete"
        ? { scope, op, table, id: operation.externalId, values: {} }
        : { scope, op, table, id: "", values: operation.match };
}

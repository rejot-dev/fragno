import { type GraphNode, type RouterMatch, type RouterNode } from "../model.ts";
import {
  type AstNode,
  memberCallee,
  objectStringProp,
  parseModule,
  sourceRef,
  walkCalls,
} from "./ast.ts";
import { type FileContribution } from "./workflow.ts";

const SOURCE_RE = /event\.source\s*===\s*["']([^"']+)["']/;
const EVENT_TYPE_RE = /event\.eventType\s*===\s*["']([^"']+)["']/;

/**
 * Parse a router script (`router.cm.js`) into routing-rule nodes:
 *  - `workflow.createInstance({ remoteWorkflowName })` -> a `spawn` rule
 *  - `workflow.sendEvent({ type })`                    -> a `sendEvent` rule
 *
 * Cross-file edges (event -> router, router -> workflow) are resolved later in `build`.
 */
export function parseRouterFile(path: string, source: string): FileContribution {
  const { ast, diagnostics } = parseModule(path, source);
  const nodes: GraphNode[] = [];
  if (!ast) {
    return { nodes, edges: [], diagnostics, workflowNames: [] };
  }

  let spawnIndex = 0;
  let sendIndex = 0;

  // Router scripts have no loop blocks to model, so `onLoop` is omitted and loops
  // are walked through transparently (their bodies keep the router's branch context).
  walkCalls(ast, source, "router", {
    onCall: ({ call, branch }) => {
      const member = memberCallee(call);
      if (!member || member.object !== "workflow") {
        return;
      }

      const args = (call["arguments"] as AstNode[]) ?? [];
      const match = matchFromBranch(branch);

      if (member.method === "createInstance") {
        const targetWorkflowName = objectStringProp(args[0], "remoteWorkflowName");
        const node: RouterNode = {
          id: `router:${path}#spawn:${targetWorkflowName ?? "unknown"}#${spawnIndex}`,
          kind: "router",
          label: spawnLabel(match, targetWorkflowName),
          action: "spawn",
          path,
          ref: sourceRef(path, call),
          match,
          targetWorkflowName,
        };
        nodes.push(node);
        spawnIndex += 1;
        if (!targetWorkflowName) {
          diagnostics.push({
            severity: "warning",
            code: "missing-remote-workflow-name",
            message: "workflow.createInstance is missing a static `remoteWorkflowName`.",
            ref: sourceRef(path, call),
          });
        }
        return;
      }

      if (member.method === "sendEvent") {
        const eventType = objectStringProp(args[0], "type");
        const node: RouterNode = {
          id: `router:${path}#send:${eventType ?? "unknown"}#${sendIndex}`,
          kind: "router",
          label: eventType ? `sendEvent ${eventType}` : "sendEvent",
          action: "sendEvent",
          path,
          ref: sourceRef(path, call),
          match,
          eventType,
        };
        nodes.push(node);
        sendIndex += 1;
      }
    },
  });

  return { nodes, edges: [], diagnostics, workflowNames: [] };
}

function matchFromBranch(branch: string[]): RouterMatch {
  let source: string | undefined;
  let eventType: string | undefined;
  for (const condition of branch) {
    source ??= SOURCE_RE.exec(condition)?.[1];
    eventType ??= EVENT_TYPE_RE.exec(condition)?.[1];
  }
  return { source, eventType, conditions: branch };
}

function spawnLabel(match: RouterMatch, target: string | undefined): string {
  const trigger = [match.source, match.eventType].filter(Boolean).join("/");
  const arrow = target ? ` → ${target}` : "";
  return trigger ? `${trigger}${arrow}` : (target ?? "spawn");
}

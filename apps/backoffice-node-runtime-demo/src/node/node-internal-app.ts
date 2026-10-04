import type { GraftNodeRuntimeStorage } from "@fragno-private/backoffice-node-runtime/graft-runtime-storage";
import type { AuthorityBoundGraftNodeObjectRuntime } from "@fragno-private/backoffice-node-runtime/node-object-runtime";
import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";

import {
  readObjectControlOverview,
  readObjectOwnership,
  type NodeDebugOverview,
} from "../inspection/object-control-overview";
import type { demoObjectDefinition } from "../objects/demo-object-definition";
import { renderNodePage } from "./node-page";
import {
  handleNodeFetchFailure,
  NodeRequestInputError,
  requireDemoObjectName,
} from "./node-request-boundary";

/** Internal-only inspection and administration; reads remain available after authority fences. */
export function createNodeInternalApp(context: {
  runtime: AuthorityBoundGraftNodeObjectRuntime<{ SHOWCASE: typeof demoObjectDefinition }>;
  storage: GraftNodeRuntimeStorage;
  nodeId: string;
  applicationOrigin: string;
}) {
  const app = new Hono();
  app.use(
    "*",
    bodyLimit({
      maxSize: 1_048_576,
      onError() {
        throw new NodeRequestInputError("DEMO_REQUEST_BODY_TOO_LARGE");
      },
    }),
  );
  app.onError(handleNodeFetchFailure);
  app.notFound((c) => c.json({ error: "DEMO_ROUTE_NOT_FOUND" }, 404));
  app.get("/", (c) =>
    c.html(
      renderNodePage({
        generatedAtMs: Date.now(),
        nodeId: context.nodeId,
        applicationOrigin: context.applicationOrigin,
        nodeAuthority: context.runtime.readNodeAuthorityStatus(),
        objects: readObjectControlOverview(context.storage),
      }),
    ),
  );
  app.get("/health", (c) => {
    const nodeAuthority = context.runtime.readNodeAuthorityStatus();
    return c.json(
      { status: nodeAuthority.state, nodeId: context.nodeId, nodeAuthority },
      nodeAuthority.state === "serving" ? 200 : 503,
    );
  });
  app.get("/debug/overview", (c) => {
    const overview: NodeDebugOverview = {
      generatedAtMs: Date.now(),
      nodeId: context.nodeId,
      nodeAuthority: context.runtime.readNodeAuthorityStatus(),
      objects: readObjectControlOverview(context.storage),
    };
    return c.json(overview);
  });
  app.post("/tick", async (c) => {
    // tick owns its node-authority admission; internal ingress never bypasses that check.
    await context.runtime.tick();
    return c.json({ ticked: true });
  });
  app.get("/control/:name", (c) => {
    const name = requireDemoObjectName(c.req.param("name"));
    return c.json({ ownership: readObjectOwnership(context.storage, `SHOWCASE:${name}`) });
  });
  return app;
}

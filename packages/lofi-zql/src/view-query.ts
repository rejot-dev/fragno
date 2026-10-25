import type { AST } from "./vendor/zero-protocol/src/ast.ts";
import type { Format } from "./vendor/zero-types/src/format.ts";

/** Names ZQL views to the replica worker's view engines. */
export const ZQL_VIEW_KIND = "zql";

/** A ZQL view's query, as pages send it to the replica worker. */
export type LofiZqlViewQuery = { schemaName: string; ast: AST; format: Format };

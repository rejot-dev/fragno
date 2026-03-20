import type { SelectResult } from "@fragno-dev/db/query";

import { defineRoutes } from "@fragno-dev/core";
import type { DatabaseRequestContext, CursorResult } from "@fragno-dev/db";

import { resendFragmentDefinition, type ResendHooksMap } from "../definition";
import { resendSchema } from "../schema";

const resendRouteBuilder = defineRoutes(resendFragmentDefinition);

export type ResendRouteFactoryContext = Parameters<
  Parameters<typeof resendRouteBuilder.create>[0]
>[0];

export type ResendRouteHandlerContext = DatabaseRequestContext<ResendHooksMap>;

export type ResendEmailMessageRow = SelectResult<
  (typeof resendSchema)["tables"]["emailMessage"],
  {},
  true
>;
export type ResendThreadRow = SelectResult<
  (typeof resendSchema)["tables"]["emailThread"],
  {},
  true
>;

export type ResendEmailMessagePage = CursorResult<ResendEmailMessageRow>;
export type ResendThreadPage = CursorResult<ResendThreadRow>;

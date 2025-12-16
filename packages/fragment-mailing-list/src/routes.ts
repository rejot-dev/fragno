import { defineRoutes } from "@fragno-dev/core";
import { z } from "zod";
import { mailingListFragmentDefinition, type SortField } from "./definition";
import { decodeCursor, type Cursor } from "@fragno-dev/db";

const sortBySchema = z.enum(["email", "subscribedAt"]);

const queryParamsSchema = z.object({
  search: z.string().optional(),
  sortBy: sortBySchema.catch("subscribedAt"),
  sortOrder: z.enum(["asc", "desc"]).catch("desc"),
  pageSize: z.coerce.number().min(1).max(100).catch(20),
  cursor: z.string().optional(),
});

export const mailingListRoutesFactory = defineRoutes(mailingListFragmentDefinition).create(
  ({ services, defineRoute }) => {
    const parseQueryParams = (query: URLSearchParams) => {
      const params = queryParamsSchema.parse({
        search: query.get("search") || undefined,
        sortBy: query.get("sortBy"),
        sortOrder: query.get("sortOrder"),
        pageSize: query.get("pageSize"),
        cursor: query.get("cursor") || undefined,
      });

      // When searching, enforce email sorting for efficient queries
      const sortBy: SortField = params.search ? "email" : params.sortBy;

      return {
        ...params,
        sortBy,
      };
    };

    const parseCursor = (cursorParam: string | undefined): Cursor | undefined => {
      if (!cursorParam) {
        return undefined;
      }
      try {
        return decodeCursor(cursorParam);
      } catch {
        return undefined;
      }
    };

    return [
      defineRoute({
        method: "GET",
        path: "/subscribers",
        queryParameters: ["search", "sortBy", "sortOrder", "pageSize", "cursor"],
        outputSchema: z.object({
          subscribers: z.array(
            z.object({
              id: z.string(),
              email: z.string(),
              subscribedAt: z.date(),
            }),
          ),
          cursor: z.string().optional(),
          hasNextPage: z.boolean(),
          sortBy: sortBySchema,
        }),
        handler: async function ({ query }, { json }) {
          const params = parseQueryParams(query);
          const cursor = parseCursor(params.cursor);

          const result = await this.uow(async ({ executeRetrieve }) => {
            const result = services.getSubscribers({
              search: params.search,
              sortBy: params.sortBy,
              sortOrder: params.sortOrder,
              pageSize: params.pageSize,
              cursor,
            });
            await executeRetrieve();
            return result;
          });

          return json({
            subscribers: result.subscribers,
            cursor: result.cursor?.encode(),
            hasNextPage: result.hasNextPage,
            sortBy: params.sortBy, // Return the actual sortBy used (may differ from requested)
          });
        },
      }),

      defineRoute({
        method: "POST",
        path: "/subscribe",
        inputSchema: z.object({
          email: z.email(),
        }),
        outputSchema: z.object({
          id: z.string(),
          email: z.string(),
          subscribedAt: z.date(),
          alreadySubscribed: z.boolean(),
        }),
        handler: async function ({ input }, { json }) {
          const { email } = await input.valid();

          const result = await this.uow(async ({ executeMutate }) => {
            const result = services.subscribe(email);
            await executeMutate();
            return result;
          });

          return json(result);
        },
      }),
    ];
  },
);

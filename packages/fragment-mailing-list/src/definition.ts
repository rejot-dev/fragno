import { defineFragment } from "@fragno-dev/core";
import { mailingListSchema } from "./schema";
import { withDatabase, type Cursor } from "@fragno-dev/db";
import type { MailingListConfig } from ".";

export type SortField = "email" | "subscribedAt";
export type SortOrder = "asc" | "desc";

export interface GetSubscribersParams {
  search?: string;
  sortBy: SortField;
  sortOrder: SortOrder;
  pageSize: number;
  cursor?: Cursor;
}

export const mailingListFragmentDefinition = defineFragment<MailingListConfig>("mailing-list")
  .extend(withDatabase(mailingListSchema))
  .provideHooks(({ defineHook, config }) => ({
    onSubscribe: defineHook(async function (payload: { email: string }) {
      await config.onSubscribe?.(payload.email);
    }),
  }))
  .providesBaseService(({ defineService }) => {
    return defineService({
      subscribe: function (email: string) {
        return this.serviceTx(mailingListSchema)
          .retrieve((uow) => {
            // Check if already subscribed
            return uow.find("subscriber", (b) =>
              b.whereIndex("idx_subscriber_email", (eb) => eb("email", "=", email)),
            );
          })
          .mutate(({ uow, retrieveResult: [existing] }) => {
            if (existing.length > 0) {
              const subscriber = existing[0];
              return {
                id: subscriber.id.toString(),
                email: subscriber.email,
                subscribedAt: subscriber.subscribedAt,
                alreadySubscribed: true,
              };
            }

            const subscribedAt = new Date();
            const id = uow.create("subscriber", { email, subscribedAt });

            uow.triggerHook("onSubscribe", { email });

            return {
              id: id.toString(),
              email,
              subscribedAt,
              alreadySubscribed: false,
            };
          })
          .build();
      },
      getSubscribers: function ({
        search,
        sortBy,
        sortOrder,
        pageSize,
        cursor,
      }: GetSubscribersParams) {
        // Determine which index to use based on search and sortBy
        // When searching, only email sorting is allowed (search uses email index)
        const effectiveSortBy: SortField = search ? "email" : sortBy;
        const indexName =
          effectiveSortBy === "email" ? "idx_subscriber_email" : "idx_subscriber_subscribedAt";

        // If cursor is provided, extract its metadata to ensure consistency
        const effectiveSortOrder = cursor ? cursor.orderDirection : sortOrder;
        const effectivePageSize = cursor ? cursor.pageSize : pageSize;

        return this.serviceTx(mailingListSchema)
          .retrieve((uow) => {
            return uow.findWithCursor("subscriber", (b) => {
              // When searching, we must filter by email and can only use the email index
              if (search) {
                const query = b
                  .whereIndex("idx_subscriber_email", (eb) => eb("email", "contains", search))
                  .orderByIndex("idx_subscriber_email", effectiveSortOrder)
                  .pageSize(effectivePageSize);

                // Add cursor for pagination continuation
                return cursor ? query.after(cursor) : query;
              }

              // When not searching, use the appropriate index for sorting
              const query = b
                .whereIndex(indexName)
                .orderByIndex(indexName, effectiveSortOrder)
                .pageSize(effectivePageSize);

              // Add cursor for pagination continuation
              return cursor ? query.after(cursor) : query;
            });
          })
          .mutate(({ retrieveResult: [subscribers] }) => {
            return {
              subscribers: subscribers.items.map((subscriber) => ({
                id: subscriber.id.toString(),
                email: subscriber.email,
                subscribedAt: subscriber.subscribedAt,
              })),
              cursor: subscribers.cursor,
              hasNextPage: subscribers.hasNextPage,
            };
          })
          .build();
      },
    });
  })
  .build();

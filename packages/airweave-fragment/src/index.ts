import {
  defineFragment,
  defineRoute,
  defineRoutes,
  createFragment,
  type FragnoPublicClientConfig,
  type FragnoPublicConfig,
} from "@fragno-dev/core";
import { createClientBuilder } from "@fragno-dev/core/client";
import { AirweaveSDK as _PortableTypeAirweaveSDK, AirweaveSDKClient } from "@airweave/sdk";

import {
  searchRequestSchema,
  searchResponseSchema,
  type SearchRequest,
  type SearchResponse,
} from "./schemas/search";

import { collectionsResponseSchema } from "./schemas/collections";
import { streamSearchEventsSchema } from "./schemas/search.streaming";
import { StreamingAirweaveClient } from "./search.streaming";
import {
  sourceConnectionsRequestSchema,
  sourceConnectionsResponseSchema,
} from "./schemas/source-connections";
import { sourcesResponseSchema } from "./schemas/sources";
import { toFragmentError } from "./errors";

export interface AirweaveConfig {
  environment?: "production" | "local";
  baseUrl?: string;
  apiKey: string;
  /** Additional headers to include in requests. */
  headers?: Record<string, string>;
}

type AirweaveDeps = {
  airweaveClient: AirweaveSDKClient;
  streamingAirweaveClient: StreamingAirweaveClient;
};

type AirweaveServices = {
  searchCollection: (
    collectionId: string,
    query: string,
    options?: Omit<SearchRequest, "query">,
  ) => Promise<SearchResponse>;
};

const airweaveRoutesFactory = defineRoutes<AirweaveConfig, AirweaveDeps, AirweaveServices>().create(
  ({ deps }) => {
    const { airweaveClient, streamingAirweaveClient } = deps;

    return [
      // Streaming Search endpoint
      defineRoute({
        method: "POST",
        path: "/collections/:collectionId/search/stream",
        inputSchema: searchRequestSchema,
        outputSchema: streamSearchEventsSchema,
        errorCodes: ["AIRWEAVE_SDK_ERROR"],
        handler: async ({ input, pathParams }, { jsonStream }) => {
          const searchParams = await input.valid();
          const { collectionId } = pathParams;
          try {
            return jsonStream(async (stream) => {
              for await (const event of streamingAirweaveClient.search(
                collectionId,
                searchParams,
              )) {
                stream.write(event);
              }
            });
          } catch (err: unknown) {
            return toFragmentError(err).toResponse();
          }
        },
      }),

      // Search endpoint
      defineRoute({
        method: "POST",
        path: "/collections/:collectionId/search",
        inputSchema: searchRequestSchema,
        outputSchema: searchResponseSchema,
        errorCodes: ["AIRWEAVE_SDK_ERROR"],
        handler: async ({ input, pathParams }, { json }) => {
          const searchParams = await input.valid();
          const { collectionId } = pathParams;

          try {
            const response = await airweaveClient.collections.search(collectionId, searchParams);
            return json(response);
          } catch (err: unknown) {
            return toFragmentError(err).toResponse();
          }
        },
      }),

      // List collections endpoint
      defineRoute({
        method: "GET",
        path: "/collections",
        outputSchema: collectionsResponseSchema,
        errorCodes: ["AIRWEAVE_SDK_ERROR"],
        handler: async (_, { json }) => {
          try {
            const response = await airweaveClient.collections.list();

            return json(response);
          } catch (err: unknown) {
            return toFragmentError(err).toResponse();
          }
        },
      }),

      // List sources endpoint
      defineRoute({
        method: "GET",
        path: "/sources",
        outputSchema: sourcesResponseSchema,
        errorCodes: ["AIRWEAVE_SDK_ERROR"],
        handler: async (_, { json }) => {
          try {
            // Call Airweave SDK to list sources
            const response = await airweaveClient.sources.list();

            return json(response);
          } catch (err: unknown) {
            return toFragmentError(err).toResponse();
          }
        },
      }),

      // List source connections endpoint
      defineRoute({
        method: "GET",
        path: "/source-connections",
        queryParameters: ["collection", "skip", "limit"],
        outputSchema: sourceConnectionsResponseSchema,
        errorCodes: ["AIRWEAVE_SDK_ERROR"],
        handler: async ({ query }, { json }) => {
          try {
            // Call Airweave SDK to list source connections
            const queryParams = sourceConnectionsRequestSchema.parse(query);
            const response = await airweaveClient.sourceConnections.list(queryParams);

            return json(response);
          } catch (err: unknown) {
            return toFragmentError(err).toResponse();
          }
        },
      }),
    ];
  },
);

const airweaveFragmentDefinition = defineFragment<AirweaveConfig>("airweave-fragment")
  .withDependencies((config: AirweaveConfig) => {
    return {
      airweaveClient: new AirweaveSDKClient(config),
      streamingAirweaveClient: new StreamingAirweaveClient(config),
    };
  })
  .withServices((_cfg, { airweaveClient }) => {
    return {
      searchCollection: async (
        collectionId: string,
        query: string,
        options?: Omit<SearchRequest, "query">,
      ) => {
        return airweaveClient.collections.search(collectionId, {
          query,
          ...options,
        });
      },
    };
  });

export function createAirweaveFragment(
  config: AirweaveConfig,
  fragnoConfig: FragnoPublicConfig = {},
) {
  return createFragment(airweaveFragmentDefinition, config, [airweaveRoutesFactory], fragnoConfig);
}

export function createAirweaveFragmentClients(fragnoConfig: FragnoPublicClientConfig) {
  const b = createClientBuilder(airweaveFragmentDefinition, fragnoConfig, [airweaveRoutesFactory]);

  return {
    useSearch: b.createMutator("POST", "/collections/:collectionId/search"),
    useStreamSearch: b.createMutator("POST", "/collections/:collectionId/search/stream"),
    useCollections: b.createHook("/collections"),
    useSources: b.createHook("/sources"),
    useSourceConnections: b.createHook("/source-connections"),
  };
}

export type { FragnoRouteConfig } from "@fragno-dev/core/api";

// Export streaming search functionality
export { type StreamSearchEvent } from "./schemas/search.streaming";
export type {
  ConnectedEvent,
  StartEvent,
  DoneEvent,
  CancelledEvent,
  ErrorEvent,
  HeartbeatEvent,
  SummaryEvent,
  OperatorStartEvent,
  OperatorEndEvent,
  InterpretationStartEvent,
  InterpretationReasonDeltaEvent,
  InterpretationDeltaEvent,
  InterpretationSkippedEvent,
  FilterAppliedEvent,
  FilterMergeEvent,
  ExpansionStartEvent,
  ExpansionReasonDeltaEvent,
  ExpansionDeltaEvent,
  ExpansionDoneEvent,
  RecencyStartEvent,
  RecencySpanEvent,
  RecencySkippedEvent,
  EmbeddingStartEvent,
  EmbeddingDoneEvent,
  EmbeddingFallbackEvent,
  VectorSearchStartEvent,
  VectorSearchBatchEvent,
  VectorSearchDoneEvent,
  VectorSearchNoResultsEvent,
  RerankingStartEvent,
  RerankingReasonDeltaEvent,
  RerankingDeltaEvent,
  RankingsEvent,
  RerankingDoneEvent,
  AnswerContextBudgetEvent,
  CompletionDoneEvent,
  ResultsEvent,
} from "./schemas/search.streaming";

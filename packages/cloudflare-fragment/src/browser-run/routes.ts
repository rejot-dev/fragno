import { defineRoutes } from "@fragno-dev/core";

import { cloudflareFragmentDefinition } from "../definition";
import {
  browserRunCaptureInputSchema,
  browserRunCrawlActionInputSchema,
  browserRunCrawlActionResultSchema,
  browserRunExtractInputSchema,
  browserRunExtractResultSchema,
} from "./contracts";

const unreachableAction = (request: never): never => {
  throw new Error(`Unsupported Browser Run action: ${JSON.stringify(request)}`);
};

export const browserRunRoutesFactory = defineRoutes(cloudflareFragmentDefinition).create(
  ({ services, defineRoute }) => [
    defineRoute({
      method: "POST",
      path: "/browser-run/extract",
      inputSchema: browserRunExtractInputSchema,
      outputSchema: browserRunExtractResultSchema,
      handler: async function ({ input }, { json }) {
        const request = await input.valid();

        switch (request.action) {
          case "content":
            return json({
              action: request.action,
              result: await services.browserRun.content(request.input),
            });
          case "scrape":
            return json({
              action: request.action,
              result: await services.browserRun.scrape(request.input),
            });
          case "snapshot":
            return json({
              action: request.action,
              result: await services.browserRun.snapshot(request.input),
            });
          case "json":
            return json({
              action: request.action,
              result: await services.browserRun.json(request.input),
            });
          case "links":
            return json({
              action: request.action,
              result: await services.browserRun.links(request.input),
            });
          case "markdown":
            return json({
              action: request.action,
              result: await services.browserRun.markdown(request.input),
            });
          case "accessibility-tree":
            return json({
              action: request.action,
              result: await services.browserRun.accessibilityTree(request.input),
            });
          default:
            return unreachableAction(request);
        }
      },
    }),
    defineRoute({
      method: "POST",
      path: "/browser-run/capture",
      inputSchema: browserRunCaptureInputSchema,
      handler: async function ({ input }) {
        const request = await input.valid();

        switch (request.action) {
          case "pdf":
            return services.browserRun.pdf(request.input);
          case "screenshot":
            return services.browserRun.screenshot(request.input);
          default:
            return unreachableAction(request);
        }
      },
    }),
    defineRoute({
      method: "POST",
      path: "/browser-run/crawl",
      inputSchema: browserRunCrawlActionInputSchema,
      outputSchema: browserRunCrawlActionResultSchema,
      handler: async function ({ input }, { json }) {
        const request = await input.valid();

        switch (request.action) {
          case "start":
            return json({
              action: request.action,
              result: {
                jobId: await services.browserRun.startCrawl(request.input),
              },
            });
          case "get":
            return json({
              action: request.action,
              result: await services.browserRun.getCrawl(request.jobId),
            });
          case "cancel":
            return json({
              action: request.action,
              result: await services.browserRun.cancelCrawl(request.jobId),
            });
          default:
            return unreachableAction(request);
        }
      },
    }),
  ],
);

import { defineRoutes } from "@fragno-dev/core";

import { cloudflareFragmentDefinition } from "../definition";
import {
  browserRunCaptureInputSchema,
  browserRunCrawlActionInputSchema,
  browserRunCrawlActionResultSchema,
  browserRunExtractInputSchema,
  browserRunExtractResultSchema,
} from "./contracts";
import { BROWSER_MS_USED_HEADER } from "./quick-actions";

const unreachableAction = (request: never): never => {
  throw new Error(`Unsupported Browser Run action: ${JSON.stringify(request)}`);
};

/** Passes on the browser time Cloudflare billed, so callers can attribute it. */
const browserTimeHeaders = (browserMsUsed: number) => ({
  [BROWSER_MS_USED_HEADER]: String(browserMsUsed),
});

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
          case "content": {
            const { result, browserMsUsed } = await services.browserRun.content(request.input);
            return json({ action: request.action, result }, 200, browserTimeHeaders(browserMsUsed));
          }
          case "scrape": {
            const { result, browserMsUsed } = await services.browserRun.scrape(request.input);
            return json({ action: request.action, result }, 200, browserTimeHeaders(browserMsUsed));
          }
          case "snapshot": {
            const { result, browserMsUsed } = await services.browserRun.snapshot(request.input);
            return json({ action: request.action, result }, 200, browserTimeHeaders(browserMsUsed));
          }
          case "json": {
            const { result, browserMsUsed } = await services.browserRun.json(request.input);
            return json({ action: request.action, result }, 200, browserTimeHeaders(browserMsUsed));
          }
          case "links": {
            const { result, browserMsUsed } = await services.browserRun.links(request.input);
            return json({ action: request.action, result }, 200, browserTimeHeaders(browserMsUsed));
          }
          case "markdown": {
            const { result, browserMsUsed } = await services.browserRun.markdown(request.input);
            return json({ action: request.action, result }, 200, browserTimeHeaders(browserMsUsed));
          }
          case "accessibility-tree": {
            const { result, browserMsUsed } = await services.browserRun.accessibilityTree(
              request.input,
            );
            return json({ action: request.action, result }, 200, browserTimeHeaders(browserMsUsed));
          }
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

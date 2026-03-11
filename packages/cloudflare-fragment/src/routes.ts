import { defineRoutes } from "@fragno-dev/core";
import { ExponentialBackoffRetryPolicy } from "@fragno-dev/db";
import {
  SUPPORTED_DEPLOYMENT_FORMAT,
  cloudflareAppListSchema,
  cloudflareAppStateSchema,
  cloudflareDeployRequestSchema,
  cloudflareDeploymentDetailSchema,
  cloudflareDeploymentListSchema,
  cloudflareDeploymentSummarySchema,
} from "./contracts";
import { cloudflareFragmentDefinition } from "./definition";

const writeRetryPolicy = new ExponentialBackoffRetryPolicy({
  maxRetries: 5,
  initialDelayMs: 10,
  maxDelayMs: 250,
});

export const cloudflareRoutesFactory = defineRoutes(cloudflareFragmentDefinition).create(
  ({ services, defineRoute }) => {
    return [
      defineRoute({
        method: "GET",
        path: "/apps",
        outputSchema: cloudflareAppListSchema,
        handler: async function (_input, { json }) {
          const [apps] = await this.handlerTx()
            .withServiceCalls(() => [services.listApps()])
            .execute();

          return json({ apps });
        },
      }),
      defineRoute({
        method: "POST",
        path: "/apps/:appId/deployments",
        inputSchema: cloudflareDeployRequestSchema,
        outputSchema: cloudflareDeploymentSummarySchema,
        errorCodes: ["INVALID_DEPLOY_INPUT", "UNSUPPORTED_DEPLOY_REQUEST"],
        handler: async function ({ input, pathParams }, { json, error }) {
          const payload = await input.valid();

          if (payload.script.type !== SUPPORTED_DEPLOYMENT_FORMAT) {
            return error(
              {
                message:
                  "Only single-module ES module deployments are supported in the first slice.",
                code: "UNSUPPORTED_DEPLOY_REQUEST",
              },
              400,
            );
          }

          if (payload.script.entrypoint.trim().length === 0) {
            return error(
              {
                message: "Deployment entrypoint cannot be empty.",
                code: "INVALID_DEPLOY_INPUT",
              },
              400,
            );
          }

          if (payload.script.content.trim().length === 0) {
            return error(
              {
                message: "Deployment source cannot be empty.",
                code: "INVALID_DEPLOY_INPUT",
              },
              400,
            );
          }

          const [deployment] = await this.handlerTx({ retryPolicy: writeRetryPolicy })
            .withServiceCalls(() => [services.queueDeployment(pathParams.appId, payload)])
            .execute();

          return json(deployment);
        },
      }),
      defineRoute({
        method: "GET",
        path: "/apps/:appId/deployments",
        outputSchema: cloudflareDeploymentListSchema,
        errorCodes: ["APP_NOT_FOUND"],
        handler: async function ({ pathParams }, { json, error }) {
          const [deployments] = await this.handlerTx()
            .withServiceCalls(() => [services.listAppDeployments(pathParams.appId)])
            .execute();

          if (!deployments) {
            return error(
              {
                message: `App '${pathParams.appId}' was not found.`,
                code: "APP_NOT_FOUND",
              },
              404,
            );
          }

          return json({ deployments });
        },
      }),
      defineRoute({
        method: "GET",
        path: "/deployments/:deploymentId",
        outputSchema: cloudflareDeploymentDetailSchema,
        errorCodes: ["DEPLOYMENT_NOT_FOUND"],
        handler: async function ({ pathParams }, { json, error }) {
          const [deployment] = await this.handlerTx()
            .withServiceCalls(() => [services.getDeployment(pathParams.deploymentId)])
            .execute();

          if (!deployment) {
            return error(
              {
                message: `Deployment '${pathParams.deploymentId}' was not found.`,
                code: "DEPLOYMENT_NOT_FOUND",
              },
              404,
            );
          }

          return json(deployment);
        },
      }),
      defineRoute({
        method: "GET",
        path: "/apps/:appId",
        outputSchema: cloudflareAppStateSchema,
        errorCodes: ["APP_NOT_FOUND"],
        handler: async function ({ pathParams }, { json, error }) {
          const [app, deployments] = await this.handlerTx()
            .withServiceCalls(
              () =>
                [
                  services.getAppState(pathParams.appId),
                  services.listAppDeployments(pathParams.appId),
                ] as const,
            )
            .execute();

          if (!app || !deployments) {
            return error(
              {
                message: `App '${pathParams.appId}' was not found.`,
                code: "APP_NOT_FOUND",
              },
              404,
            );
          }

          const liveDeployment = app.liveDeploymentId
            ? (deployments.find((deployment) => deployment.id === app.liveDeploymentId) ?? null)
            : null;

          return json({
            ...app,
            liveDeployment,
            liveDeploymentError: null,
            deployments,
          });
        },
      }),
    ];
  },
);
